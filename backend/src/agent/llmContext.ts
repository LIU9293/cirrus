import { AsyncLocalStorage } from 'node:async_hooks'
import OpenAI from 'openai'
import { config } from '../config.ts'
import { getConnection, getDefaultConnection, type ConnectionRow } from '../connections/store.ts'

// Bring-Your-Own-Model resolution. Server code never holds a single global LLM
// client for user work: each request runs inside an AsyncLocalStorage context
// carrying the acting user's resolved client+model. The platform default (the
// relay in config.ts) is the fallback when a user hasn't configured a model.

export interface LLMContext {
  client: OpenAI
  model: string
}

/** Resolved sandbox provider + key for the acting user (BYO sandbox). */
export interface SandboxCtx {
  provider: string
  key: string
}

interface RequestCtx {
  userId?: string
  llm?: LLMContext
  sandbox?: SandboxCtx | null
}

const als = new AsyncLocalStorage<RequestCtx>()

export function runWithLLM<T>(ctx: RequestCtx, fn: () => T): T {
  return als.run(ctx, fn)
}

// The platform-default client (shared, rate-limited fallback tier).
const defaultClient = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, timeout: 45_000, maxRetries: 1 })
export const platformLLM: LLMContext = { client: defaultClient, model: config.model }

/** The LLM the current request should use (user's resolved → platform default). */
export function currentLLM(): LLMContext {
  return als.getStore()?.llm ?? platformLLM
}

function buildLLM(conn: ConnectionRow | null): LLMContext | null {
  if (!conn || conn.kind !== 'model') return null
  const endpoint = String(conn.data.endpoint ?? '').trim()
  const model = String(conn.data.model ?? '').trim()
  if (!endpoint || !conn.secret) return null
  return { client: new OpenAI({ baseURL: endpoint, apiKey: conn.secret, timeout: 45_000, maxRetries: 1 }), model: model || config.model }
}

// Cache resolved per-user LLM briefly so we don't read the DB on every request.
const cache = new Map<string, { llm: LLMContext | null; expires: number }>()
export function invalidateUserLLM(userId: string) {
  cache.delete(userId)
}

/** Resolve a user's DEFAULT model connection (for studio/authoring calls). */
export async function resolveUserLLM(userId: string): Promise<LLMContext> {
  const hit = cache.get(userId)
  if (hit && hit.expires > Date.now()) return hit.llm ?? platformLLM
  const conn = await getDefaultConnection(userId, 'model')
  const llm = buildLLM(conn)
  cache.set(userId, { llm, expires: Date.now() + 30_000 })
  return llm ?? platformLLM
}

/** Resolve a specific model connection (for a runtime that selected one). */
export async function resolveConnectionLLM(connectionId: string | null | undefined): Promise<LLMContext | null> {
  if (!connectionId) return null
  return buildLLM(await getConnection(connectionId))
}

/** The sandbox provider+key the current request should use (BYO sandbox). */
export function currentSandbox(): SandboxCtx | null {
  return als.getStore()?.sandbox ?? null
}

/** Resolve a user's DEFAULT sandbox connection (provider + key). */
export async function resolveUserSandbox(userId: string): Promise<SandboxCtx | null> {
  const conn = await getDefaultConnection(userId, 'sandbox')
  if (!conn || conn.kind !== 'sandbox' || !conn.secret) return null
  return { provider: String(conn.data.provider ?? 'e2b'), key: conn.secret }
}
