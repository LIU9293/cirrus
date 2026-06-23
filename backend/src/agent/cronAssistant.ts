import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import { config } from '../config.ts'
import type { RuntimeRecord } from '../../../shared/protocol.ts'
import type { AgentEvent, ChatTurn } from './developerAgent.ts'
import { listCronJobs } from '../cronStore.ts'
import { makeCronTools } from './cronTools.ts'

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

  // Reuse the shared cron tools, wrapping each to stream tool activity into the chat.
  const tools = makeCronTools(Type, runtime.id).map((tool) => ({
    ...tool,
    execute: async (id: string, args: unknown) => {
      emit({ type: 'tool_call', name: tool.name, summary: tool.label ?? tool.name })
      const result = await tool.execute(id, args)
      const ok = (result as { details?: { ok?: boolean } })?.details?.ok !== false
      emit({ type: 'tool_result', name: tool.name, ok })
      return result
    },
  }))

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
