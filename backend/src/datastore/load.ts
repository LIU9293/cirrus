import { saveRecord } from '../store.ts'
import type { MiniappRecord } from '../../../shared/protocol.ts'
import { getDatastoreDriver, type Column, type ColumnType, type QuerySpec } from './index.ts'
import { openai, llmModel } from '../agent/client.ts'
import { config } from '../config.ts'
import { getSandboxDriver } from '../sandbox/index.ts'

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
  if (format === 'text') throw new Error('Text imports require a pattern and columns.')
  // json (array of objects, or {rows:[...]} / {data:[...]})
  const parsed = JSON.parse(text)
  const arr = Array.isArray(parsed) ? parsed : parsed?.rows ?? parsed?.data ?? parsed?.items
  if (!Array.isArray(arr)) throw new Error('JSON must be an array of objects (or {rows:[...]}).')
  return arr
}

function compactIdPart(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'row'
}

function parseTextPattern(
  text: string,
  input: Pick<LoadInput, 'pattern' | 'columns' | 'constants' | 'idColumn' | 'idPrefix'>,
): Record<string, unknown>[] {
  const columnNames = (input.columns ?? []).map((column) => column.trim()).filter(Boolean)
  if (!input.pattern?.trim()) throw new Error('Text format requires a regex pattern.')
  if (!columnNames.length) throw new Error('Text format requires at least one column name.')

  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, 'gm')
  } catch (err) {
    throw new Error(`Invalid text pattern: ${String((err as Error)?.message ?? err)}`)
  }

  const rows: Record<string, unknown>[] = []
  for (const match of text.matchAll(regex)) {
    const row: Record<string, unknown> = { ...(input.constants ?? {}) }
    for (let index = 0; index < columnNames.length; index += 1) {
      row[columnNames[index]] = (match[index + 1] ?? '').trim()
    }
    if (Object.values(row).some((value) => String(value ?? '').trim() !== '')) rows.push(row)
  }

  const idColumn = input.idColumn?.trim()
  if (idColumn) {
    const prefix = input.idPrefix?.trim() || (typeof input.constants?.source_vocab === 'string' ? input.constants.source_vocab : 'row')
    rows.forEach((row, index) => {
      if (row[idColumn] === undefined || row[idColumn] === '') {
        row[idColumn] = `${compactIdPart(prefix)}_${compactIdPart(row.word ?? row.name ?? row[columnNames[0]])}_${index + 1}`
      }
    })
  }

  return rows
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
  format: 'json' | 'csv' | 'text'
  text: string
  table?: string
  mapping?: Record<string, string>
  mode?: 'replace' | 'append'
  pattern?: string
  columns?: string[]
  constants?: Record<string, unknown>
  idColumn?: string
  idPrefix?: string
}

export interface LoadResult {
  ok: boolean
  table?: string
  columns?: Column[]
  rowCount?: number
  sample?: Record<string, unknown>[]
  message: string
}

export interface AgentImportInput {
  skillId: string
  text: string
  table?: string
  mode?: 'replace' | 'append'
  instruction?: string
  sourceUrl?: string
}

export interface AgentImportResult extends LoadResult {
  importerCode?: string
  notes?: string
}

export async function loadDataset(record: MiniappRecord, input: LoadInput): Promise<LoadResult> {
  const skill = (record.skills ?? []).find((s) => s.id === input.skillId)
  if (!skill) return { ok: false, message: `Unknown skill: ${input.skillId}` }

  let rows: Record<string, unknown>[]
  try {
    const parsed = input.format === 'text' ? parseTextPattern(input.text, input) : parseRows(input.format, input.text)
    rows = applyMapping(parsed, input.mapping)
  } catch (err) {
    return { ok: false, message: `Parse failed: ${String((err as Error)?.message ?? err)}` }
  }
  if (!rows.length) return { ok: false, message: 'No rows found in the input.' }

  const table = (input.table || skill.name || 'dataset').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 40) || 'dataset'
  const columns = inferColumns(rows)
  const driver = getDatastoreDriver()
  await driver.ensureTable(record.id, table, columns)
  const count = input.mode === 'append'
    ? await driver.insertRows(record.id, table, rows)
    : await driver.replaceRows(record.id, table, rows)
  const rowCount = (await driver.listTables(record.id)).find((info) => info.table === table)?.rowCount ?? count

  skill.source = 'library'
  skill.status = 'active'
  skill.config = {
    ...skill.config,
    datastore: driver.name,
    table,
    schema: columns,
    rowCount,
    source: input.format,
  }
  // Don't keep the bulk data on the skill — it lives in the datastore now.
  delete (skill.config as Record<string, unknown>).dataset
  saveRecord(record)

  return { ok: true, table, columns, rowCount, sample: rows.slice(0, 5), message: `${input.mode === 'append' ? 'Appended' : 'Loaded'} ${count} rows into "${table}".` }
}

function stripCodeFence(text: string) {
  return text.replace(/^```(?:js|javascript)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
}

function importSample(text: string) {
  if (text.length <= 12000) return text
  return `${text.slice(0, 9000)}\n\n... [middle omitted: ${text.length - 11000} chars] ...\n\n${text.slice(-2000)}`
}

async function generateImporterCode(input: AgentImportInput): Promise<string> {
  const system = [
    'You write a parser for a user-provided dataset import.',
    'Output ONLY the JavaScript body of a function with this signature: parse(text, context).',
    'The body must return { rows, notes }, where rows is an array of plain JSON objects.',
    'Use only portable JavaScript string/array/regex APIs. Do not import, require, fetch, read files, use process, eval, Function, or console.log.',
    'The generated parser will run against the FULL dataset text, not only the sample.',
    'Do not hardcode data rows from the sample. Constants from the user instruction/context are allowed.',
    'Normalize field names into practical columns. For vocabulary datasets prefer word, phonetic, definition, source_vocab when applicable.',
  ].join('\n')
  const user = [
    `Target table: ${input.table || '(agent should infer practical rows)'}`,
    `Import mode: ${input.mode ?? 'replace'}`,
    input.sourceUrl ? `Source URL: ${input.sourceUrl}` : '',
    input.instruction ? `Creator instruction:\n${input.instruction}` : 'Creator instruction: infer a useful row shape from the dataset.',
    '',
    'Dataset sample:',
    importSample(input.text),
  ].filter(Boolean).join('\n')
  const completion = await openai.chat.completions.create({
    model: llmModel(),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: 2200,
  })
  return stripCodeFence(completion.choices[0]?.message?.content ?? '')
}

function parseImporterOutput(stdout: string): { rows: Record<string, unknown>[]; notes?: string } {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('Importer script produced no output.')
  const parsed = JSON.parse(trimmed.split('\n').at(-1) ?? trimmed)
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows
  if (!Array.isArray(rows)) throw new Error('Importer script must return rows as an array.')
  const cleanRows = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown>[]
  if (!cleanRows.length) throw new Error('Importer script returned no usable rows.')
  return { rows: cleanRows, notes: typeof parsed?.notes === 'string' ? parsed.notes : undefined }
}

export async function agentImportDataset(record: MiniappRecord, input: AgentImportInput): Promise<AgentImportResult> {
  if (!input.text.trim()) return { ok: false, message: 'Dataset input is empty.' }
  const code = await generateImporterCode(input)
  if (!code) return { ok: false, message: 'Agent did not produce importer code.' }
  const wrapped = [
    `const __DATASET_TEXT__ = ${JSON.stringify(input.text)};`,
    `const __IMPORT_CONTEXT__ = ${JSON.stringify({ table: input.table, mode: input.mode ?? 'replace', instruction: input.instruction ?? '', sourceUrl: input.sourceUrl ?? '' })};`,
    'function parse(text, context) {',
    code,
    '}',
    'const __result = parse(__DATASET_TEXT__, __IMPORT_CONTEXT__);',
    'console.log(JSON.stringify(__result));',
  ].join('\n')
  const run = await getSandboxDriver().runCode(wrapped, { timeoutMs: 30_000 })
  if (!run.ok) {
    return {
      ok: false,
      importerCode: code,
      message: `Importer script failed: ${run.error ?? (run.stderr || 'unknown error')}`,
    }
  }
  let parsed: { rows: Record<string, unknown>[]; notes?: string }
  try {
    parsed = parseImporterOutput(run.stdout)
  } catch (err) {
    return { ok: false, importerCode: code, message: `Importer output was invalid: ${String((err as Error)?.message ?? err)}` }
  }
  const result = await loadDataset(record, {
    skillId: input.skillId,
    format: 'json',
    text: JSON.stringify(parsed.rows),
    table: input.table,
    mode: input.mode,
  })
  const skill = (record.skills ?? []).find((s) => s.id === input.skillId)
  if (skill?.config) {
    skill.config = {
      ...skill.config,
      lastImport: {
        importer: 'agent-script',
        sourceUrl: input.sourceUrl,
        instruction: input.instruction,
        notes: parsed.notes,
        generatedAt: new Date().toISOString(),
      },
    }
    saveRecord(record)
  }
  return {
    ...result,
    importerCode: code,
    notes: parsed.notes,
    sample: parsed.rows.slice(0, 5),
    message: result.ok ? `${result.message} Agent wrote and ran an importer script.` : result.message,
  }
}

export async function queryDataset(record: MiniappRecord, spec: QuerySpec) {
  return getDatastoreDriver().query(record.id, spec)
}

export async function listTables(record: MiniappRecord) {
  return getDatastoreDriver().listTables(record.id)
}
