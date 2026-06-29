import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import { config } from '../config.ts'
import { getConnection, getDefaultConnection, type ConnectionRow } from '../connections/store.ts'

// Bring-Your-Own-Model/Sandbox resolution. Each request runs inside an
// AsyncLocalStorage context carrying the acting user's (or runtime's) resolved
// LLM client+model, the raw model spec (endpoint/key/model — for the pi-agent
// framework), and the sandbox provider+key. The platform defaults (config.ts)
// are the fallback tier.

export interface ModelSpec {
  endpoint: string
  key: string
  model: string
}
export interface LLMContext {
  client: OpenAI
  model: string
}
export interface SandboxCtx {
  provider: string
  key: string
}
export interface ResolvedCtx {
  llm: LLMContext
  modelSpec: ModelSpec
  sandbox: SandboxCtx | null
}

interface RequestCtx {
  userId?: string
  llm?: LLMContext
  modelSpec?: ModelSpec
  sandbox?: SandboxCtx | null
}

const als = new AsyncLocalStorage<RequestCtx>()

export function runWithLLM<T>(ctx: RequestCtx, fn: () => T): T {
  return als.run(ctx, fn)
}

const defaultClient = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, timeout: 45_000, maxRetries: 1 })
export const platformLLM: LLMContext = { client: defaultClient, model: config.model }
export const platformSpec: ModelSpec = { endpoint: config.baseURL, key: config.apiKey, model: config.model }

export function currentLLM(): LLMContext {
  return als.getStore()?.llm ?? platformLLM
}
/** Raw model endpoint/key/model — used by the pi-agent runtime framework. */
export function currentModelSpec(): ModelSpec {
  return als.getStore()?.modelSpec ?? platformSpec
}
export function currentSandbox(): SandboxCtx | null {
  return als.getStore()?.sandbox ?? null
}

function connToSpec(conn: ConnectionRow | null): ModelSpec | null {
  if (!conn || conn.kind !== 'model') return null
  const endpoint = String(conn.data.endpoint ?? '').trim()
  if (!endpoint || !conn.secret) return null
  return { endpoint, key: conn.secret, model: String(conn.data.model ?? '').trim() || config.model }
}
function specToLLM(spec: ModelSpec): LLMContext {
  if (spec === platformSpec) return platformLLM
  return { client: new OpenAI({ baseURL: spec.endpoint, apiKey: spec.key, timeout: 45_000, maxRetries: 1 }), model: spec.model }
}
function connToSandbox(conn: ConnectionRow | null): SandboxCtx | null {
  if (!conn || conn.kind !== 'sandbox' || !conn.secret) return null
  return { provider: String(conn.data.provider ?? 'e2b'), key: conn.secret }
}

// Cache resolved per-user context briefly to avoid a DB read on every request.
const cache = new Map<string, { ctx: ResolvedCtx; expires: number }>()
export function invalidateUserLLM(userId: string) {
  cache.delete(userId)
}

/** Resolve a user's DEFAULT model + sandbox (for studio/authoring requests). */
export async function resolveUserCtx(userId: string): Promise<ResolvedCtx> {
  const hit = cache.get(userId)
  if (hit && hit.expires > Date.now()) return hit.ctx
  const [mc, sc] = await Promise.all([getDefaultConnection(userId, 'model'), getDefaultConnection(userId, 'sandbox')])
  const spec = connToSpec(mc) ?? platformSpec
  const ctx: ResolvedCtx = { llm: specToLLM(spec), modelSpec: spec, sandbox: connToSandbox(sc) }
  cache.set(userId, { ctx, expires: Date.now() + 30_000 })
  return ctx
}

/** Resolve a runtime's SELECTED model + sandbox, falling back to the owner's
 *  default, then the platform default. Used to run a runtime turn under BYO. */
export async function resolveRuntimeCtx(opts: { ownerId?: string; modelConnectionId?: string | null; sandboxConnectionId?: string | null }): Promise<ResolvedCtx> {
  const [mc, sc] = await Promise.all([
    opts.modelConnectionId ? getConnection(opts.modelConnectionId) : Promise.resolve(null),
    opts.sandboxConnectionId ? getConnection(opts.sandboxConnectionId) : Promise.resolve(null),
  ])
  let spec = connToSpec(mc)
  let sandbox = connToSandbox(sc)
  if ((!spec || !sandbox) && opts.ownerId) {
    const userCtx = await resolveUserCtx(opts.ownerId)
    spec = spec ?? userCtx.modelSpec
    sandbox = sandbox ?? userCtx.sandbox
  }
  const finalSpec = spec ?? platformSpec
  return { llm: specToLLM(finalSpec), modelSpec: finalSpec, sandbox: sandbox ?? null }
}
