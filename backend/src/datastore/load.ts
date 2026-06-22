import { saveRecord } from '../store.ts'
import type { MiniappRecord } from '../../../shared/protocol.ts'
import { getDatastoreDriver, type Column, type ColumnType, type QuerySpec } from './index.ts'

// Loaders turn a source (pasted JSON, CSV, …) into rows, infer a schema, and write
// them into the instance's datastore as a named table. The skill then records WHICH
// table + schema it owns — not the data itself.

export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((v) => v !== '')) rows.push(row) }
  if (!rows.length) return []
  const header = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, coerce(r[i] ?? '')])))
}

function coerce(v: string): unknown {
  const t = v.trim()
  if (t === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true' || t === 'false') return t === 'true'
  return v
}

export function parseRows(format: string, text: string): Record<string, unknown>[] {
  if (format === 'csv') return parseCsv(text)
  // json (array of objects, or {rows:[...]} / {data:[...]})
  const parsed = JSON.parse(text)
  const arr = Array.isArray(parsed) ? parsed : parsed?.rows ?? parsed?.data ?? parsed?.items
  if (!Array.isArray(arr)) throw new Error('JSON must be an array of objects (or {rows:[...]}).')
  return arr
}

function typeOf(v: unknown): ColumnType {
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (v && typeof v === 'object') return 'json'
  return 'text'
}

export function inferColumns(rows: Record<string, unknown>[]): Column[] {
  const names: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k)
  return names.map((name) => {
    const sample = rows.find((r) => r[name] !== undefined && r[name] !== '')?.[name]
    return { name, type: sample === undefined ? 'text' : typeOf(sample) }
  })
}

/** Optional column rename: { targetField: sourceColumn }. */
function applyMapping(rows: Record<string, unknown>[], mapping?: Record<string, string>) {
  if (!mapping || !Object.keys(mapping).length) return rows
  return rows.map((r) => Object.fromEntries(Object.entries(mapping).map(([target, src]) => [target, r[src]])))
}

export interface LoadInput {
  skillId: string
  format: 'json' | 'csv'
  text: string
  table?: string
  mapping?: Record<string, string>
}

export interface LoadResult {
  ok: boolean
  table?: string
  columns?: Column[]
  rowCount?: number
  sample?: Record<string, unknown>[]
  message: string
}

export async function loadDataset(record: MiniappRecord, input: LoadInput): Promise<LoadResult> {
  const skill = (record.skills ?? []).find((s) => s.id === input.skillId)
  if (!skill) return { ok: false, message: `Unknown skill: ${input.skillId}` }

  let rows: Record<string, unknown>[]
  try {
    rows = applyMapping(parseRows(input.format, input.text), input.mapping)
  } catch (err) {
    return { ok: false, message: `Parse failed: ${String((err as Error)?.message ?? err)}` }
  }
  if (!rows.length) return { ok: false, message: 'No rows found in the input.' }

  const table = (input.table || skill.name || 'dataset').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40) || 'dataset'
  const columns = inferColumns(rows)
  const driver = getDatastoreDriver()
  await driver.ensureTable(record.id, table, columns)
  const count = await driver.replaceRows(record.id, table, rows)

  skill.source = 'library'
  skill.status = 'active'
  skill.config = {
    ...skill.config,
    datastore: driver.name,
    table,
    schema: columns,
    rowCount: count,
    source: input.format,
  }
  // Don't keep the bulk data on the skill — it lives in the datastore now.
  delete (skill.config as Record<string, unknown>).dataset
  saveRecord(record)

  return { ok: true, table, columns, rowCount: count, sample: rows.slice(0, 5), message: `Loaded ${count} rows into "${table}".` }
}

export async function queryDataset(record: MiniappRecord, spec: QuerySpec) {
  return getDatastoreDriver().query(record.id, spec)
}

export async function listTables(record: MiniappRecord) {
  return getDatastoreDriver().listTables(record.id)
}
