import { query } from './db.ts'
import type { RuntimeAgentRef, RuntimeRecord } from '../../shared/protocol.ts'
import { normalizeRuntimeAgentRef } from './communityAgents.ts'

// Postgres-backed runtime store. The full RuntimeRecord lives in `runtimes.data`
// (jsonb) with `owner_id` as a column; per-agent secrets / model creds live in
// `runtime_files` (path-keyed), written via skills/settings + the model-config endpoint.

interface RuntimeRow {
  id: string
  owner_id: string
  data: RuntimeRecord
}

function newRuntimeId(): string {
  return 'rt-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

function rowToRuntime(r: RuntimeRow): RuntimeRecord {
  const data = (r.data ?? {}) as RuntimeRecord
  return {
    ...data,
    id: r.id,
    ownerId: r.owner_id,
    agents: (data.agents ?? []).map(normalizeRuntimeAgentRef),
    bots: data.bots ?? [],
    messages: data.messages ?? [],
  }
}

export async function createRuntime(ownerId: string, name: string, agents: RuntimeAgentRef[]): Promise<RuntimeRecord> {
  const now = new Date().toISOString()
  const record: RuntimeRecord = {
    id: newRuntimeId(),
    ownerId,
    name: name.trim() || 'Untitled runtime',
    agents: agents.map(normalizeRuntimeAgentRef),
    status: 'provisioning',
    sandboxId: null,
    sandboxKind: 'local',
    sandboxError: null,
    bots: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
  await saveRuntime(record)
  return record
}

export async function saveRuntime(record: RuntimeRecord): Promise<void> {
  record.updatedAt = new Date().toISOString()
  await query(
    `insert into runtimes (id, owner_id, data) values ($1, $2, $3)
     on conflict (id) do update set owner_id = excluded.owner_id, data = excluded.data, updated_at = now()`,
    [record.id, record.ownerId, JSON.stringify(record)],
  )
}

export async function loadRuntime(id: string): Promise<RuntimeRecord | null> {
  const { rows } = await query<RuntimeRow>('select * from runtimes where id = $1', [id])
  return rows[0] ? rowToRuntime(rows[0]) : null
}

export async function listRuntimes(ownerId: string): Promise<RuntimeRecord[]> {
  const { rows } = await query<RuntimeRow>('select * from runtimes where owner_id = $1 order by created_at desc', [ownerId])
  return rows.map(rowToRuntime)
}

/** All runtimes across every user — for cross-user jobs / CLI scripts. */
export async function listAllRuntimes(): Promise<RuntimeRecord[]> {
  const { rows } = await query<RuntimeRow>('select * from runtimes order by created_at desc')
  return rows.map(rowToRuntime)
}

export async function deleteRuntime(id: string): Promise<boolean> {
  const { rowCount } = await query('delete from runtimes where id = $1', [id]) // cascades runtime_files
  return rowCount > 0
}
