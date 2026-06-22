import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { config } from './config.ts'
import { findPlatformSkill } from './skills/library.ts'
import type { DeveloperChatMessage, MiniappManifest, MiniappRecord, MiniappSkill } from '../../shared/protocol.ts'

// File-backed store. Each miniapp lives under data/miniapps/<id>/:
//   record.json         -> MiniappRecord (manifest, status, state, built html path)
//   src/<files...>       -> agent-authored React source
//   dist.html            -> last successful single-file build
const miniappsRoot = resolve(config.dataDir, 'miniapps')

function appDir(id: string) {
  return join(miniappsRoot, id)
}
function srcDir(id: string) {
  return join(appDir(id), 'src')
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true })
}

export function newId(): string {
  return 'app-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

export function createMiniapp(): MiniappRecord {
  const id = newId()
  const record: MiniappRecord = {
    id,
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
  ensureDir(srcDir(id))
  saveRecord(record)
  return record
}

export function saveRecord(record: MiniappRecord) {
  ensureDir(appDir(record.id))
  record.updatedAt = new Date().toISOString()
  // Persist the html to a sidecar file (it can be large) and keep the path in JSON.
  const { html, ...rest } = record
  if (html != null) writeFileSync(join(appDir(record.id), 'dist.html'), html)
  writeFileSync(join(appDir(record.id), 'record.json'), JSON.stringify(rest, null, 2))
}

export function loadRecord(id: string): MiniappRecord | null {
  const file = join(appDir(id), 'record.json')
  if (!existsSync(file)) return null
  const rest = JSON.parse(readFileSync(file, 'utf-8')) as Omit<MiniappRecord, 'html'> & {
    messages?: DeveloperChatMessage[]
    liveMessages?: DeveloperChatMessage[]
    defineMessages?: DeveloperChatMessage[]
  }
  const htmlPath = join(appDir(id), 'dist.html')
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8') : null
  const skills = (rest.skills ?? []).map(hydrateBuiltinSkill)
  return {
    ...rest,
    messages: rest.messages ?? [],
    liveMessages: rest.liveMessages ?? [],
    defineMessages: rest.defineMessages ?? [],
    skills,
    draft: rest.draft ?? {},
    // Records created before the guided flow existed: infer where they'd be so
    // an already-built app opens straight into the studio, not back at Define.
    creationPhase: rest.creationPhase ?? (html ? 'done' : rest.manifest ? 'surface' : 'define'),
    html,
  }
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
  }
}

export function listRecords(): MiniappRecord[] {
  if (!existsSync(miniappsRoot)) return []
  return readdirSync(miniappsRoot)
    .map((id) => loadRecord(id))
    .filter((r): r is MiniappRecord => !!r)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function deleteMiniapp(id: string): boolean {
  const record = loadRecord(id)
  if (!record) return false
  rmSync(appDir(id), { recursive: true, force: true })
  return true
}

export interface SourceFile {
  path: string
  content: string
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/

function safeJoin(base: string, rel: string): string {
  if (!SAFE_PATH.test(rel) || rel.includes('..')) {
    throw new Error(`Unsafe source path: ${rel}`)
  }
  return join(base, rel)
}

export function writeSourceFiles(id: string, files: SourceFile[]) {
  for (const f of files) {
    const target = safeJoin(srcDir(id), f.path)
    ensureDir(dirname(target))
    writeFileSync(target, f.content)
  }
}

export function readSourceFiles(id: string): SourceFile[] {
  const base = srcDir(id)
  if (!existsSync(base)) return []
  const out: SourceFile[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (statSync(abs).isDirectory()) walk(abs, rel)
      else out.push({ path: rel, content: readFileSync(abs, 'utf-8') })
    }
  }
  walk(base, '')
  return out
}

export function clearSourceFiles(id: string) {
  const base = srcDir(id)
  if (existsSync(base)) rmSync(base, { recursive: true, force: true })
  ensureDir(base)
}

export function sourceDirFor(id: string) {
  return srcDir(id)
}

export function applyManifest(record: MiniappRecord, manifest: MiniappManifest): MiniappRecord {
  record.manifest = manifest
  // Seed/refresh the live state from the manifest's initial values (only fields
  // not already present, so a rebuild does not wipe user-entered state).
  const initial = manifest.stateModel?.initial ?? {}
  const seeded = { ...initial, ...record.state }
  record.state = seeded
  return record
}
