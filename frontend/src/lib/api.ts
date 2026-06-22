import type {
  BotPlatform,
  CreationPhase,
  DeveloperChatMessage,
  MiniappDraft,
  MiniappRecord,
  MiniappSkill,
  PlatformSkill,
  RuntimeAgentRef,
  RuntimeAgentModelConfig,
  RuntimeRecord,
  SkillDevelopMethod,
  SkillPlan,
} from '@shared/protocol'

export interface SkillPlanResult {
  plan: SkillPlan
  skills: MiniappSkill[]
  autoAdded: number
  needsDev: number
}

export interface SkillDevelopResult {
  ok: boolean
  skill?: MiniappSkill
  message: string
  test?: { stdout: string; stderr: string }
}

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean; detail?: string }
  | { type: 'assistant'; text: string }
  | { type: 'canvas_screenshot_request'; requestId: string }
  | { type: 'build'; ok: boolean; error?: string }
  | { type: 'record'; record: MiniappRecord }
  | { type: 'done'; durationMs?: number }
  | { type: 'error'; message: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface ActionOutcome {
  ok: boolean
  message: string
  state: Record<string, unknown>
  stateVersion: number
}

export interface LiveChatOutcome extends ActionOutcome {
  patched: boolean
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export async function listMiniapps(): Promise<(MiniappRecord & { hasHtml: boolean })[]> {
  const data = await json<{ miniapps: (MiniappRecord & { hasHtml: boolean })[] }>(await fetch('/api/miniapps'))
  return data.miniapps
}

export async function createMiniapp(): Promise<MiniappRecord> {
  const data = await json<{ miniapp: MiniappRecord }>(await fetch('/api/miniapps', { method: 'POST' }))
  return data.miniapp
}

export async function getMiniapp(id: string): Promise<MiniappRecord> {
  const data = await json<{ miniapp: MiniappRecord }>(await fetch(`/api/miniapps/${id}`))
  return data.miniapp
}

export async function deleteMiniapp(id: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/miniapps/${id}`, { method: 'DELETE' }))
}

export async function freezeMiniapp(id: string): Promise<MiniappRecord & { hasHtml: boolean }> {
  const data = await json<{ miniapp: MiniappRecord & { hasHtml: boolean } }>(
    await fetch(`/api/miniapps/${id}/freeze`, { method: 'POST' }),
  )
  return data.miniapp
}

export async function saveFlow(
  id: string,
  partial: { creationPhase?: CreationPhase; draft?: Partial<MiniappDraft>; skills?: MiniappSkill[]; defineMessages?: DeveloperChatMessage[] },
): Promise<void> {
  await json<{ miniapp: MiniappRecord & { hasHtml: boolean } }>(
    await fetch(`/api/miniapps/${id}/flow`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }),
  )
}

export interface DatasetLoadResult {
  ok: boolean
  table?: string
  columns?: { name: string; type: string }[]
  rowCount?: number
  sample?: Record<string, unknown>[]
  message: string
}

export interface DatastoreTableInfo {
  table: string
  columns: { name: string; type: string }[]
  rowCount: number
}

export async function loadDataset(
  id: string,
  input: { skillId: string; format: 'json' | 'csv'; text: string; table?: string },
): Promise<DatasetLoadResult> {
  return json<DatasetLoadResult>(
    await fetch(`/api/miniapps/${id}/datastore/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function listDatastoreTables(id: string): Promise<DatastoreTableInfo[]> {
  const data = await json<{ tables: DatastoreTableInfo[] }>(await fetch(`/api/miniapps/${id}/datastore/tables`))
  return data.tables
}

export async function queryDatastore(
  id: string,
  input: { table: string; where?: Record<string, unknown>; limit?: number; columns?: string[] },
): Promise<{ ok: boolean; rows?: Record<string, unknown>[]; total?: number; error?: string }> {
  return json(
    await fetch(`/api/miniapps/${id}/datastore/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export interface ClarifyResult {
  ready: boolean
  question?: string
  name?: string
  goal?: string
  miniapp?: MiniappRecord & { hasHtml?: boolean }
}

export async function clarifyConcept(id: string, history: ChatTurn[], context?: string): Promise<ClarifyResult> {
  return json<ClarifyResult>(
    await fetch(`/api/miniapps/${id}/define/clarify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history, context }),
    }),
  )
}

export interface AgentTree {
  soul: boolean
  tools: string[]
  skills: string[]
  data: string[]
  schedules: string[]
  channels: string[]
}
export async function getAgentTree(id: string): Promise<AgentTree> {
  const d = await json<{ tree: AgentTree }>(await fetch(`/api/miniapps/${id}/agent/tree`))
  return d.tree
}
export async function getAgentFile(id: string, path: string): Promise<string> {
  const d = await json<{ content: string }>(await fetch(`/api/miniapps/${id}/agent/file?path=${encodeURIComponent(path)}`))
  return d.content
}
export async function putAgentFile(id: string, path: string, content: string): Promise<void> {
  await json(
    await fetch(`/api/miniapps/${id}/agent/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  )
}
export async function refineAgentFile(
  id: string,
  path: string,
  instruction: string,
): Promise<{ ok: boolean; content?: string; message: string; test?: { stdout: string; stderr: string } }> {
  return json(
    await fetch(`/api/miniapps/${id}/agent/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, instruction }),
    }),
  )
}
export async function runTool(
  id: string,
  path: string,
  input: Record<string, unknown> = {},
): Promise<{ ok: boolean; stdout: string; stderr?: string; error?: string }> {
  return json(
    await fetch(`/api/miniapps/${id}/agent/run-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, input }),
    }),
  )
}

export async function saveSkillCredentials(
  id: string,
  skillId: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; skillId: string; credentialsFilled: string[]; values: Record<string, string> }> {
  return json(
    await fetch(`/api/miniapps/${id}/skills/${skillId}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  )
}

export async function testSkillTool(
  id: string,
  skillId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return json(
    await fetch(`/api/miniapps/${id}/skills/${skillId}/tools/${encodeURIComponent(toolName)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }),
  )
}

export async function chatAboutSkill(
  id: string,
  skillId: string,
  history: ChatTurn[],
): Promise<{ reply: string; skill?: MiniappSkill }> {
  return json<{ reply: string; skill?: MiniappSkill }>(
    await fetch(`/api/miniapps/${id}/skills/${skillId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    }),
  )
}

export async function chatAboutSurface(
  id: string,
  surfaceId: string,
  history: ChatTurn[],
): Promise<{ reply: string }> {
  return json<{ reply: string }>(
    await fetch(`/api/miniapps/${id}/surfaces/${encodeURIComponent(surfaceId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    }),
  )
}

export async function listSkillLibrary(): Promise<PlatformSkill[]> {
  const data = await json<{ skills: PlatformSkill[] }>(await fetch('/api/skills/library'))
  return data.skills
}

export async function planSkills(id: string): Promise<SkillPlanResult> {
  return json<SkillPlanResult>(await fetch(`/api/miniapps/${id}/skills/plan`, { method: 'POST' }))
}

export async function developSkill(
  id: string,
  skillId: string,
  method: SkillDevelopMethod,
  input: Record<string, unknown> = {},
): Promise<SkillDevelopResult> {
  return json<SkillDevelopResult>(
    await fetch(`/api/miniapps/${id}/skills/develop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId, method, input }),
    }),
  )
}

export async function saveMiniappMessages(id: string, messages: DeveloperChatMessage[]): Promise<void> {
  await json<{ miniapp: MiniappRecord & { hasHtml: boolean } }>(
    await fetch(`/api/miniapps/${id}/messages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }),
  )
}

export async function saveMiniappLiveMessages(id: string, messages: DeveloperChatMessage[]): Promise<void> {
  await json<{ miniapp: MiniappRecord & { hasHtml: boolean } }>(
    await fetch(`/api/miniapps/${id}/live-messages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }),
  )
}

export async function sendLiveChat(id: string, history: ChatTurn[]): Promise<LiveChatOutcome> {
  return json<LiveChatOutcome>(
    await fetch(`/api/miniapps/${id}/live-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    }),
  )
}

export async function postAction(id: string, actionId: string, payload: unknown, runtimeId?: string): Promise<ActionOutcome> {
  const path = runtimeId
    ? `/api/runtimes/${encodeURIComponent(runtimeId)}/miniapps/${encodeURIComponent(id)}/actions`
    : `/api/miniapps/${id}/actions`
  return json<ActionOutcome>(
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, payload }),
    }),
  )
}

export async function submitCanvasScreenshotResponse(
  id: string,
  requestId: string,
  result: { ok: boolean; imageUrl?: string; error?: string },
): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch(`/api/miniapps/${id}/canvas-screenshot-responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, ...result }),
    }),
  )
}

/** Streams developer-agent events over SSE. */
/* ───────── Runtimes ───────── */

export async function listRuntimes(): Promise<RuntimeRecord[]> {
  const data = await json<{ runtimes: RuntimeRecord[] }>(await fetch('/api/runtimes'))
  return data.runtimes
}

export async function getRuntime(id: string): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(await fetch(`/api/runtimes/${id}`))
  return data.runtime
}

export async function createRuntime(name: string, agents: RuntimeAgentRef[]): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch('/api/runtimes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, agents }),
    }),
  )
  return data.runtime
}

export async function deleteRuntime(id: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/runtimes/${id}`, { method: 'DELETE' }))
}

export async function updateRuntimeName(id: string, name: string): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return data.runtime
}

export async function sendRuntimeChat(
  id: string,
  history: ChatTurn[],
): Promise<{ ok: boolean; message: string; durationMs?: number; activities?: DeveloperChatMessage['activities'] }> {
  return json<{ ok: boolean; message: string; durationMs?: number; activities?: DeveloperChatMessage['activities'] }>(
    await fetch(`/api/runtimes/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    }),
  )
}

export async function* streamRuntimeChat(id: string, history: ChatTurn[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch(`/api/runtimes/${id}/chat?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ history }),
    signal,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  yield* streamEvents(res)
}

export async function addRuntimeAgent(id: string, agent: RuntimeAgentRef): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    }),
  )
  return data.runtime
}

export async function removeRuntimeAgent(id: string, key: string): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/agents/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  )
  return data.runtime
}

export async function updateRuntimeAgentModelConfig(
  id: string,
  key: string,
  modelConfig: RuntimeAgentModelConfig & { customApiKey?: string },
): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/agents/${encodeURIComponent(key)}/model-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelConfig }),
    }),
  )
  return data.runtime
}

export async function connectRuntimeBot(id: string, platform: BotPlatform, token?: string): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/bots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, token }),
    }),
  )
  return data.runtime
}

export async function disconnectRuntimeBot(id: string, botId: string): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/bots/${botId}`, { method: 'DELETE' }),
  )
  return data.runtime
}

export async function* streamChat(id: string, history: ChatTurn[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch(`/api/miniapps/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history }),
    signal,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  yield* streamEvents(res)
}

async function* streamEvents(res: Response): AsyncGenerator<AgentEvent> {
  if (!res.body) throw new Error('No response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as AgentEvent
      } catch {
        // skip malformed frame
      }
    }
  }
}
