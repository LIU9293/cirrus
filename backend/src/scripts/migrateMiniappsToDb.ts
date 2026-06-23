import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from '../config.ts'
import { init, query } from '../db.ts'

// One-time: import file-backed miniapps into Postgres.
//   record.json -> miniapps.data (+ html column from dist.html, owner_id)
//   src/**, agent/** -> miniapp_files (path-keyed)
//   datastore/** -> copied to data/datastore/<id> (local driver's new home)
// Idempotent: re-running upserts rows.

const dataDir = config.dataDir

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as T) : null
  } catch {
    return null
  }
}

function walk(dir: string, prefix: string, out: { path: string; content: string }[]) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const abs = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(abs).isDirectory()) walk(abs, rel, out)
    else {
      try {
        out.push({ path: rel, content: readFileSync(abs, 'utf-8') })
      } catch {
        /* skip unreadable/binary */
      }
    }
  }
}

function copyDir(src: string, dst: string) {
  if (!existsSync(src)) return
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dst, entry)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

interface Candidate {
  id: string
  dir: string
  owner: string
}

function collect(): Candidate[] {
  const index = readJson<{ miniapps?: Record<string, string> }>(join(dataDir, 'index.json')) ?? {}
  const ownerOf = index.miniapps ?? {}
  const out: Candidate[] = []
  // Legacy flat layout.
  const flat = join(dataDir, 'miniapps')
  if (existsSync(flat)) {
    for (const id of readdirSync(flat)) {
      if (id.startsWith('.')) continue
      out.push({ id, dir: join(flat, id), owner: ownerOf[id] ?? '' })
    }
  }
  // Per-user layout.
  const usersRoot = join(dataDir, 'users')
  if (existsSync(usersRoot)) {
    for (const uid of readdirSync(usersRoot)) {
      if (uid.startsWith('_') || uid.startsWith('.')) continue
      const mini = join(usersRoot, uid, 'miniapps')
      if (!existsSync(mini)) continue
      for (const id of readdirSync(mini)) {
        if (id.startsWith('.')) continue
        out.push({ id, dir: join(mini, id), owner: uid })
      }
    }
  }
  return out
}

async function firstUserId(): Promise<string> {
  const { rows } = await query<{ id: string }>('select id from users order by created_at asc limit 1')
  return rows[0]?.id ?? ''
}

async function main() {
  await init()
  const fallbackOwner = await firstUserId()
  let n = 0
  for (const c of collect()) {
    const record = readJson<Record<string, unknown>>(join(c.dir, 'record.json'))
    if (!record) continue
    const owner = c.owner || fallbackOwner
    if (!owner) {
      console.warn(`skip ${c.id}: no owner resolvable`)
      continue
    }
    const html = existsSync(join(c.dir, 'dist.html')) ? readFileSync(join(c.dir, 'dist.html'), 'utf-8') : null
    record.ownerId = owner
    const stateVersion = Number(record.stateVersion ?? 0)

    await query(
      `insert into miniapps (id, owner_id, data, html, state_version)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set owner_id = excluded.owner_id, data = excluded.data,
         html = excluded.html, state_version = excluded.state_version, updated_at = now()`,
      [c.id, owner, JSON.stringify(record), html, stateVersion],
    )

    const files: { path: string; content: string }[] = []
    walk(join(c.dir, 'src'), 'src', files)
    walk(join(c.dir, 'agent'), 'agent', files)
    for (const f of files) {
      await query(
        `insert into miniapp_files (miniapp_id, path, content) values ($1, $2, $3)
         on conflict (miniapp_id, path) do update set content = excluded.content, updated_at = now()`,
        [c.id, f.path, f.content],
      )
    }

    // Relocate the local datastore to its new decoupled home.
    copyDir(join(c.dir, 'datastore'), join(dataDir, 'datastore', c.id))

    n++
    console.log(`migrated ${c.id} (owner ${owner}) — ${files.length} files${html ? ', html' : ''}`)
  }
  console.log(`done — ${n} miniapp(s) migrated`)
}

void main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
