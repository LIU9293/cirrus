import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'

// Per-instance managed datastore. Each miniapp instance gets an isolated storage
// area; the miniapp/agent never touches a raw connection — it goes through the
// backend, which runs scoped, structured queries (no free-form SQL from the model).
//
//   DATASTORE_DRIVER=local      (default) — one JSON file per table under the
//                                instance's data dir. Dev only; not for scale.
//   DATASTORE_DRIVER=postgres   — schema-per-instance ("app_<id>") in a managed
//                                Postgres (DATASTORE_URL / DATABASE_URL). Lazy `pg`.

export type ColumnType = 'text' | 'number' | 'boolean' | 'json'
export interface Column {
  name: string
  type: ColumnType
}
export interface QuerySpec {
  table: string
  where?: Record<string, unknown>
  limit?: number
  columns?: string[]
}
export interface TableInfo {
  table: string
  columns: Column[]
  rowCount: number
}
export interface DatastoreDriver {
  readonly name: string
  ensureTable(instanceId: string, table: string, columns: Column[]): Promise<void>
  /** Replace all rows (snapshot load). Returns row count. */
  replaceRows(instanceId: string, table: string, rows: Record<string, unknown>[]): Promise<number>
  /** Append rows. Returns inserted count. */
  insertRows(instanceId: string, table: string, rows: Record<string, unknown>[]): Promise<number>
  /** Update rows matching exact filters. Requires at least one filter. */
  updateRows(instanceId: string, table: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number>
  /** Delete rows matching exact filters. Requires at least one filter. */
  deleteRows(instanceId: string, table: string, where: Record<string, unknown>): Promise<number>
  /** Update rows by key fields, inserting missing rows. */
  upsertRows(instanceId: string, table: string, rows: Record<string, unknown>[], keys: string[]): Promise<{ inserted: number; updated: number }>
  query(instanceId: string, spec: QuerySpec): Promise<{ rows: Record<string, unknown>[]; total: number }>
  listTables(instanceId: string): Promise<TableInfo[]>
  drop(instanceId: string): Promise<void>
}

export const MAX_LIMIT = 1000
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_')

function typeOf(v: unknown): ColumnType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (v && typeof v === 'object') return 'json'
  return 'text'
}

export function inferColumns(rows: Record<string, unknown>[]): Column[] {
  const names: string[] = []
  for (const row of rows) for (const key of Object.keys(row)) if (!names.includes(key)) names.push(key)
  return names.map((name) => {
    const sample = rows.find((row) => row[name] !== undefined && row[name] !== null && row[name] !== '')?.[name]
    return { name, type: sample === undefined ? 'text' : typeOf(sample) }
  })
}

function mergeColumns(existing: Column[], incoming: Column[]): Column[] {
  const byName = new Map(existing.map((c) => [c.name, c]))
  for (const col of incoming) if (!byName.has(col.name)) byName.set(col.name, col)
  return [...byName.values()]
}

function applyQuery(rows: Record<string, unknown>[], spec: QuerySpec) {
  let out = rows
  if (spec.where && Object.keys(spec.where).length) {
    out = out.filter((r) => Object.entries(spec.where!).every(([k, v]) => r[k] === v))
  }
  const total = out.length
  out = out.slice(0, Math.min(spec.limit ?? 100, MAX_LIMIT))
  if (spec.columns?.length) {
    out = out.map((r) => Object.fromEntries(spec.columns!.map((c) => [c, r[c]])))
  }
  return { rows: out, total }
}

// ---- Local driver: JSON file per table under the instance dir ----
function dsDir(instanceId: string) {
  // instanceId is already path-safe (app-xxxx-xxxx). Local driver only — kept on
  // disk under data/datastore/<id> until the datastore moves to the pg driver.
  return join(config.dataDir, 'datastore', instanceId)
}
function tablePath(instanceId: string, table: string) {
  return join(dsDir(instanceId), `${safe(table)}.json`)
}
function readTable(instanceId: string, table: string): { columns: Column[]; rows: Record<string, unknown>[] } {
  const p = tablePath(instanceId, table)
  if (!existsSync(p)) return { columns: [], rows: [] }
  return JSON.parse(readFileSync(p, 'utf-8'))
}
function writeTable(instanceId: string, table: string, data: { columns: Column[]; rows: Record<string, unknown>[] }) {
  mkdirSync(dsDir(instanceId), { recursive: true })
  writeFileSync(tablePath(instanceId, table), JSON.stringify(data))
}

const LocalDriver: DatastoreDriver = {
  name: 'local',
  async ensureTable(instanceId, table, columns) {
    const existing = readTable(instanceId, table)
    writeTable(instanceId, table, { columns: mergeColumns(existing.columns, columns), rows: existing.rows })
  },
  async replaceRows(instanceId, table, rows) {
    const { columns } = readTable(instanceId, table)
    writeTable(instanceId, table, { columns, rows })
    return rows.length
  },
  async insertRows(instanceId, table, rows) {
    const t = readTable(instanceId, table)
    t.columns = mergeColumns(t.columns, inferColumns(rows))
    t.rows.push(...rows)
    writeTable(instanceId, table, t)
    return rows.length
  },
  async updateRows(instanceId, table, where, patch) {
    if (!Object.keys(where).length) throw new Error('updateRows requires a non-empty where filter.')
    const t = readTable(instanceId, table)
    let updated = 0
    t.rows = t.rows.map((row) => {
      if (!Object.entries(where).every(([key, value]) => row[key] === value)) return row
      updated += 1
      return { ...row, ...patch }
    })
    t.columns = mergeColumns(t.columns, inferColumns([patch]))
    writeTable(instanceId, table, t)
    return updated
  },
  async deleteRows(instanceId, table, where) {
    if (!Object.keys(where).length) throw new Error('deleteRows requires a non-empty where filter.')
    const t = readTable(instanceId, table)
    const before = t.rows.length
    t.rows = t.rows.filter((row) => !Object.entries(where).every(([key, value]) => row[key] === value))
    writeTable(instanceId, table, t)
    return before - t.rows.length
  },
  async upsertRows(instanceId, table, rows, keys) {
    if (!rows.length) return { inserted: 0, updated: 0 }
    if (!keys.length) throw new Error('upsertRows requires at least one key field.')
    const t = readTable(instanceId, table)
    t.columns = mergeColumns(t.columns, inferColumns(rows))
    let inserted = 0
    let updated = 0
    for (const row of rows) {
      const idx = t.rows.findIndex((existing) => keys.every((key) => existing[key] === row[key]))
      if (idx >= 0) {
        t.rows[idx] = { ...t.rows[idx], ...row }
        updated += 1
      } else {
        t.rows.push(row)
        inserted += 1
      }
    }
    writeTable(instanceId, table, t)
    return { inserted, updated }
  },
  async query(instanceId, spec) {
    return applyQuery(readTable(instanceId, spec.table).rows, spec)
  },
  async listTables(instanceId) {
    const dir = dsDir(instanceId)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
        return { table: f.replace(/\.json$/, ''), columns: t.columns ?? [], rowCount: (t.rows ?? []).length }
      })
  },
  async drop(instanceId) {
    rmSync(dsDir(instanceId), { recursive: true, force: true })
  },
}

// ---- Postgres driver: schema-per-instance, backend-mediated, parameterized ----
const PG_TYPE: Record<ColumnType, string> = { text: 'text', number: 'double precision', boolean: 'boolean', json: 'jsonb' }

const PostgresDriver: DatastoreDriver = {
  name: 'postgres',
  ...(() => {
    let poolPromise: Promise<any> | null = null
    async function pool() {
      if (!poolPromise) {
        const url = process.env.DATASTORE_URL || process.env.DATABASE_URL
        if (!url) throw new Error('DATASTORE_URL is not set for the postgres datastore driver.')
        // @ts-ignore optional peer dependency — install `pg` to enable the postgres driver
        const pg = await import('pg')
        const p = new pg.default.Pool({ connectionString: url })
        poolPromise = Promise.resolve(p)
      }
      return poolPromise
    }
    const schema = (instanceId: string) => `app_${safe(instanceId)}`
    async function q(sql: string, params: unknown[] = []) {
      return (await pool()).query(sql, params)
    }
    return {
      async ensureTable(instanceId: string, table: string, columns: Column[]) {
        const s = schema(instanceId)
        const tableName = safe(table)
        await q(`CREATE SCHEMA IF NOT EXISTS "${s}"`)
        await q(`CREATE TABLE IF NOT EXISTS "${s}"."${tableName}" ("_terr_id" bigserial primary key)`)
        for (const col of columns) {
          const columnName = safe(col.name)
          await q(`ALTER TABLE "${s}"."${tableName}" ADD COLUMN IF NOT EXISTS "${columnName}" ${PG_TYPE[col.type]}`)
        }
      },
      async replaceRows(instanceId: string, table: string, rows: Record<string, unknown>[]) {
        const s = schema(instanceId)
        await q(`TRUNCATE "${s}"."${safe(table)}"`)
        return (this as DatastoreDriver).insertRows(instanceId, table, rows)
      },
      async insertRows(instanceId: string, table: string, rows: Record<string, unknown>[]) {
        if (!rows.length) return 0
        await this.ensureTable(instanceId, table, inferColumns(rows))
        const s = schema(instanceId)
        const originalKeys = Object.keys(rows[0])
        const keys = originalKeys.map(safe)
        for (const row of rows) {
          const vals = originalKeys.map((k) => row[k])
          const ph = keys.map((_, i) => `$${i + 1}`).join(', ')
          await q(`INSERT INTO "${s}"."${safe(table)}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${ph})`, vals)
        }
        return rows.length
      },
      async updateRows(instanceId: string, table: string, where: Record<string, unknown>, patch: Record<string, unknown>) {
        const whereKeys = Object.keys(where)
        const patchKeys = Object.keys(patch)
        if (!whereKeys.length) throw new Error('updateRows requires a non-empty where filter.')
        if (!patchKeys.length) return 0
        await this.ensureTable(instanceId, table, inferColumns([patch]))
        const s = schema(instanceId)
        const setSql = patchKeys.map((key, i) => `"${safe(key)}" = $${i + 1}`).join(', ')
        const whereSql = whereKeys.map((key, i) => `"${safe(key)}" = $${patchKeys.length + i + 1}`).join(' AND ')
        const params = [...patchKeys.map((key) => patch[key]), ...whereKeys.map((key) => where[key])]
        const res = await q(`UPDATE "${s}"."${safe(table)}" SET ${setSql} WHERE ${whereSql}`, params)
        return res.rowCount ?? 0
      },
      async deleteRows(instanceId: string, table: string, where: Record<string, unknown>) {
        const whereKeys = Object.keys(where)
        if (!whereKeys.length) throw new Error('deleteRows requires a non-empty where filter.')
        const s = schema(instanceId)
        const whereSql = whereKeys.map((key, i) => `"${safe(key)}" = $${i + 1}`).join(' AND ')
        const res = await q(`DELETE FROM "${s}"."${safe(table)}" WHERE ${whereSql}`, whereKeys.map((key) => where[key]))
        return res.rowCount ?? 0
      },
      async upsertRows(instanceId: string, table: string, rows: Record<string, unknown>[], keys: string[]) {
        if (!rows.length) return { inserted: 0, updated: 0 }
        if (!keys.length) throw new Error('upsertRows requires at least one key field.')
        await this.ensureTable(instanceId, table, inferColumns(rows))
        let inserted = 0
        let updated = 0
        for (const row of rows) {
          const where = Object.fromEntries(keys.map((key) => [key, row[key]]))
          const existing = await this.query(instanceId, { table, where, limit: 1 })
          if (existing.total > 0) {
            updated += await this.updateRows(instanceId, table, where, row)
          } else {
            inserted += await this.insertRows(instanceId, table, [row])
          }
        }
        return { inserted, updated }
      },
      async query(instanceId: string, spec: QuerySpec) {
        const s = schema(instanceId)
        const cols = spec.columns?.length ? spec.columns.map((c) => `"${safe(c)}"`).join(', ') : '*'
        const whereKeys = Object.keys(spec.where ?? {})
        const where = whereKeys.length ? 'WHERE ' + whereKeys.map((k, i) => `"${safe(k)}" = $${i + 1}`).join(' AND ') : ''
        const params = whereKeys.map((k) => spec.where![k])
        const limit = Math.min(spec.limit ?? 100, MAX_LIMIT)
        const res = await q(`SELECT ${cols} FROM "${s}"."${safe(spec.table)}" ${where} LIMIT ${limit}`, params)
        const totalRes = await q(`SELECT count(*)::int AS n FROM "${s}"."${safe(spec.table)}" ${where}`, params)
        return { rows: res.rows, total: totalRes.rows[0]?.n ?? res.rows.length }
      },
      async listTables(instanceId: string) {
        const s = schema(instanceId)
        const res = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [s])
        const out: TableInfo[] = []
        for (const r of res.rows) {
          const c = await q(`SELECT count(*)::int AS n FROM "${s}"."${safe(r.table_name)}"`)
          out.push({ table: r.table_name, columns: [], rowCount: c.rows[0]?.n ?? 0 })
        }
        return out
      },
      async drop(instanceId: string) {
        await q(`DROP SCHEMA IF EXISTS "${schema(instanceId)}" CASCADE`)
      },
    }
  })(),
}

export function getDatastoreDriver(): DatastoreDriver {
  return (process.env.DATASTORE_DRIVER ?? 'local') === 'postgres' ? PostgresDriver : LocalDriver
}
