import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import { config } from '../config.ts'
import type { ActionSpec, DeveloperChatActivity, MiniappRecord } from '../../../shared/protocol.ts'
import type { ChatTurn } from './developerAgent.ts'
import { makeRuntimeTools, describeSkills } from './skillTools.ts'
import { readSoul } from '../agentfs.ts'
import { saveRecord } from '../store.ts'
import { runInboxTriage } from '../apps/inboxTriage.ts'
import { runRuntimeAgentLoopInSandbox } from './sandboxAgent.ts'

/** Identifies which runtime×agent binding to resolve skill settings/credentials
 *  against. Absent for the dev/studio path (resolves the agent's own defaults). */
export interface RuntimeBinding {
  runtimeId?: string
  agentKey?: string
}

/** The agent's soul (what it does) — prepended to the runtime system prompt. */
async function soulBlock(record: MiniappRecord): Promise<string> {
  const soul = (await readSoul(record.id))?.trim()
  return soul ? `The agent's soul (what you are and what you do):\n${soul}\n` : ''
}

// The runtime agent answers a miniapp's kind:"agent" action and powers live chat.
// It is a full pi-agent tool loop whose tools are the app's ACTIVE skills plus
// patch_state — so the agent can reach datasets, generate text, run generated
// code in the sandbox, etc., and then mutate the shared state the UI renders from.

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

export interface RuntimeActionOutcome {
  ok: boolean
  message: string
  state: Record<string, unknown>
  stateVersion: number
}

export interface RuntimeChatOutcome extends RuntimeActionOutcome {
  patched: boolean
  activities?: DeveloperChatActivity[]
}

/** Run a pi-agent tool loop with the record's skill tools. Returns the final
 *  assistant text and whether the shared state was mutated. */
async function runAgent(
  record: MiniappRecord,
  system: string,
  history: ChatTurn[],
  binding?: RuntimeBinding,
): Promise<{ message: string; patched: boolean; activities: DeveloperChatActivity[] }> {
  const activities: DeveloperChatActivity[] = []
  const userTurn = history.at(-1)
  if (!userTurn || userTurn.role !== 'user') return { message: '', patched: false, activities }

  const [{ Agent }, { Type }] = await Promise.all([import('@earendil-works/pi-agent-core'), import('@earendil-works/pi-ai')])
  const model = makeModel()
  const before = record.stateVersion

  const tools = await makeRuntimeTools(Type, record, { record, ...binding }, {
    onActivity: (activity) => {
      if (activity.kind === 'call') activities.push({ kind: 'tool', text: activity.summary })
      else if (!activity.ok) activities.push({ kind: 'error', text: `${activity.name} failed${activity.detail ? `: ${activity.detail}` : ''}`, ok: false })
    },
  })
  const agent = new Agent({
    initialState: {
      systemPrompt: system,
      model,
      thinkingLevel: 'off',
      tools,
      messages: history.slice(0, -1).map((turn, index) => turnToMessage(turn, model, index)),
    },
    getApiKey: () => config.apiKey,
    toolExecution: 'sequential',
    sessionId: record.id,
    maxRetryDelayMs: 60000,
  })

  let finalText = ''
  agent.subscribe((event) => {
    if (event.type !== 'message_end') return
    if (event.message.role !== 'assistant') return
    const text = assistantText(event.message)
    if (text) finalText = text
  })

  try {
    await agent.prompt({ role: 'user', content: [{ type: 'text', text: userTurn.content }], timestamp: Date.now() })
  } catch (err) {
    return { message: `Agent failed: ${String((err as Error)?.message ?? err)}`, patched: record.stateVersion > before, activities }
  }
  return { message: finalText, patched: record.stateVersion > before, activities }
}

function sandboxIdFromPayload(payload: unknown): string {
  return payload && typeof payload === 'object' && 'sandboxId' in payload && typeof (payload as { sandboxId?: unknown }).sandboxId === 'string'
    ? (payload as { sandboxId: string }).sandboxId
    : ''
}

function runtimeEnvironmentBlock(sandboxId?: string | null): string {
  return sandboxId
    ? `Runtime environment: this agent reasoning loop is executing inside the runtime's isolated E2B sandbox (${sandboxId}). Host services only broker declared tools and persistence.`
    : 'Runtime environment: no E2B sandbox is attached, so this development fallback is executing locally.'
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

export async function runRuntimeAction(
  record: MiniappRecord,
  action: ActionSpec,
  payload: unknown,
  binding?: RuntimeBinding,
): Promise<RuntimeActionOutcome> {
  if (action.id === 'run_gmail_digest') {
    const sandboxId = sandboxIdFromPayload(payload)
    const result = await runInboxTriage(record, sandboxId ? { sandboxId, requireSandbox: true } : {})
    const operation = {
      at: new Date().toISOString(),
      status: result.ok ? 'completed' : 'failed',
      message: result.ok ? `Scanned ${result.total ?? 0} Gmail messages.` : result.error ?? 'Gmail digest failed.',
    }
    record.state = {
      ...record.state,
      status: result.ok ? 'ready' : 'error',
      lastScan: result.lastScan ?? new Date().toISOString(),
      total: result.total ?? record.state.total ?? 0,
      byCategory: result.byCategory ?? record.state.byCategory ?? {},
      heatmap: result.heatmap ?? record.state.heatmap ?? [],
      summary: result.summary ?? record.state.summary ?? '',
      error: result.ok ? '' : result.error ?? 'Gmail digest failed.',
      operations: [...(Array.isArray(record.state.operations) ? record.state.operations : []), operation].slice(-20),
    }
    record.stateVersion += 1
    saveRecord(record)
    return {
      ok: result.ok,
      message: operation.message,
      state: record.state,
      stateVersion: record.stateVersion,
    }
  }

  const sandboxId = sandboxIdFromPayload(payload)
  const manifest = record.manifest
  const soul = await soulBlock(record)
  const system = [
    `You are the runtime agent for the miniapp "${manifest?.name ?? record.id}".`,
    runtimeEnvironmentBlock(sandboxId),
    soul,
    'A UI control invoked an action. When the instruction names or implies one of your skills, CALL that',
    "skill's tool to do the work (don't do it inline) — that keeps the app's capabilities explicit. Then call",
    'patch_state to update the shared state the UI renders from. Keep state JSON-serializable and minimal.',
    '',
    `Action: ${action.id}`,
    `Instruction: ${action.agentInstruction ?? '(none)'}`,
    '',
    'Your skills (call them as tools when useful):',
    describeSkills(record),
    '',
    'State model fields:',
    JSON.stringify(manifest?.stateModel?.fields ?? [], null, 2),
  ].join('\n')

  const user = [
    'Current state:',
    JSON.stringify(record.state ?? {}, null, 2),
    '',
    'Action payload:',
    JSON.stringify(payload ?? {}, null, 2),
    '',
    'Apply the instruction. Call patch_state with the fields to update, then give a one-line confirmation.',
  ].join('\n')

  const { message, patched } = sandboxId
    ? await runRuntimeAgentLoopInSandbox(record, sandboxId, system, [{ role: 'user', content: user }], binding)
    : await runAgent(record, system, [{ role: 'user', content: user }], binding)
  return {
    ok: patched,
    message: message || (patched ? 'Updated.' : 'No change.'),
    state: record.state,
    stateVersion: record.stateVersion,
  }
}

export async function runRuntimeChat(
  record: MiniappRecord,
  history: ChatTurn[],
  opts: { sandboxId?: string | null; cirrusRuntimeContext?: string; binding?: RuntimeBinding } = {},
): Promise<RuntimeChatOutcome> {
  const manifest = record.manifest
  const soul = await soulBlock(record)
  const system = [
    `You are the live app agent for the miniapp "${manifest?.name ?? record.id}".`,
    runtimeEnvironmentBlock(opts.sandboxId),
    opts.cirrusRuntimeContext ? `CirrusRuntimeAgent context:\n${opts.cirrusRuntimeContext}` : '',
    soul,
    'You are talking to an end user using the app. Help them use it. When they ask you to change app data,',
    'call patch_state to shallow-merge JSON-serializable updates into the shared state.',
    'IMPORTANT: for anything about the app\'s OWN data/records (datasets, saved rows), you MUST call the relevant',
    'skill tool (e.g. query_dataset) to get real values — never answer data questions from your own knowledge.',
    'Do not discuss implementation details unless asked. Do not rewrite source code.',
    '',
    'Miniapp description:',
    manifest?.description ?? '(none)',
    '',
    'Your skills (call them as tools when useful):',
    describeSkills(record),
    '',
    'State model fields:',
    JSON.stringify(manifest?.stateModel?.fields ?? [], null, 2),
    '',
    'Current state:',
    JSON.stringify(record.state ?? {}, null, 2),
  ].join('\n')

  const { message, patched, activities } = opts.sandboxId
    ? await runRuntimeAgentLoopInSandbox(record, opts.sandboxId, system, history, opts.binding)
    : await runAgent(record, system, history, opts.binding)
  return {
    ok: true,
    patched,
    message: message || (patched ? 'Updated.' : 'I can help with this app.'),
    activities,
    state: record.state,
    stateVersion: record.stateVersion,
  }
}
