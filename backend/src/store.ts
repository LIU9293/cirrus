import { findPlatformSkill } from './skills/library.ts'
import { query } from './db.ts'
import type { MiniappManifest, MiniappRecord, MiniappSkill } from '../../shared/protocol.ts'

// Postgres-backed miniapp store. The record (manifest/state/skills/messages/…)
// lives in `miniapps.data` (jsonb) with `html` and `state_version` as columns;
// source files and the agent folder live in `miniapp_files` (path-keyed).

export function newId(): string {
  return 'app-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

interface MiniappRow {
  id: string
  owner_id: string
  data: Omit<MiniappRecord, 'html'>
  html: string | null
  state_version: number
}

function hydrateBuiltinSkill(skill: MiniappSkill): MiniappSkill {
  const platform = skill.platformSkillId ? findPlatformSkill(skill.platformSkillId) : undefined
  if (!platform || skill.source !== 'library') return skill
  if (skill.config?.contractEdited) return { ...skill, kind: skill.kind ?? 'builtin' }
  return {
    ...skill,
    kind: skill.kind ?? 'builtin',
    tools: platform.tools ?? skill.tools,
    credentials: platform.credentials ?? skill.credentials,
    config: { ...(platform.config ?? {}), ...(skill.config ?? {}) },
  }
}

function rowToRecord(r: MiniappRow): MiniappRecord {
  const data = (r.data ?? {}) as Omit<MiniappRecord, 'html'>
  const skills = (data.skills ?? []).map(hydrateBuiltinSkill)
  return {
    ...data,
    id: r.id,
    ownerId: r.owner_id,
    html: r.html ?? null,
    stateVersion: r.state_version ?? data.stateVersion ?? 0,
    skills,
    messages: data.messages ?? [],
    liveMessages: data.liveMessages ?? [],
    defineMessages: data.defineMessages ?? [],
    draft: data.draft ?? {},
    creationPhase: data.creationPhase ?? (r.html ? 'done' : data.manifest ? 'surface' : 'define'),
  }
}

export async function createMiniapp(ownerId: string): Promise<MiniappRecord> {
  const record: MiniappRecord = {
    id: newId(),
    ownerId,
    manifest: null,
    status: 'draft',
    html: null,
    state: {},
    stateVersion: 0,
    buildError: null,
    frozen: false,
    creationPhase: 'define',
    draft: {},
    skills: [],
    messages: [],
    liveMessages: [],
    defineMessages: [],
    updatedAt: new Date().toISOString(),
  }
  await saveRecord(record, { createIfMissing: true })
  return record
}

export async function saveRecord(record: MiniappRecord, options: { createIfMissing?: boolean } = {}): Promise<void> {
  record.updatedAt = new Date().toISOString()
  const { html, ...rest } = record
  if (!options.createIfMissing) {
    await query(
      `update miniapps
       set owner_id = $2, data = $3, html = $4, state_version = $5, updated_at = now()
       where id = $1`,
      [record.id, record.ownerId, JSON.stringify(rest), html ?? null, record.stateVersion ?? 0],
    )
    return
  }

  await query(
    `insert into miniapps (id, owner_id, data, html, state_version, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (id) do update set
       owner_id = excluded.owner_id, data = excluded.data,
       html = excluded.html, state_version = excluded.state_version, updated_at = now()`,
    [record.id, record.ownerId, JSON.stringify(rest), html ?? null, record.stateVersion ?? 0],
  )
}

export async function loadRecord(id: string): Promise<MiniappRecord | null> {
  const { rows } = await query<MiniappRow>('select * from miniapps where id = $1', [id])
  return rows[0] ? rowToRecord(rows[0]) : null
}

export async function listRecords(ownerId: string): Promise<MiniappRecord[]> {
  const { rows } = await query<MiniappRow>('select * from miniapps where owner_id = $1 order by updated_at desc', [ownerId])
  return rows.map(rowToRecord)
}

/** All miniapps across every user — for cross-user jobs (e.g. the scheduler). */
export async function listAllRecords(): Promise<MiniappRecord[]> {
  const { rows } = await query<MiniappRow>('select * from miniapps order by updated_at desc')
  return rows.map(rowToRecord)
}

/** Public ("published") miniapps across all users — for the community page. */
export async function listPublishedRecords(): Promise<MiniappRecord[]> {
  const { rows } = await query<MiniappRow>("select * from miniapps where data->>'visibility' = 'public' order by updated_at desc")
  return rows.map(rowToRecord)
}

export async function deleteMiniapp(id: string): Promise<boolean> {
  const { rowCount } = await query('delete from miniapps where id = $1', [id]) // cascades miniapp_files
  return rowCount > 0
}

export interface SourceFile {
  path: string
  content: string
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
function srcKey(rel: string): string {
  if (!SAFE_PATH.test(rel) || rel.includes('..')) throw new Error(`Unsafe source path: ${rel}`)
  return `src/${rel}`
}

export async function writeSourceFiles(id: string, files: SourceFile[]): Promise<void> {
  for (const f of files) {
    await query(
      `insert into miniapp_files (miniapp_id, path, content, updated_at) values ($1, $2, $3, now())
       on conflict (miniapp_id, path) do update set content = excluded.content, updated_at = now()`,
      [id, srcKey(f.path), f.content],
    )
  }
}

export async function readSourceFiles(id: string): Promise<SourceFile[]> {
  const { rows } = await query<{ path: string; content: string }>(
    `select path, content from miniapp_files where miniapp_id = $1 and path like 'src/%'`,
    [id],
  )
  return rows.map((r) => ({ path: r.path.slice('src/'.length), content: r.content }))
}

export async function clearSourceFiles(id: string): Promise<void> {
  await query(`delete from miniapp_files where miniapp_id = $1 and path like 'src/%'`, [id])
}

export function applyManifest(record: MiniappRecord, manifest: MiniappManifest): MiniappRecord {
  record.manifest = manifest
  // Seed/refresh the live state from the manifest's initial values (only fields
  // not already present, so a rebuild does not wipe user-entered state).
  const initial = manifest.stateModel?.initial ?? {}
  record.state = { ...initial, ...record.state }
  return record
}
