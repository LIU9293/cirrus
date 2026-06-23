import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { config } from '../config.ts'
import { init } from '../db.ts'

// One-time: import the local-file datastore (data/datastore/<id>/<table>.json,
// shape { columns, rows }) into the Postgres datastore driver (schema-per-instance).
// Run with DATASTORE_DRIVER=postgres so getDatastoreDriver() returns the pg driver.

process.env.DATASTORE_DRIVER = 'postgres'

async function main() {
  await init()
  const { getDatastoreDriver } = await import('../datastore/index.ts')
  const driver = getDatastoreDriver()
  if (driver.name !== 'postgres') throw new Error(`expected postgres driver, got ${driver.name}`)

  const root = resolve(config.dataDir, 'datastore')
  if (!existsSync(root)) {
    console.log('no data/datastore dir — nothing to migrate')
    return
  }
  let tables = 0
  for (const id of readdirSync(root)) {
    if (id.startsWith('.')) continue
    const dir = join(root, id)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const table = file.replace(/\.json$/, '')
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as {
        columns?: { name: string; type: 'text' | 'number' | 'boolean' | 'json' }[]
        rows?: Record<string, unknown>[]
      }
      const columns = parsed.columns ?? []
      const rows = parsed.rows ?? []
      if (columns.length) await driver.ensureTable(id, table, columns)
      if (rows.length) await driver.replaceRows(id, table, rows)
      tables++
      console.log(`migrated datastore ${id}.${table} — ${rows.length} rows`)
    }
  }
  console.log(`done — ${tables} table(s) migrated`)
}

void main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
