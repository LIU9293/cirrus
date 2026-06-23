import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from '../config.ts'
import { init, query } from '../db.ts'
import type { User } from '../../../shared/protocol.ts'

// One-time: import file-backed users (data/users/<id>/user.json) into Postgres.
// Idempotent — re-running upserts the same rows.

async function main() {
  await init()
  const usersRoot = resolve(config.dataDir, 'users')
  if (!existsSync(usersRoot)) {
    console.log('no data/users dir — nothing to migrate')
    return
  }
  let n = 0
  for (const id of readdirSync(usersRoot)) {
    if (id.startsWith('_') || id.startsWith('.')) continue
    const file = join(usersRoot, id, 'user.json')
    if (!existsSync(file)) continue
    const u = JSON.parse(readFileSync(file, 'utf-8')) as User
    await query(
      `insert into users (id, google_sub, email, name, picture, created_at, updated_at)
       values ($1,$2,$3,$4,$5, coalesce($6, now()), coalesce($7, now()))
       on conflict (id) do update set
         google_sub = excluded.google_sub, email = excluded.email,
         name = excluded.name, picture = excluded.picture, updated_at = now()`,
      [u.id, u.googleSub, u.email.toLowerCase(), u.name ?? null, u.picture ?? null, u.createdAt ?? null, u.updatedAt ?? null],
    )
    n++
    console.log(`migrated user ${u.email} (${u.id})`)
  }
  console.log(`done — ${n} user(s) migrated`)
}

void main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
