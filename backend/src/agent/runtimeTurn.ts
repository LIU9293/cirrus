import type { ChatTurn } from './developerAgent.ts'
import type { DeveloperChatMessage, MiniappRecord, RuntimeAgentRef, RuntimeRecord } from '../../../shared/protocol.ts'
import type { RuntimeMessageUi } from './skillTools.ts'
import { loadRecord } from '../store.ts'
import { saveRuntime } from '../runtimeStore.ts'
import { installCommunityAgentInSandbox, normalizeRuntimeAgentRef } from '../communityAgents.ts'
import {
  decideCirrusRuntimeRouting,
  describeCirrusRuntimeAgentSpecsForRuntime,
  routeCirrusRuntimeMessage,
  runCirrusRuntimeChat,
  runCirrusRuntimeCommunityChat,
  runCirrusRuntimeCoordinatorChat,
  type CirrusRuntimeRoute,
} from './cirrusRuntimeAgent.ts'

type Activities = NonNullable<DeveloperChatMessage['activities']>

/** Lazily install any community agents into the runtime's E2B sandbox. Moved here
 *  so both the HTTP chat endpoint and the scheduler can reuse it. */
export async function installRuntimeCommunityAgents(runtime: RuntimeRecord): Promise<RuntimeRecord> {
  if (runtime.sandboxKind !== 'e2b' || !runtime.sandboxId) return runtime
  let changed = false
  const originalAgents = runtime.agents.map(normalizeRuntimeAgentRef)
  const agents: RuntimeAgentRef[] = []
  for (const agent of originalAgents) {
    if (agent.source !== 'community') {
      agents.push(agent)
      continue
    }
    if (agent.installation?.status === 'ready') {
      agents.push(agent)
      continue
    }
    changed = true
    const installing: RuntimeAgentRef = {
      ...agent,
      installation: {
        ...agent.installation,
        status: 'installing',
        logs: [`${new Date().toISOString()} install queued`, ...(agent.installation?.logs ?? [])].slice(0, 8),
      },
    }
    agents.push(installing)
    runtime.agents = agents.concat(originalAgents.slice(agents.length))
    await saveRuntime(runtime)
    const installed = await installCommunityAgentInSandbox(runtime.sandboxId, installing)
    agents[agents.length - 1] = installed
  }
  if (!changed) return runtime
  runtime.agents = agents
  await saveRuntime(runtime)
  return runtime
}

export interface RuntimeTurnResult {
  runtime: RuntimeRecord
  message: string
  activities: Activities
  durationMs: number
  /** ask_user buttons / send_image attachments the agent produced this turn. */
  ui?: RuntimeMessageUi
}

export interface RuntimeTurnOptions {
  /** Force routing to this agent (RuntimeAgentRef.key) instead of model routing. */
  targetAgentKey?: string | null
  /** Append the user turn + assistant reply to runtime.messages and save. */
  persist?: boolean
  /** Prefix stamped on the persisted user message id (e.g. 'cron'). */
  idPrefix?: string
}

/**
 * Run one runtime chat turn: route the conversation to the right agent, run the
 * pi-agent loop (in the E2B sandbox when present), and optionally persist the
 * exchange. Shared by the HTTP chat endpoint and the cron scheduler so both
 * behave identically.
 */
export async function executeRuntimeTurn(
  runtime: RuntimeRecord,
  history: ChatTurn[],
  opts: RuntimeTurnOptions = {},
): Promise<RuntimeTurnResult> {
  const startedAt = Date.now()

  if (
    runtime.sandboxKind === 'e2b' &&
    runtime.sandboxId &&
    runtime.agents.some((agent) => agent.source === 'community' && agent.installation?.status !== 'ready')
  ) {
    runtime = await installRuntimeCommunityAgents(runtime)
  }

  const ownRecordsByMiniappId = new Map<string, MiniappRecord>()
  for (const agent of runtime.agents) {
    if (agent.source !== 'own' || !agent.miniappId) continue
    const record = await loadRecord(agent.miniappId)
    if (record) ownRecordsByMiniappId.set(agent.miniappId, record)
  }

  const routing = decideCirrusRuntimeRouting(runtime.agents.length)
  const agentSpecs = describeCirrusRuntimeAgentSpecsForRuntime(runtime.agents, ownRecordsByMiniappId)

  // An explicit target (cron job addressed a specific agent) bypasses routing.
  const forced = opts.targetAgentKey ? runtime.agents.find((a) => a.key === opts.targetAgentKey) : null
  const route: CirrusRuntimeRoute = forced
    ? { target: 'agent', targetAgentKey: forced.key, targetAgentName: forced.name, reason: 'explicit target' }
    : routing.mode === 'direct'
      ? routeCirrusRuntimeMessage(history, agentSpecs.slice(0, 1))
      : routeCirrusRuntimeMessage(history, agentSpecs)

  const selectedAgent = route.targetAgentKey ? runtime.agents.find((agent) => agent.key === route.targetAgentKey) : null
  const selectedRecord = selectedAgent?.source === 'own' && selectedAgent.miniappId ? ownRecordsByMiniappId.get(selectedAgent.miniappId) : null
  const sandboxId = runtime.sandboxKind === 'e2b' ? runtime.sandboxId : null

  let message: string
  let activities: Activities = []
  let ui: RuntimeMessageUi | undefined
  if (selectedRecord) {
    const outcome = await runCirrusRuntimeChat(selectedRecord, history, {
      sandboxId,
      routing,
      agentSpecs,
      route,
      binding: { runtimeId: runtime.id, agentKey: selectedAgent!.key },
    })
    message = outcome.message
    activities = outcome.activities ?? []
    ui = outcome.ui
  } else if (selectedAgent?.source === 'community') {
    const outcome = await runCirrusRuntimeCommunityChat(selectedAgent, history, {
      sandboxId,
      routing,
      agentSpecs,
      route,
      platform: { runtimeId: runtime.id, ownerId: runtime.ownerId, agents: runtime.agents.map((a) => ({ key: a.key, name: a.name })) },
    })
    message = outcome.message
    activities = outcome.activities ?? []
    ui = outcome.ui
  } else if (runtime.agents.length > 0) {
    const outcome = await runCirrusRuntimeCoordinatorChat(history, { sandboxId, routing, agentSpecs, route })
    message = outcome.message
    activities = outcome.activities ?? []
  } else {
    const names = runtime.agents.map((a) => a.name).join(', ')
    message =
      runtime.status === 'provisioning'
        ? `The sandbox for ${names} is still starting up — try again in a moment.`
        : `This runtime hosts ${names}, but no E2B sandbox is available (running locally).`
  }

  const now = Date.now()
  const durationMs = now - startedAt

  if (opts.persist) {
    const userTurn = history.at(-1)
    const pre = opts.idPrefix ? `${opts.idPrefix}-` : ''
    if (userTurn?.role === 'user') {
      runtime.messages.push({ id: `${pre}m-` + now.toString(36), role: 'user', content: userTurn.content })
    }
    runtime.messages.push({
      id: `${pre}a-` + now.toString(36),
      role: 'assistant',
      content: message,
      durationMs,
      activities,
      ...(ui?.choices?.length ? { choices: ui.choices, allowFreeText: ui.allowFreeText } : {}),
      ...(ui?.images?.length ? { images: ui.images } : {}),
    })
    await saveRuntime(runtime)
  }

  return { runtime, message, activities, durationMs, ui }
}
