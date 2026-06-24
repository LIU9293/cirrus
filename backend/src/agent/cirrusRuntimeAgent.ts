import type { ActionSpec, DeveloperChatActivity, MiniappRecord, RuntimeAgentRef } from '../../../shared/protocol.ts'
import type { ChatTurn } from './developerAgent.ts'
import { runAgentInSandbox } from './sandboxAgent.ts'
import { invokeInstalledCommunityAgent, type CommunityPlatformContext } from '../communityAgents.ts'
import {
  runRuntimeAction,
  runRuntimeChat,
  type RuntimeActionOutcome,
  type RuntimeChatOutcome,
} from './runtimeAgent.ts'

export type CirrusRuntimeActionOutcome = RuntimeActionOutcome
export type CirrusRuntimeChatOutcome = RuntimeChatOutcome

export interface CirrusRuntimeAgentSpec {
  id: string
  key: string
  name: string
  source: 'own' | 'community'
  purpose?: string
  miniappId?: string
  skills?: Array<{
    name: string
    status: string
    tools: string[]
  }>
  actions?: string[]
}

export interface CirrusRuntimeRoutingDecision {
  mode: 'direct' | 'orchestrated'
  reason: string
  targetAgentId?: string
}

export interface CirrusRuntimeRoute {
  target: 'agent' | 'runtime'
  targetAgentKey?: string
  targetAgentName?: string
  reason: string
}

export function describeCirrusRuntimeAgentSpecs(records: MiniappRecord[]): CirrusRuntimeAgentSpec[] {
  return records.map((record) => ({
    id: record.id,
    key: `own:${record.id}`,
    name: record.manifest?.name ?? record.draft?.name ?? record.id,
    source: 'own',
    purpose: record.manifest?.description ?? record.draft?.goal ?? '',
    miniappId: record.id,
    skills: (record.skills ?? []).map((skill) => ({
      name: skill.name,
      status: skill.status,
      tools: (skill.tools ?? []).map((tool) => tool.name),
    })),
    actions: (record.manifest?.actions ?? []).map((action) => action.id),
  }))
}

function describeOwnAgentSpec(agent: RuntimeAgentRef, record: MiniappRecord): CirrusRuntimeAgentSpec {
  return {
    id: record.id,
    key: agent.key,
    name: agent.name || record.manifest?.name || record.draft?.name || record.id,
    source: 'own',
    purpose: record.manifest?.description ?? record.draft?.goal ?? '',
    miniappId: record.id,
    skills: (record.skills ?? []).map((skill) => ({
      name: skill.name,
      status: skill.status,
      tools: (skill.tools ?? []).map((tool) => tool.name),
    })),
    actions: (record.manifest?.actions ?? []).map((action) => action.id),
  }
}

function describeCommunityAgentSpec(agent: RuntimeAgentRef): CirrusRuntimeAgentSpec {
  return {
    id: agent.key,
    key: agent.key,
    name: agent.name,
    source: 'community',
    purpose: `${agent.name} community agent`,
    skills: [],
    actions: [],
  }
}

export function describeCirrusRuntimeAgentSpecsForRuntime(
  agents: RuntimeAgentRef[],
  recordsByMiniappId: Map<string, MiniappRecord>,
): CirrusRuntimeAgentSpec[] {
  return agents.map((agent) => {
    if (agent.source === 'own' && agent.miniappId) {
      const record = recordsByMiniappId.get(agent.miniappId)
      if (record) return describeOwnAgentSpec(agent, record)
    }
    return describeCommunityAgentSpec(agent)
  })
}

export function decideCirrusRuntimeRouting(agentCount: number): CirrusRuntimeRoutingDecision {
  if (agentCount <= 1) {
    return {
      mode: 'direct',
      reason: 'Runtime has one agent, so CirrusRuntimeAgent uses deterministic direct handoff without an LLM routing step.',
    }
  }
  return {
    mode: 'orchestrated',
    reason: 'Runtime has multiple agents, so CirrusRuntimeAgent should route or coordinate before handing off.',
  }
}

function lastUserMessage(history: ChatTurn[]): string {
  return [...history].reverse().find((turn) => turn.role === 'user')?.content ?? ''
}

function searchableSpecText(spec: CirrusRuntimeAgentSpec): string {
  return [
    spec.name,
    spec.source,
    spec.purpose,
    spec.miniappId,
    ...(spec.skills ?? []).flatMap((skill) => [skill.name, skill.status, ...skill.tools]),
    ...(spec.actions ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function tokens(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []
  return [...new Set(matches.filter((token) => !['this', 'that', 'with', 'from', 'into', '一下', '这个', '那个', '多少', '什么'].includes(token)))]
}

function routeScore(message: string, spec: CirrusRuntimeAgentSpec): number {
  const lower = message.toLowerCase()
  const text = searchableSpecText(spec)
  let score = 0
  const name = spec.name.toLowerCase()
  if (name && lower.includes(name)) score += 8
  if (spec.miniappId && lower.includes(spec.miniappId.toLowerCase())) score += 8
  for (const skill of spec.skills ?? []) {
    if (lower.includes(skill.name.toLowerCase())) score += 4
    for (const tool of skill.tools) if (lower.includes(tool.toLowerCase())) score += 4
  }
  for (const action of spec.actions ?? []) if (lower.includes(action.toLowerCase())) score += 4
  for (const token of tokens(message)) if (text.includes(token)) score += 1
  return score
}

function normalizeMention(value: string): string {
  return value
    .toLowerCase()
    .replace(/^community:/, '')
    .replace(/^own:/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function mentionedSpec(message: string, specs: CirrusRuntimeAgentSpec[]): CirrusRuntimeAgentSpec | null {
  const mentions = [...message.matchAll(/@([^\s@]+(?:\s+[^\s@]+){0,4})/g)].map((match) => match[1] ?? '')
  if (!mentions.length) return null
  const candidates = specs
    .flatMap((spec) => [
      { spec, value: spec.name },
      { spec, value: spec.key },
      { spec, value: spec.id },
    ])
    .map((item) => ({ ...item, normalized: normalizeMention(item.value) }))
    .filter((item) => item.normalized)
    .sort((a, b) => b.normalized.length - a.normalized.length)

  for (const mention of mentions) {
    const normalizedMention = normalizeMention(mention)
    const found = candidates.find((candidate) => normalizedMention.startsWith(candidate.normalized) || candidate.normalized.startsWith(normalizedMention))
    if (found) return found.spec
  }
  return null
}

export function routeCirrusRuntimeMessage(history: ChatTurn[], specs: CirrusRuntimeAgentSpec[]): CirrusRuntimeRoute {
  if (specs.length === 0) {
    return { target: 'runtime', reason: 'No agent specs are attached to this runtime.' }
  }
  if (specs.length === 1) {
    const spec = specs[0]
    return { target: 'agent', targetAgentKey: spec.key, targetAgentName: spec.name, reason: 'Single-agent runtime uses direct routing.' }
  }

  const message = lastUserMessage(history)
  const mentioned = mentionedSpec(message, specs)
  if (mentioned) {
    return {
      target: 'agent',
      targetAgentKey: mentioned.key,
      targetAgentName: mentioned.name,
      reason: `Shortcut mention matched @${mentioned.name}; CirrusRuntimeAgent skipped scoring and handed off directly.`,
    }
  }

  const scored = specs
    .map((spec) => ({ spec, score: routeScore(message, spec) }))
    .sort((a, b) => b.score - a.score)
  const [best, second] = scored
  if (!best || best.score <= 0) {
    return { target: 'runtime', reason: 'No agent specification matched the user request confidently.' }
  }
  if (second && second.score === best.score) {
    return { target: 'runtime', reason: `Multiple agents matched equally (${best.spec.name}, ${second.spec.name}); CirrusRuntimeAgent should clarify.` }
  }
  return {
    target: 'agent',
    targetAgentKey: best.spec.key,
    targetAgentName: best.spec.name,
    reason: `Matched request to ${best.spec.name} by agent name, skill, tool, action, or purpose keywords.`,
  }
}

function cirrusRuntimeContext(routing?: CirrusRuntimeRoutingDecision, specs?: CirrusRuntimeAgentSpec[]): string {
  return [
    routing ? `Routing mode: ${routing.mode}. ${routing.reason}` : '',
    specs?.length
      ? [
          'Visible agent specifications:',
          ...specs.map((spec) =>
            [
              `- ${spec.name} (${spec.source})`,
              spec.purpose ? `purpose=${spec.purpose}` : '',
              spec.skills?.length ? `skills=${spec.skills.map((skill) => `${skill.name}[${skill.tools.join(', ') || 'no tools'}]`).join('; ')}` : '',
              spec.actions?.length ? `actions=${spec.actions.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join(' '),
          ),
        ].join('\n')
      : '',
    'If there is exactly one target agent, hand off directly. If there are multiple agents, act as CirrusRuntimeAgent: route or coordinate first, then answer through the selected agent context.',
  ]
    .filter(Boolean)
    .join('\n')
}

function specsPrompt(specs: CirrusRuntimeAgentSpec[]): string {
  return specs
    .map((spec) =>
      [
        `- key=${spec.key}`,
        `name=${spec.name}`,
        `source=${spec.source}`,
        spec.purpose ? `purpose=${spec.purpose}` : '',
        spec.skills?.length ? `skills=${spec.skills.map((skill) => `${skill.name}[${skill.tools.join(', ') || 'no tools'}]`).join('; ')}` : '',
        spec.actions?.length ? `actions=${spec.actions.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join('\n')
}

export async function runCirrusRuntimeAction(
  record: MiniappRecord,
  action: ActionSpec,
  payload: unknown,
  binding?: { runtimeId?: string; agentKey?: string },
): Promise<CirrusRuntimeActionOutcome> {
  return runRuntimeAction(record, action, payload, binding)
}

export async function runCirrusRuntimeChat(
  record: MiniappRecord,
  history: ChatTurn[],
  opts: { sandboxId?: string | null; routing?: CirrusRuntimeRoutingDecision; agentSpecs?: CirrusRuntimeAgentSpec[]; route?: CirrusRuntimeRoute; binding?: { runtimeId?: string; agentKey?: string } } = {},
): Promise<CirrusRuntimeChatOutcome> {
  const activities: DeveloperChatActivity[] = []
  if (opts.routing) activities.push({ kind: 'status', text: `CirrusRuntimeAgent routing: ${opts.routing.mode}` })
  if (opts.agentSpecs?.length) activities.push({ kind: 'status', text: `CirrusRuntimeAgent sees ${opts.agentSpecs.length} agent spec${opts.agentSpecs.length === 1 ? '' : 's'}.` })
  if (opts.route) activities.push({ kind: 'status', text: opts.route.targetAgentName ? `CirrusRuntimeAgent selected: ${opts.route.targetAgentName}` : 'CirrusRuntimeAgent handling coordination' })
  const outcome = await runRuntimeChat(record, history, {
    sandboxId: opts.sandboxId,
    cirrusRuntimeContext: cirrusRuntimeContext(opts.routing, opts.agentSpecs),
    binding: opts.binding,
  })
  return { ...outcome, activities: [...activities, ...(outcome.activities ?? [])] }
}

export async function runCirrusRuntimeCoordinatorChat(
  history: ChatTurn[],
  opts: { sandboxId?: string | null; routing: CirrusRuntimeRoutingDecision; agentSpecs: CirrusRuntimeAgentSpec[]; route: CirrusRuntimeRoute },
): Promise<CirrusRuntimeChatOutcome> {
  const activities: DeveloperChatActivity[] = [
    { kind: 'status', text: `CirrusRuntimeAgent routing: ${opts.routing.mode}` },
    { kind: 'status', text: `CirrusRuntimeAgent sees ${opts.agentSpecs.length} agent spec${opts.agentSpecs.length === 1 ? '' : 's'}.` },
    { kind: 'status', text: `CirrusRuntimeAgent handling coordination: ${opts.route.reason}` },
  ]
  const system = [
    'You are CirrusRuntimeAgent, the runtime-level coordinator for a Cirrus runtime.',
    'You receive the user message before runtime agents when routing is ambiguous.',
    'Use the visible agent specifications to decide whether to ask a concise clarifying question or explain which agents can help.',
    'Do not claim to have executed a target agent tool. Do not invent private data.',
    'If the user request clearly names one of the agents but the deterministic router did not select it, tell the user which agent you would route to next.',
    '',
    `Routing mode: ${opts.routing.mode}. ${opts.routing.reason}`,
    `Current routing result: ${opts.route.reason}`,
    '',
    'Visible agent specifications:',
    specsPrompt(opts.agentSpecs),
  ].join('\n')

  if (!opts.sandboxId) {
    return {
      ok: true,
      patched: false,
      message: 'This runtime needs a live E2B sandbox before CirrusRuntimeAgent can coordinate this request.',
      activities,
      state: {},
      stateVersion: 0,
    }
  }
  const out = await runAgentInSandbox(opts.sandboxId, system, history)
  if (!out.ok) {
    const message = `CirrusRuntimeAgent coordination failed: ${out.error ?? 'unknown error'}`
    return { ok: false, patched: false, message, activities: [...activities, { kind: 'error', text: message, ok: false }], state: {}, stateVersion: 0 }
  }
  return {
    ok: true,
    patched: false,
    message: out.reply || 'Which agent should handle this?',
    activities: [
      ...activities,
      { kind: 'status', text: 'Running CirrusRuntimeAgent coordinator inside E2B sandbox' },
      ...(out.sandboxHost ? [{ kind: 'status' as const, text: `Sandbox host: ${out.sandboxHost}` }] : []),
    ],
    state: {},
    stateVersion: 0,
  }
}

export async function runCirrusRuntimeCommunityChat(
  agent: RuntimeAgentRef,
  history: ChatTurn[],
  opts: { sandboxId?: string | null; routing: CirrusRuntimeRoutingDecision; agentSpecs: CirrusRuntimeAgentSpec[]; route: CirrusRuntimeRoute; platform?: CommunityPlatformContext },
): Promise<CirrusRuntimeChatOutcome> {
  const activities: DeveloperChatActivity[] = [
    { kind: 'status', text: `CirrusRuntimeAgent routing: ${opts.routing.mode}` },
    { kind: 'status', text: `CirrusRuntimeAgent sees ${opts.agentSpecs.length} agent spec${opts.agentSpecs.length === 1 ? '' : 's'}.` },
    { kind: 'status', text: `CirrusRuntimeAgent selected: ${agent.name}` },
  ]
  if (!opts.sandboxId) {
    return {
      ok: true,
      patched: false,
      message: `This runtime hosts ${agent.name}, but no E2B sandbox is available yet.`,
      activities,
      state: {},
      stateVersion: 0,
    }
  }
  const out = await invokeInstalledCommunityAgent(opts.sandboxId, agent, history, opts.platform)
  if (!out.ok) return { ok: false, patched: false, message: out.message, activities: [...activities, ...out.activities], state: {}, stateVersion: 0 }
  return {
    ok: true,
    patched: false,
    message: out.message || '(no reply)',
    activities: [
      ...activities,
      ...out.activities,
    ],
    ui: out.ui,
    posts: out.posts,
    state: {},
    stateVersion: 0,
  }
}
