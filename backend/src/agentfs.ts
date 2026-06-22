import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { config } from './config.ts'
import type { MiniappRecord } from '../../shared/protocol.ts'

// Filesystem-first agent model (Eve-style). Each miniapp is an agent FOLDER.
// The fixed taxonomy (a miniapp IS an agent made of):
//
//   data/miniapps/<id>/agent/
//     soul.md             SOUL — what the agent does (seeded from Define, user-editable)
//     agent.json          model + wiring
//     skills/<name>.md     SKILLS — capabilities (data/tool/ai/connector), per terr_skill_contract.md
//     tools/<name>.ts      skill implementations (generated ones run in the sandbox)
//     data/                datasource configs (the managed datastore is the backend)
//     schedules/           TRIGGERS — cron / events
//     channels/            SURFACES — optional: miniapp (visual) / bot / api
//
// File location = identity; no separate registry. This module reads/writes that tree.

const SUBDIRS = ['tools', 'skills', 'data', 'schedules', 'channels'] as const
const SOUL_FILE = 'soul.md'
const LEGACY_SOUL_FILE = 'instructions.md'
const SAFE = /^[A-Za-z0-9._/-]+$/

function agentDir(id: string) {
  return join(resolve(config.dataDir, 'miniapps', id), 'agent')
}
function agentPath(id: string, rel: string) {
  if (!SAFE.test(rel) || rel.includes('..')) throw new Error(`Unsafe agent path: ${rel}`)
  return join(agentDir(id), rel)
}

export function readAgentFile(id: string, rel: string): string | null {
  const p = agentPath(id, rel)
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

export function writeAgentFile(id: string, rel: string, content: string): void {
  const p = agentPath(id, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

export function deleteAgentFile(id: string, rel: string): void {
  const p = agentPath(id, rel)
  if (existsSync(p)) rmSync(p, { force: true })
}

export interface AgentTree {
  soul: boolean
  tools: string[]
  skills: string[]
  data: string[]
  schedules: string[]
  channels: string[]
}

export function listAgentTree(id: string): AgentTree {
  const dir = agentDir(id)
  const ls = (sub: string) => {
    const d = join(dir, sub)
    return existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith('.')) : []
  }
  return {
    soul: existsSync(join(dir, SOUL_FILE)) || existsSync(join(dir, LEGACY_SOUL_FILE)),
    tools: ls('tools'),
    skills: ls('skills'),
    data: ls('data'),
    schedules: ls('schedules'),
    channels: ls('channels'),
  }
}

/** Read the agent's soul (falls back to the legacy instructions.md). */
export function readSoul(id: string): string | null {
  return readAgentFile(id, SOUL_FILE) ?? readAgentFile(id, LEGACY_SOUL_FILE)
}

/** Seed soul.md from the draft/manifest if it doesn't exist yet (migrating any
 *  legacy instructions.md into soul.md). */
export function ensureSoul(record: MiniappRecord): void {
  if (readAgentFile(record.id, SOUL_FILE) != null) return
  const legacy = readAgentFile(record.id, LEGACY_SOUL_FILE)
  if (legacy != null) {
    writeAgentFile(record.id, SOUL_FILE, legacy)
    return
  }
  const name = record.draft?.name ?? record.manifest?.name ?? 'Agent'
  const goal = record.draft?.goal ?? record.manifest?.description ?? ''
  writeAgentFile(record.id, SOUL_FILE, `# ${name}\n\n${goal}\n`)
}

export { SUBDIRS, SOUL_FILE }
