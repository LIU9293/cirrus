import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from './config.ts'

// Per-user storage layout. Each user owns their agents and runtimes under their
// own directory; community agents are a public registry (no owner).
//
//   data/users/<userId>/miniapps/<id>/...     (agent folder, datastore live here)
//   data/users/<userId>/runtimes/<id>/...
//   data/index.json                           id -> ownerId (so id-only lookups resolve)
//
// Pre-auth data created in the old flat layout (data/miniapps/<id>,
// data/runtimes/<id>) is NOT moved — `*Dir(id)` falls back to it, and the
// bootstrap owner sees it in their listings. New data always goes per-user.

const indexFile = resolve(config.dataDir, 'index.json')
const legacyMiniapps = resolve(config.dataDir, 'miniapps')
const legacyRuntimes = resolve(config.dataDir, 'runtimes')

interface OwnerIndex {
  miniapps: Record<string, string>
  runtimes: Record<string, string>
}

let cache: OwnerIndex | null = null

function load(): OwnerIndex {
  if (cache) return cache
  try {
    cache = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf-8')) : { miniapps: {}, runtimes: {} }
  } catch {
    cache = { miniapps: {}, runtimes: {} }
  }
  cache!.miniapps ??= {}
  cache!.runtimes ??= {}
  return cache!
}

function persist() {
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(indexFile, JSON.stringify(load(), null, 2))
}

function userRoot(ownerId: string) {
  return resolve(config.dataDir, 'users', ownerId)
}

// ── Miniapps ──
export function ownerOfMiniapp(id: string): string | null {
  return load().miniapps[id] ?? null
}
export function registerMiniapp(id: string, ownerId: string) {
  load().miniapps[id] = ownerId
  persist()
}
export function unregisterMiniapp(id: string) {
  delete load().miniapps[id]
  persist()
}
/** Absolute dir for a miniapp: per-user when registered, else legacy flat path.
 *  Claimed legacy data is registered to an owner but kept in place, so we fall
 *  back to the legacy path when the per-user dir doesn't exist yet. */
export function miniappDir(id: string): string {
  const owner = ownerOfMiniapp(id)
  if (owner) {
    const perUser = join(userRoot(owner), 'miniapps', id)
    if (existsSync(perUser)) return perUser
    const legacy = join(legacyMiniapps, id)
    if (existsSync(legacy)) return legacy
    return perUser
  }
  return join(legacyMiniapps, id)
}
/** Dir for a brand-new miniapp owned by ownerId (also registers it). */
export function newMiniappDir(id: string, ownerId: string): string {
  registerMiniapp(id, ownerId)
  return join(userRoot(ownerId), 'miniapps', id)
}
export function listMiniappIds(ownerId: string, bootstrap = false): string[] {
  const idx = load().miniapps
  const owned = Object.keys(idx).filter((id) => idx[id] === ownerId)
  if (!bootstrap) return owned
  // The bootstrap owner also inherits legacy flat data not yet in the index.
  const legacy = existsSync(legacyMiniapps)
    ? readdirSync(legacyMiniapps).filter((id) => !id.startsWith('.') && !(id in idx))
    : []
  return [...owned, ...legacy]
}

// ── Runtimes ──
export function ownerOfRuntime(id: string): string | null {
  return load().runtimes[id] ?? null
}
export function registerRuntime(id: string, ownerId: string) {
  load().runtimes[id] = ownerId
  persist()
}
export function unregisterRuntime(id: string) {
  delete load().runtimes[id]
  persist()
}
export function runtimeDir(id: string): string {
  const owner = ownerOfRuntime(id)
  if (owner) {
    const perUser = join(userRoot(owner), 'runtimes', id)
    if (existsSync(perUser)) return perUser
    const legacy = join(legacyRuntimes, id)
    if (existsSync(legacy)) return legacy
    return perUser
  }
  return join(legacyRuntimes, id)
}
export function newRuntimeDir(id: string, ownerId: string): string {
  registerRuntime(id, ownerId)
  return join(userRoot(ownerId), 'runtimes', id)
}
export function listRuntimeIds(ownerId: string, bootstrap = false): string[] {
  const idx = load().runtimes
  const owned = Object.keys(idx).filter((id) => idx[id] === ownerId)
  if (!bootstrap) return owned
  const legacy = existsSync(legacyRuntimes)
    ? readdirSync(legacyRuntimes).filter((id) => !id.startsWith('.') && !(id in idx))
    : []
  return [...owned, ...legacy]
}

/** One-time claim: register any unowned legacy flat data to `ownerId` (no file
 *  move — `miniappDir`/`runtimeDir` fall back to the legacy location). */
export function claimLegacyData(ownerId: string): { miniapps: number; runtimes: number } {
  const idx = load()
  let m = 0
  let r = 0
  if (existsSync(legacyMiniapps)) {
    for (const id of readdirSync(legacyMiniapps)) {
      if (id.startsWith('.') || id in idx.miniapps) continue
      idx.miniapps[id] = ownerId
      m++
    }
  }
  if (existsSync(legacyRuntimes)) {
    for (const id of readdirSync(legacyRuntimes)) {
      if (id.startsWith('.') || id in idx.runtimes) continue
      idx.runtimes[id] = ownerId
      r++
    }
  }
  if (m || r) persist()
  return { miniapps: m, runtimes: r }
}

/** Every miniapp id across all users (+ unclaimed legacy). For cross-user jobs. */
export function allMiniappIds(): string[] {
  const ids = new Set(Object.keys(load().miniapps))
  if (existsSync(legacyMiniapps)) for (const id of readdirSync(legacyMiniapps)) if (!id.startsWith('.')) ids.add(id)
  return [...ids]
}
export function allRuntimeIds(): string[] {
  const ids = new Set(Object.keys(load().runtimes))
  if (existsSync(legacyRuntimes)) for (const id of readdirSync(legacyRuntimes)) if (!id.startsWith('.')) ids.add(id)
  return [...ids]
}

/** True when no user yet owns any data — used to auto-claim for the first user. */
export function hasNoOwners(): boolean {
  const idx = load()
  return Object.keys(idx.miniapps).length === 0 && Object.keys(idx.runtimes).length === 0
}
