import { query } from '../db.ts'
import type { SkillRecord, SkillToolCall } from '../../../shared/protocol.ts'

// Postgres-backed store for STANDALONE, reusable skills (distinct from a skill
// instance attached to one miniapp). The contract lives in `skills.data` (jsonb);
// skill.md and tool scripts live in `skill_files` (path-keyed), mirroring how a
// miniapp's agent folder works.

export function newSkillId(): string {
  return 'skill-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

/** Make `desired` unique against `taken` by appending " (2)", " (3)", … */
export function dedupeName(desired: string, taken: string[]): string {
  const name = desired.trim() || 'Untitled'
  const set = new Set(taken.map((n) => n.trim()))
  if (!set.has(name)) return name
  let n = 2
  while (set.has(`${name} (${n})`)) n++
  return `${name} (${n})`
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
function safePath(rel: string): string {
  if (!SAFE_PATH.test(rel) || rel.includes('..')) throw new Error(`Unsafe skill path: ${rel}`)
  return rel
}

/** The skill-relative script file a tool implements, e.g. "tools/send_email.ts". */
export function toolScriptPath(tool: SkillToolCall): string | null {
  if (!tool.entry) return null
  const entry = tool.entry.trim()
  if (!entry) return null
  return entry.includes('/') ? entry : `tools/${entry}`
}

interface SkillRow {
  id: string
  owner_id: string
  data: Omit<SkillRecord, 'id' | 'ownerId'>
  visibility: string
}

function rowToRecord(r: SkillRow): SkillRecord {
  const data = (r.data ?? {}) as Omit<SkillRecord, 'id' | 'ownerId'>
  return {
    ...data,
    id: r.id,
    ownerId: r.owner_id,
    tools: data.tools ?? [],
    credentials: data.credentials ?? [],
    visibility: (r.visibility as SkillRecord['visibility']) ?? data.visibility ?? 'private',
    status: data.status ?? 'draft',
  }
}

export async function saveSkill(record: SkillRecord, options: { createIfMissing?: boolean } = {}): Promise<void> {
  record.updatedAt = new Date().toISOString()
  const { id, ownerId, ...rest } = record
  if (!options.createIfMissing) {
    await query(
      `update skills set owner_id = $2, data = $3, visibility = $4, updated_at = now() where id = $1`,
      [id, ownerId, JSON.stringify(rest), record.visibility],
    )
    return
  }
  await query(
    `insert into skills (id, owner_id, data, visibility, updated_at) values ($1, $2, $3, $4, now())
     on conflict (id) do update set owner_id = excluded.owner_id, data = excluded.data,
       visibility = excluded.visibility, updated_at = now()`,
    [id, ownerId, JSON.stringify(rest), record.visibility],
  )
}

export async function loadSkill(id: string): Promise<SkillRecord | null> {
  const { rows } = await query<SkillRow>('select * from skills where id = $1', [id])
  return rows[0] ? rowToRecord(rows[0]) : null
}

export async function listSkills(ownerId: string): Promise<SkillRecord[]> {
  const { rows } = await query<SkillRow>('select * from skills where owner_id = $1 order by updated_at desc', [ownerId])
  return rows.map(rowToRecord)
}

/** Public skills across all users — the community skills library. */
export async function listPublicSkills(): Promise<SkillRecord[]> {
  const { rows } = await query<SkillRow>("select * from skills where visibility = 'public' order by updated_at desc")
  return rows.map(rowToRecord)
}

export async function deleteSkill(id: string): Promise<boolean> {
  const { rowCount } = await query('delete from skills where id = $1', [id]) // cascades skill_files
  return rowCount > 0
}

/* ── Skill files (skill.md + tools/*.ts) ── */

export async function readSkillFile(id: string, rel: string): Promise<string | null> {
  const { rows } = await query<{ content: string }>(
    'select content from skill_files where skill_id = $1 and path = $2',
    [id, safePath(rel)],
  )
  return rows[0] ? rows[0].content : null
}

export async function writeSkillFile(id: string, rel: string, content: string): Promise<void> {
  await query(
    `insert into skill_files (skill_id, path, content, updated_at) values ($1, $2, $3, now())
     on conflict (skill_id, path) do update set content = excluded.content, updated_at = now()`,
    [id, safePath(rel), content],
  )
}

export async function deleteSkillFile(id: string, rel: string): Promise<void> {
  await query('delete from skill_files where skill_id = $1 and path = $2', [id, safePath(rel)])
}

export async function listSkillFilePaths(id: string): Promise<string[]> {
  const { rows } = await query<{ path: string }>('select path from skill_files where skill_id = $1 order by path', [id])
  return rows.map((r) => r.path)
}

/** Derive the lifecycle status from the contract + which tool scripts exist. */
export async function computeStatus(record: SkillRecord): Promise<SkillRecord['status']> {
  if (record.visibility === 'public') return 'shared'
  const scriptTools = record.tools.filter((t) => toolScriptPath(t))
  if (scriptTools.length) {
    const paths = new Set(await listSkillFilePaths(record.id))
    const allImplemented = scriptTools.every((t) => {
      const p = toolScriptPath(t)!
      return paths.has(p)
    })
    if (!allImplemented) return 'draft'
  }
  // README-only skills, or all script tools implemented → built. "configured" once
  // every required setting carries a default value (real secrets bind per-agent).
  const required = record.credentials.filter((c) => c.required !== false)
  const configured = required.length > 0 && required.every((c) => c.default != null && String(c.default).length > 0)
  return configured ? 'configured' : 'built'
}
