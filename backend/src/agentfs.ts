import { query } from './db.ts'
import type { MiniappRecord } from '../../shared/protocol.ts'

// Filesystem-first agent model, now backed by Postgres. The agent folder for a
// miniapp lives in `miniapp_files` under the `agent/` path prefix:
//
//   agent/agent.md            Agent README — what the agent is and does
//   agent/skills/<name>.md    SKILLS (per terr_skill_contract.md)
//   agent/tools/<name>.ts     skill implementations
//   agent/data/ schedules/ channels/ secrets/   data, triggers, surfaces, credentials
//
// Path = identity; reads/writes go through the miniapp_files table.

const SUBDIRS = ['tools', 'skills', 'data', 'schedules', 'channels'] as const
const AGENT_FILE = 'agent.md'
const LEGACY_SOUL_FILE = 'soul.md'
const LEGACY_INSTRUCTIONS_FILE = 'instructions.md'
const SAFE = /^[A-Za-z0-9._/-]+$/

function agentKey(rel: string): string {
  if (!SAFE.test(rel) || rel.includes('..')) throw new Error(`Unsafe agent path: ${rel}`)
  return `agent/${rel}`
}

export async function readAgentFile(id: string, rel: string): Promise<string | null> {
  const { rows } = await query<{ content: string }>(
    'select content from miniapp_files where miniapp_id = $1 and path = $2',
    [id, agentKey(rel)],
  )
  return rows[0] ? rows[0].content : null
}

export async function writeAgentFile(id: string, rel: string, content: string): Promise<void> {
  await query(
    `insert into miniapp_files (miniapp_id, path, content, updated_at) values ($1, $2, $3, now())
     on conflict (miniapp_id, path) do update set content = excluded.content, updated_at = now()`,
    [id, agentKey(rel), content],
  )
}

export async function deleteAgentFile(id: string, rel: string): Promise<void> {
  await query('delete from miniapp_files where miniapp_id = $1 and path = $2', [id, agentKey(rel)])
}

export interface AgentTree {
  agent: boolean
  /** @deprecated compatibility with older clients; use `agent`. */
  soul?: boolean
  tools: string[]
  skills: string[]
  data: string[]
  schedules: string[]
  channels: string[]
}

/** Immediate entries (file or dir names) under each agent subdir, mirroring the
 *  old readdir-based behavior over the flat path keys. */
export async function listAgentTree(id: string): Promise<AgentTree> {
  const { rows } = await query<{ path: string }>(
    `select path from miniapp_files where miniapp_id = $1 and path like 'agent/%'`,
    [id],
  )
  const paths = rows.map((r) => r.path.slice('agent/'.length))
  const childrenOf = (sub: string): string[] => {
    const out = new Set<string>()
    const prefix = `${sub}/`
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue
      const seg = p.slice(prefix.length).split('/')[0]
      if (seg) out.add(seg)
    }
    return [...out]
  }
  const hasAgentReadme = paths.includes(AGENT_FILE) || paths.includes(LEGACY_SOUL_FILE) || paths.includes(LEGACY_INSTRUCTIONS_FILE)
  return {
    agent: hasAgentReadme,
    soul: hasAgentReadme,
    tools: childrenOf('tools'),
    skills: childrenOf('skills'),
    data: childrenOf('data'),
    schedules: childrenOf('schedules'),
    channels: childrenOf('channels'),
  }
}

/** Read the agent README (falls back to legacy soul.md and instructions.md). */
export async function readAgentReadme(id: string): Promise<string | null> {
  return (
    (await readAgentFile(id, AGENT_FILE)) ??
    (await readAgentFile(id, LEGACY_SOUL_FILE)) ??
    (await readAgentFile(id, LEGACY_INSTRUCTIONS_FILE))
  )
}

/** Seed agent.md from the draft/manifest if it doesn't exist yet, migrating
 *  legacy soul.md or instructions.md into agent.md. */
export async function ensureAgentReadme(record: MiniappRecord): Promise<void> {
  if ((await readAgentFile(record.id, AGENT_FILE)) != null) return
  const legacy = (await readAgentFile(record.id, LEGACY_SOUL_FILE)) ?? (await readAgentFile(record.id, LEGACY_INSTRUCTIONS_FILE))
  if (legacy != null) {
    await writeAgentFile(record.id, AGENT_FILE, legacy)
    return
  }
  const name = record.draft?.name ?? record.manifest?.name ?? 'Agent'
  const goal = record.draft?.goal ?? record.manifest?.description ?? ''
  await writeAgentFile(record.id, AGENT_FILE, `# ${name}\n\n${goal}\n`)
}

export { SUBDIRS, AGENT_FILE }
