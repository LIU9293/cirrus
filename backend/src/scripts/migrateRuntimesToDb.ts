import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from '../config.ts'
import { init, query } from '../db.ts'

// One-time: import file-backed runtimes into Postgres.
//   record.json   -> runtimes.data (+ owner_id)
//   agents/**, secrets/**  -> runtime_files (path-keyed; per-agent + model creds)
// Idempotent.

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
        /* skip */
      }
    }
  }
}

interface Candidate {
  id: string
  dir: string
  owner: string
}

function collect(): Candidate[] {
  const index = readJson<{ runtimes?: Record<string, string> }>(join(dataDir, 'index.json')) ?? {}
  const ownerOf = index.runtimes ?? {}
  const out: Candidate[] = []
  const flat = join(dataDir, 'runtimes')
  if (existsSync(flat)) {
    for (const id of readdirSync(flat)) {
      if (id.startsWith('.')) continue
      out.push({ id, dir: join(flat, id), owner: ownerOf[id] ?? '' })
    }
  }
  const usersRoot = join(dataDir, 'users')
  if (existsSync(usersRoot)) {
    for (const uid of readdirSync(usersRoot)) {
      if (uid.startsWith('_') || uid.startsWith('.')) continue
      const rt = join(usersRoot, uid, 'runtimes')
      if (!existsSync(rt)) continue
      for (const id of readdirSync(rt)) {
        if (id.startsWith('.')) continue
        out.push({ id, dir: join(rt, id), owner: uid })
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
    record.ownerId = owner
    await query(
      `insert into runtimes (id, owner_id, data) values ($1, $2, $3)
       on conflict (id) do update set owner_id = excluded.owner_id, data = excluded.data, updated_at = now()`,
      [c.id, owner, JSON.stringify(record)],
    )

    const files: { path: string; content: string }[] = []
    walk(join(c.dir, 'agents'), 'agents', files)
    walk(join(c.dir, 'secrets'), 'secrets', files)
    for (const f of files) {
      await query(
        `insert into runtime_files (runtime_id, path, content) values ($1, $2, $3)
         on conflict (runtime_id, path) do update set content = excluded.content, updated_at = now()`,
        [c.id, f.path, f.content],
      )
    }
    n++
    console.log(`migrated runtime ${c.id} (owner ${owner}) — ${files.length} secret files`)
  }
  console.log(`done — ${n} runtime(s) migrated`)
}

void main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
