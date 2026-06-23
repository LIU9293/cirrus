import type { AgentEvent as PiAgentEvent, AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import { config } from '../config.ts'
import type { CronJob, RuntimeRecord } from '../../../shared/protocol.ts'
import type { AgentEvent, ChatTurn } from './developerAgent.ts'
import { createCronJob, deleteCronJob, listCronJobs, updateCronJob } from '../cronStore.ts'
import { isValidCron, nextCronRun } from '../cron.ts'

// A focused assistant that manages a runtime's scheduled tasks (cron jobs). It
// only has cron CRUD tools — it does not run agents itself. The user chats with
// it ("every weekday at 9am, ask the news agent for a digest") and it creates /
// edits / deletes jobs, which the minute scheduler then fires.

type Emit = (event: AgentEvent) => void

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function makeModel(): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: config.baseURL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4000,
    compat: {
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsUsageInStreaming: false,
    },
  }
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

function toolResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], details: payload }
}

function jobSummary(job: CronJob) {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    message: job.message,
    targetAgentKey: job.targetAgentKey ?? null,
    enabled: job.enabled,
    nextRunAt: job.nextRunAt ?? null,
    lastRunAt: job.lastRunAt ?? null,
  }
}

async function buildSystemPrompt(runtime: RuntimeRecord): Promise<string> {
  const jobs = await listCronJobs(runtime.id)
  const agentLines = runtime.agents.length
    ? runtime.agents.map((a) => `- key: "${a.key}" — ${a.name}`).join('\n')
    : '(this runtime has no agents yet)'
  const jobLines = jobs.length
    ? jobs.map((j) => `- id: "${j.id}" | ${j.enabled ? 'enabled' : 'disabled'} | "${j.schedule}" | target: ${j.targetAgentKey ?? '(auto-route)'} | ${j.name || '(unnamed)'} → ${JSON.stringify(j.message)}`).join('\n')
    : '(no cron jobs yet)'
  return [
    'You are the scheduling assistant for a Cirrus runtime. You help the user set up, edit, and remove',
    'CRON JOBS: scheduled tasks that send a message to one of the runtime\'s agents on a recurring schedule.',
    'When a job fires, its message is delivered to the agent exactly as if the user typed it into the runtime chat.',
    '',
    'Use your tools to make changes. Always call list_cron_jobs first if you are unsure of current ids.',
    'After making changes, briefly confirm what you did in plain language. Be concise.',
    '',
    'SCHEDULE FORMAT: a standard 5-field cron expression "minute hour day-of-month month day-of-week".',
    'Examples: "0 9 * * *" = every day at 09:00; "*/15 * * * *" = every 15 minutes;',
    '"0 9 * * 1-5" = 09:00 on weekdays; "0 0 1 * *" = midnight on the 1st of each month.',
    'Times are interpreted in the SERVER timezone (UTC on the cloud deployment). Minute resolution only.',
    '',
    'TARGET AGENT: set targetAgentKey to one of the runtime agent keys below so the message goes to that agent.',
    'If the user does not specify and there is exactly one agent, use it. If unsure, you may omit it to auto-route.',
    '',
    'Runtime agents:',
    agentLines,
    '',
    'Current cron jobs:',
    jobLines,
  ].join('\n')
}

export async function runCronAssistant(
  runtime: RuntimeRecord,
  history: ChatTurn[],
  emit: Emit,
): Promise<void> {
  const userTurn = history.at(-1)
  if (!userTurn || userTurn.role !== 'user') {
    emit({ type: 'error', message: 'Scheduling assistant needs a final user message.' })
    emit({ type: 'done' })
    return
  }

  const [{ Agent }, { Type }] = await Promise.all([import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-ai')])
  const model = makeModel()

  const validKeys = new Set(runtime.agents.map((a) => a.key))
  const coerceTarget = (v: unknown): string | null => {
    const key = typeof v === 'string' && v.trim() ? v.trim() : null
    if (key && !validKeys.has(key)) throw new Error(`Unknown agent key "${key}". Valid keys: ${[...validKeys].join(', ') || '(none)'}`)
    return key
  }

  const tools: AgentTool[] = [
    {
      name: 'list_cron_jobs',
      label: 'List cron jobs',
      description: 'List all cron jobs configured in this runtime, with their ids, schedules, targets, and enabled state.',
      parameters: Type.Object({}),
      execute: async () => {
        emit({ type: 'tool_call', name: 'list_cron_jobs', summary: 'Listing cron jobs' })
        const jobs = await listCronJobs(runtime.id)
        emit({ type: 'tool_result', name: 'list_cron_jobs', ok: true })
        return toolResult({ ok: true, jobs: jobs.map(jobSummary) })
      },
      executionMode: 'sequential',
    },
    {
      name: 'create_cron_job',
      label: 'Create cron job',
      description: 'Create a new scheduled task. Provide a short name, a 5-field cron schedule, the message to send to the agent, and optionally the target agent key.',
      parameters: Type.Object({
        name: Type.String(),
        schedule: Type.String(),
        message: Type.String(),
        targetAgentKey: Type.Optional(Type.String()),
      }),
      execute: async (_id, rawArgs) => {
        const args = rawArgs as any
        emit({ type: 'tool_call', name: 'create_cron_job', summary: `Creating "${args?.name ?? ''}" (${args?.schedule ?? ''})` })
        try {
          if (!isValidCron(String(args?.schedule ?? ''))) throw new Error(`Invalid cron schedule "${args?.schedule}"`)
          const job = await createCronJob({
            runtimeId: runtime.id,
            ownerId: runtime.ownerId,
            name: String(args?.name ?? ''),
            schedule: String(args?.schedule ?? ''),
            message: String(args?.message ?? ''),
            targetAgentKey: coerceTarget(args?.targetAgentKey),
          })
          emit({ type: 'tool_result', name: 'create_cron_job', ok: true })
          return toolResult({ ok: true, job: jobSummary(job) })
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          emit({ type: 'tool_result', name: 'create_cron_job', ok: false, detail: message })
          return toolResult({ ok: false, error: message })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'update_cron_job',
      label: 'Update cron job',
      description: 'Update an existing cron job by id. Only include the fields you want to change. Use enabled=false to pause a job.',
      parameters: Type.Object({
        id: Type.String(),
        name: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String()),
        message: Type.Optional(Type.String()),
        targetAgentKey: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, rawArgs) => {
        const args = rawArgs as any
        emit({ type: 'tool_call', name: 'update_cron_job', summary: `Updating ${args?.id ?? ''}` })
        try {
          if (args?.schedule !== undefined && !isValidCron(String(args.schedule))) throw new Error(`Invalid cron schedule "${args.schedule}"`)
          const job = await updateCronJob(String(args?.id ?? ''), {
            name: args?.name !== undefined ? String(args.name) : undefined,
            schedule: args?.schedule !== undefined ? String(args.schedule) : undefined,
            message: args?.message !== undefined ? String(args.message) : undefined,
            targetAgentKey: args?.targetAgentKey !== undefined ? coerceTarget(args.targetAgentKey) : undefined,
            enabled: args?.enabled !== undefined ? Boolean(args.enabled) : undefined,
          })
          if (!job) throw new Error(`No cron job with id "${args?.id}"`)
          emit({ type: 'tool_result', name: 'update_cron_job', ok: true })
          return toolResult({ ok: true, job: jobSummary(job) })
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          emit({ type: 'tool_result', name: 'update_cron_job', ok: false, detail: message })
          return toolResult({ ok: false, error: message })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'delete_cron_job',
      label: 'Delete cron job',
      description: 'Delete a cron job permanently by id.',
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, rawArgs) => {
        const args = rawArgs as any
        emit({ type: 'tool_call', name: 'delete_cron_job', summary: `Deleting ${args?.id ?? ''}` })
        const ok = await deleteCronJob(String(args?.id ?? ''))
        emit({ type: 'tool_result', name: 'delete_cron_job', ok })
        return toolResult(ok ? { ok: true } : { ok: false, error: `No cron job with id "${args?.id}"` })
      },
      executionMode: 'sequential',
    },
  ]

  const agent = new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(runtime),
      model,
      thinkingLevel: 'off',
      tools,
      messages: history.slice(0, -1).map((turn, index) => turnToMessage(turn, model, index)),
    },
    getApiKey: () => config.apiKey,
    toolExecution: 'sequential',
    sessionId: `cron-${runtime.id}`,
    maxRetryDelayMs: 60000,
  })

  agent.subscribe((event: PiAgentEvent) => {
    if (event.type !== 'message_end') return
    if (event.message.role !== 'assistant') return
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
      emit({ type: 'error', message: event.message.errorMessage ?? `Assistant stopped with ${event.message.stopReason}` })
      return
    }
    const text = assistantText(event.message)
    if (text) emit({ type: 'assistant', text })
  })

  try {
    await agent.prompt({ role: 'user', content: [{ type: 'text', text: userTurn.content }], timestamp: Date.now() })
  } catch (err) {
    emit({ type: 'error', message: `Scheduling assistant failed: ${String((err as Error)?.message ?? err)}` })
  }
  emit({ type: 'done' })
}

function turnToMessage(turn: ChatTurn, model: Model<'openai-completions'>, index: number) {
  const timestamp = Date.now() - Math.max(1, 1000 * (index + 1))
  if (turn.role === 'user') {
    return { role: 'user' as const, content: [{ type: 'text' as const, text: turn.content }], timestamp }
  }
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: turn.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop' as const,
    timestamp,
  }
}
