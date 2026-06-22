import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from './config.ts'
import type { RuntimeAgentRef, RuntimeRecord } from '../../shared/protocol.ts'
import { normalizeRuntimeAgentRef } from './communityAgents.ts'

// File-backed store. Each runtime lives under data/runtimes/<id>/record.json.
const runtimesRoot = resolve(config.dataDir, 'runtimes')

function rtDir(id: string) {
  return join(runtimesRoot, id)
}

function newRuntimeId(): string {
  return 'rt-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

export function createRuntime(name: string, agents: RuntimeAgentRef[]): RuntimeRecord {
  const now = new Date().toISOString()
  const record: RuntimeRecord = {
    id: newRuntimeId(),
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
  saveRuntime(record)
  return record
}

export function saveRuntime(record: RuntimeRecord) {
  mkdirSync(rtDir(record.id), { recursive: true })
  record.updatedAt = new Date().toISOString()
  writeFileSync(join(rtDir(record.id), 'record.json'), JSON.stringify(record, null, 2))
}

export function loadRuntime(id: string): RuntimeRecord | null {
  const file = join(rtDir(id), 'record.json')
  if (!existsSync(file)) return null
  const rec = JSON.parse(readFileSync(file, 'utf-8')) as RuntimeRecord
  return { ...rec, agents: (rec.agents ?? []).map(normalizeRuntimeAgentRef), bots: rec.bots ?? [], messages: rec.messages ?? [] }
}

export function listRuntimes(): RuntimeRecord[] {
  if (!existsSync(runtimesRoot)) return []
  return readdirSync(runtimesRoot)
    .map((id) => loadRuntime(id))
    .filter((r): r is RuntimeRecord => !!r)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function deleteRuntime(id: string): boolean {
  if (!existsSync(rtDir(id))) return false
  rmSync(rtDir(id), { recursive: true, force: true })
  return true
}
