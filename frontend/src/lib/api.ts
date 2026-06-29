import type {
  AuthUser,
  BotPlatform,
  ChatChoice,
  CreationPhase,
  CronJob,
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
  SkillRecord,
  SkillSetting,
  SkillTemplate,
  SkillToolCall,
  ConnectionKind,
  UserConnection,
  ModelConnection,
  SandboxConnection,
  BotConnection,
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
  | { type: 'message'; text: string }
  | { type: 'canvas_screenshot_request'; requestId: string }
  | { type: 'build'; ok: boolean; error?: string }
  | { type: 'record'; record: MiniappRecord }
  | { type: 'choices'; choices: ChatChoice[]; allowFreeText?: boolean }
  | { type: 'image'; url: string; alt?: string }
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

/* ───────── Auth ───────── */

export interface AuthInfo {
  user: AuthUser | null
  devAuth: boolean
  googleAuth: boolean
}

export const googleLoginUrl = '/api/auth/google/start'

export async function getAuth(): Promise<AuthInfo> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  const body = (await res.json().catch(() => ({}))) as Partial<AuthInfo>
  return { user: body.user ?? null, devAuth: !!body.devAuth, googleAuth: !!body.googleAuth }
}

export async function devLogin(email: string, name?: string): Promise<AuthUser> {
  const data = await json<{ user: AuthUser }>(
    await fetch('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, name }),
    }),
  )
  return data.user
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
}

/** How many runtimes use each community agent (keyed by "community:<Name>"). */
export async function getCommunityUsage(): Promise<Record<string, number>> {
  try {
    const data = await json<{ usage: Record<string, number> }>(await fetch('/api/community/usage', { credentials: 'include' }))
    return data.usage ?? {}
  } catch {
    return {}
  }
}

export async function listMiniapps(): Promise<(MiniappRecord & { hasHtml: boolean })[]> {
  const data = await json<{ miniapps: (MiniappRecord & { hasHtml: boolean })[] }>(await fetch('/api/miniapps'))
  return data.miniapps
}

/** Rename an agent and/or change its community visibility. */
export async function updateMiniappSettings(id: string, patch: { name?: string; visibility?: 'private' | 'public' }): Promise<void> {
  await json(await fetch(`/api/miniapps/${id}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }))
}

export interface PublishedAgent { id: string; name: string; description: string }

/** Public, user-built agents shown on the community page (after the hardcoded ones). */
export async function listPublishedAgents(): Promise<PublishedAgent[]> {
  try {
    const data = await json<{ agents: PublishedAgent[] }>(await fetch('/api/community/published', { credentials: 'include' }))
    return data.agents ?? []
  } catch {
    return []
  }
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
  input: {
    skillId: string
    format: 'json' | 'csv' | 'text'
    text?: string
    url?: string
    table?: string
    mode?: 'replace' | 'append'
    pattern?: string
    columns?: string[]
    constants?: Record<string, unknown>
    idColumn?: string
    idPrefix?: string
  },
): Promise<DatasetLoadResult> {
  return json<DatasetLoadResult>(
    await fetch(`/api/miniapps/${id}/datastore/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function agentImportDataset(
  id: string,
  input: {
    skillId: string
    text?: string
    url?: string
    table?: string
    mode?: 'replace' | 'append'
    instruction?: string
  },
): Promise<DatasetLoadResult & { importerCode?: string; notes?: string }> {
  return json<DatasetLoadResult & { importerCode?: string; notes?: string }>(
    await fetch(`/api/miniapps/${id}/datastore/agent-import`, {
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
  agent: boolean
  /** @deprecated Older servers returned `soul`; use `agent`. */
  soul?: boolean
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

/* ───────── Standalone, reusable skills ───────── */

export interface DraftSkillResult {
  name: string
  category: SkillRecord['category']
  description: string
  readme: string
  tools: SkillToolCall[]
  credentials: SkillSetting[]
  summary: string
  templateId?: string
}

export async function draftStandaloneSkill(description: string): Promise<DraftSkillResult> {
  return json<DraftSkillResult>(
    await fetch('/api/skills/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ description }),
    }),
  )
}

export async function listSkillTemplates(): Promise<SkillTemplate[]> {
  const data = await json<{ templates: SkillTemplate[] }>(await fetch('/api/skills/templates', { credentials: 'include' }))
  return data.templates
}

export async function listMySkills(): Promise<SkillRecord[]> {
  const data = await json<{ skills: SkillRecord[] }>(await fetch('/api/skills/mine', { credentials: 'include' }))
  return data.skills
}

export async function listCommunitySkills(): Promise<SkillRecord[]> {
  const data = await json<{ skills: SkillRecord[] }>(await fetch('/api/skills/community', { credentials: 'include' }))
  return data.skills
}

export async function getSkill(id: string): Promise<SkillRecord> {
  const data = await json<{ skill: SkillRecord }>(await fetch(`/api/skills/${id}`, { credentials: 'include' }))
  return data.skill
}

export type SkillInput = Partial<Pick<SkillRecord, 'name' | 'category' | 'description' | 'readme' | 'tools' | 'credentials' | 'visibility'>>

export async function createSkill(input: SkillInput): Promise<SkillRecord> {
  const data = await json<{ skill: SkillRecord }>(
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  )
  return data.skill
}

export async function updateSkill(id: string, input: SkillInput): Promise<SkillRecord> {
  const data = await json<{ skill: SkillRecord }>(
    await fetch(`/api/skills/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  )
  return data.skill
}

export async function deleteSkill(id: string): Promise<void> {
  await fetch(`/api/skills/${id}`, { method: 'DELETE', credentials: 'include' })
}

export async function listSkillFiles(id: string): Promise<string[]> {
  const data = await json<{ paths: string[] }>(await fetch(`/api/skills/${id}/files`, { credentials: 'include' }))
  return data.paths
}

export async function getSkillFile(id: string, path: string): Promise<string> {
  const data = await json<{ content: string }>(
    await fetch(`/api/skills/${id}/file?path=${encodeURIComponent(path)}`, { credentials: 'include' }),
  )
  return data.content
}

export async function putSkillFile(id: string, path: string, content: string): Promise<{ status: SkillRecord['status'] }> {
  return json<{ status: SkillRecord['status'] }>(
    await fetch(`/api/skills/${id}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path, content }),
    }),
  )
}

export async function generateSkillTool(id: string, toolName: string, notes = ''): Promise<{ ok: boolean; path: string; content: string; message: string }> {
  return json(
    await fetch(`/api/skills/${id}/tools/${encodeURIComponent(toolName)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ notes }),
    }),
  )
}

export async function refineSkillFile(id: string, path: string, instruction: string): Promise<{ ok: boolean; path: string; content: string; message: string }> {
  return json(
    await fetch(`/api/skills/${id}/file/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path, instruction }),
    }),
  )
}

export async function testSkillFile(id: string, path: string, input: Record<string, unknown> = {}): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  return json(
    await fetch(`/api/skills/${id}/file/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path, input }),
    }),
  )
}

export async function installSkillOnAgent(id: string, miniappId: string): Promise<{ ok: boolean; message: string }> {
  return json(
    await fetch(`/api/skills/${id}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ miniappId }),
    }),
  )
}

export async function planSkills(id: string): Promise<SkillPlanResult> {
  return json<SkillPlanResult>(await fetch(`/api/miniapps/${id}/skills/plan`, { method: 'POST' }))
}

export async function analyzeSkill(description: string): Promise<{ skill: MiniappSkill; summary: string }> {
  return json<{ skill: MiniappSkill; summary: string }>(
    await fetch('/api/skills/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    }),
  )
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

export async function submitRuntimeCanvasScreenshotResponse(
  runtimeId: string,
  requestId: string,
  result: { ok: boolean; imageUrl?: string; error?: string },
): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch(`/api/runtimes/${runtimeId}/canvas-screenshot-responses`, {
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

export async function updateRuntimeCompute(id: string, patch: { modelConnectionId?: string | null; sandboxConnectionId?: string | null }): Promise<RuntimeRecord> {
  const data = await json<{ runtime: RuntimeRecord }>(
    await fetch(`/api/runtimes/${id}/compute`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
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

// ── Public (no-auth) runtime chat: shareable use-only URL ──
export interface PublicRuntime {
  id: string
  name: string
  agents: { key: string; name: string; source: 'own' | 'community' }[]
}

export interface PublicRuntimeData {
  runtime: PublicRuntime
  /** The runtime's built miniapp, if any (so the public page can show it). */
  miniapp: MiniappRecord | null
}

export async function getPublicRuntime(id: string): Promise<PublicRuntimeData> {
  return json<PublicRuntimeData>(await fetch(`/api/public/runtimes/${id}`))
}

export async function postPublicAction(runtimeId: string, miniappId: string, actionId: string, payload: unknown): Promise<ActionOutcome> {
  return json<ActionOutcome>(
    await fetch(`/api/public/runtimes/${encodeURIComponent(runtimeId)}/miniapps/${encodeURIComponent(miniappId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, payload }),
    }),
  )
}

export async function* streamPublicRuntimeChat(id: string, history: ChatTurn[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch(`/api/public/runtimes/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ history }),
    signal,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  yield* streamEvents(res)
}

// ── Cron jobs ──
export async function listRuntimeCron(id: string): Promise<CronJob[]> {
  const data = await json<{ jobs: CronJob[] }>(await fetch(`/api/runtimes/${id}/cron`))
  return data.jobs
}

export interface CronJobInput {
  name?: string
  schedule: string
  message: string
  targetAgentKey?: string | null
  enabled?: boolean
}

export async function createRuntimeCron(id: string, input: CronJobInput): Promise<CronJob> {
  const data = await json<{ job: CronJob }>(
    await fetch(`/api/runtimes/${id}/cron`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
  return data.job
}

export async function updateRuntimeCron(id: string, jobId: string, patch: Partial<CronJobInput>): Promise<CronJob> {
  const data = await json<{ job: CronJob }>(
    await fetch(`/api/runtimes/${id}/cron/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
  return data.job
}

export async function deleteRuntimeCron(id: string, jobId: string): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`/api/runtimes/${id}/cron/${jobId}`, { method: 'DELETE' }))
}

export async function* streamRuntimeCronChat(id: string, history: ChatTurn[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  const res = await fetch(`/api/runtimes/${id}/cron/chat`, {
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

export interface RuntimeAgentSkillSetting {
  key: string
  label: string
  type: string
  options?: { label: string; value: string }[]
  required?: boolean
  secret: boolean
  placeholder?: string
  filled: boolean
  value?: string
}

export interface RuntimeAgentSkillSettings {
  id: string
  name: string
  category: string
  bindingKey: string
  settings: RuntimeAgentSkillSetting[]
}

/** The skills (with per-runtime settings status) an own-agent exposes in a runtime. */
export async function getRuntimeAgentSkills(id: string, key: string): Promise<RuntimeAgentSkillSettings[]> {
  const data = await json<{ skills: RuntimeAgentSkillSettings[] }>(
    await fetch(`/api/runtimes/${id}/agents/${encodeURIComponent(key)}/skills`),
  )
  return data.skills
}

/** Bind a skill's settings/credentials for one agent in this runtime. */
export async function saveRuntimeAgentSkillSettings(
  id: string,
  key: string,
  skillId: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; secretsFilled: string[]; values: Record<string, string> }> {
  return json(
    await fetch(`/api/runtimes/${id}/agents/${encodeURIComponent(key)}/skills/${skillId}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  )
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

/* ───────── User connections (Model / Sandbox / Bot) ───────── */

export async function listConnections<T extends UserConnection = UserConnection>(kind?: ConnectionKind): Promise<T[]> {
  const q = kind ? `?kind=${kind}` : ''
  const data = await json<{ connections: T[] }>(await fetch(`/api/connections${q}`, { credentials: 'include' }))
  return data.connections
}

export const listModelConnections = () => listConnections<ModelConnection>('model')
export const listSandboxConnections = () => listConnections<SandboxConnection>('sandbox')
export const listBotConnections = () => listConnections<BotConnection>('bot')

export async function createConnection(input: Record<string, unknown> & { kind: ConnectionKind }): Promise<UserConnection> {
  const data = await json<{ connection: UserConnection }>(
    await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  )
  return data.connection
}

export async function updateConnection(id: string, input: Record<string, unknown>): Promise<UserConnection> {
  const data = await json<{ connection: UserConnection }>(
    await fetch(`/api/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    }),
  )
  return data.connection
}

export async function deleteConnection(id: string): Promise<void> {
  await fetch(`/api/connections/${id}`, { method: 'DELETE', credentials: 'include' })
}

export async function setDefaultConnection(id: string): Promise<void> {
  await fetch(`/api/connections/${id}/default`, { method: 'POST', credentials: 'include' })
}
