import { query } from '../db.ts'
import type { ConnectionKind, UserConnection, ModelConnection, SandboxConnection, BotConnection } from '../../../shared/protocol.ts'

// User-level connection resources (model / sandbox / bot). Non-secret fields live
// in `data` (jsonb); the api key / token lives in `secret` and is NEVER returned
// to the client. A runtime composes these resources by referencing their ids.

export function newConnectionId(kind: ConnectionKind): string {
  const p = kind === 'model' ? 'mdl' : kind === 'sandbox' ? 'sbx' : 'bot'
  return `${p}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`
}

interface DbRow {
  id: string
  owner_id: string
  kind: ConnectionKind
  data: Record<string, unknown>
  secret: string | null
  created_at: string | Date
  updated_at: string | Date
}

export interface ConnectionRow {
  id: string
  ownerId: string
  kind: ConnectionKind
  data: Record<string, unknown>
  secret: string | null
  createdAt: string
  updatedAt: string
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString())

function toRow(r: DbRow): ConnectionRow {
  return { id: r.id, ownerId: r.owner_id, kind: r.kind, data: r.data ?? {}, secret: r.secret, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) }
}

/** Client-safe projection — drops the secret, exposes hasKey/hasToken. */
export function toPublic(r: ConnectionRow): UserConnection {
  const base = { id: r.id, name: String(r.data.name ?? ''), isDefault: !!r.data.isDefault, createdAt: r.createdAt, updatedAt: r.updatedAt }
  if (r.kind === 'model') {
    return { ...base, kind: 'model', endpoint: String(r.data.endpoint ?? ''), model: String(r.data.model ?? ''), hasKey: !!r.secret } as ModelConnection
  }
  if (r.kind === 'sandbox') {
    return { ...base, kind: 'sandbox', provider: ((r.data.provider as string) === 'daytona' ? 'daytona' : 'e2b'), hasKey: !!r.secret } as SandboxConnection
  }
  return { ...base, kind: 'bot', platform: (r.data.platform as BotConnection['platform']) ?? 'telegram', hasToken: !!r.secret, runtimeId: (r.data.runtimeId as string) ?? null } as BotConnection
}

export async function listConnections(ownerId: string, kind?: ConnectionKind): Promise<ConnectionRow[]> {
  const { rows } = kind
    ? await query<DbRow>('select * from user_connections where owner_id = $1 and kind = $2 order by created_at', [ownerId, kind])
    : await query<DbRow>('select * from user_connections where owner_id = $1 order by kind, created_at', [ownerId])
  return rows.map(toRow)
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  const { rows } = await query<DbRow>('select * from user_connections where id = $1', [id])
  return rows[0] ? toRow(rows[0]) : null
}

/** The owner's default connection of a kind (data.isDefault), else the most recent. */
export async function getDefaultConnection(ownerId: string, kind: ConnectionKind): Promise<ConnectionRow | null> {
  const all = await listConnections(ownerId, kind)
  if (!all.length) return null
  return all.find((c) => c.data.isDefault) ?? all[all.length - 1]
}

export async function createConnection(ownerId: string, kind: ConnectionKind, data: Record<string, unknown>, secret?: string): Promise<ConnectionRow> {
  const id = newConnectionId(kind)
  // First connection of a kind becomes the default automatically.
  const existing = await listConnections(ownerId, kind)
  const withDefault = { ...data, isDefault: data.isDefault ?? existing.length === 0 }
  await query(
    `insert into user_connections (id, owner_id, kind, data, secret, updated_at) values ($1, $2, $3, $4, $5, now())`,
    [id, ownerId, kind, JSON.stringify(withDefault), secret ?? null],
  )
  if (withDefault.isDefault) await setDefaultConnection(ownerId, kind, id)
  return (await getConnection(id))!
}

export async function updateConnection(id: string, patch: Record<string, unknown>, secret?: string): Promise<ConnectionRow | null> {
  const current = await getConnection(id)
  if (!current) return null
  const data = { ...current.data, ...patch }
  if (secret !== undefined && secret !== '') {
    await query('update user_connections set data = $2, secret = $3, updated_at = now() where id = $1', [id, JSON.stringify(data), secret])
  } else {
    await query('update user_connections set data = $2, updated_at = now() where id = $1', [id, JSON.stringify(data)])
  }
  if (data.isDefault) await setDefaultConnection(current.ownerId, current.kind, id)
  return getConnection(id)
}

export async function deleteConnection(id: string): Promise<void> {
  await query('delete from user_connections where id = $1', [id])
}

/** Make `id` the only default of its (owner, kind). */
export async function setDefaultConnection(ownerId: string, kind: ConnectionKind, id: string): Promise<void> {
  await query(`update user_connections set data = jsonb_set(data, '{isDefault}', 'false') where owner_id = $1 and kind = $2`, [ownerId, kind])
  await query(`update user_connections set data = jsonb_set(data, '{isDefault}', 'true'), updated_at = now() where id = $1 and owner_id = $2 and kind = $3`, [id, ownerId, kind])
}

/** Attach a bot connection to a runtime (1 bot ↔ 1 runtime). Pass null to detach. */
export async function setBotRuntime(botId: string, runtimeId: string | null): Promise<void> {
  await query(`update user_connections set data = jsonb_set(data, '{runtimeId}', $2::jsonb), updated_at = now() where id = $1 and kind = 'bot'`, [
    botId,
    JSON.stringify(runtimeId),
  ])
}

/** Bots currently attached to a runtime. */
export async function botsForRuntime(ownerId: string, runtimeId: string): Promise<ConnectionRow[]> {
  const bots = await listConnections(ownerId, 'bot')
  return bots.filter((b) => b.data.runtimeId === runtimeId)
}
