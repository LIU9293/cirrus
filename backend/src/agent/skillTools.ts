import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Type as TypeNS } from '@earendil-works/pi-ai'
import { openai } from './client.ts'
import { config } from '../config.ts'
import { saveRecord } from '../store.ts'
import { getSandboxDriver } from '../sandbox/index.ts'
import { getDatastoreDriver, inferColumns, MAX_LIMIT, type Column, type ColumnType } from '../datastore/index.ts'
import { readAgentFile, listAgentTree, writeAgentFile } from '../agentfs.ts'
import { runInboxTriage } from '../apps/inboxTriage.ts'
import { fetchGmailLive, modifyGmailLive, type GmailModifyInput, type GmailSearchInput } from '../apps/gmailFetch.ts'
import { findPlatformSkill } from '../skills/library.ts'
import { resolveSkillSettings, type ResolvedSkillSettings, type SkillBindingContext } from '../skills/settings.ts'
import { makeCronTools } from './cronTools.ts'
import { isPlainObject, type ChatChoice, type ChatImage, type MiniappRecord, type MiniappSkill, type SkillToolCall } from '../../../shared/protocol.ts'

// Turns a miniapp's ACTIVE skills into tools the runtime agent can call, plus the
// core patch_state tool. Every skill — built-in or custom — declares its tool calls
// (skill.tools[]) following shared/terr_skill_contract.md; this module registers each
// one as a pi-agent tool the same way, injecting the skill's credentials so the agent
// never sees secrets.

type Type = typeof TypeNS
export type RuntimeToolActivity =
  | { kind: 'call'; name: string; summary: string }
  | { kind: 'result'; name: string; ok: boolean; detail?: string }

/** Out-of-band UI the agent produced this turn (ask_user buttons, send_image
 *  attachments). The tools mutate this; the chat layer lifts it onto the
 *  assistant message and streams it to the client. */
export interface RuntimeMessageUi {
  choices?: ChatChoice[]
  allowFreeText?: boolean
  /** ask_user question, used as the message body when the agent emits no text. */
  question?: string
  images?: ChatImage[]
}

export interface RuntimeToolOptions {
  onActivity?: (activity: RuntimeToolActivity) => void
  ui?: RuntimeMessageUi
  /** When present, the snapshot tool can fetch a live screenshot of the rendered
   *  mini app from the client. Absent in headless contexts (cron/bots/API) or when
   *  the user doesn't have the mini app open → the tool returns state only. */
  requestScreenshot?: () => Promise<{ ok: boolean; imageUrl?: string; error?: string }>
}

/** Parse a data:image/...;base64,... URL into pi-agent image content (for vision). */
function dataUrlToImageContent(imageUrl: string) {
  const match = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return null
  return { type: 'image' as const, data: match[2], mimeType: match[1] }
}

/** Lets the agent SEE the mini app: its live state always, plus a screenshot of
 *  what the user is currently looking at when one is available (vision model). */
function getCurrentSnapshotTool(Type: Type, record: MiniappRecord, opts: RuntimeToolOptions): AgentTool {
  return {
    name: 'get_current_snapshot',
    label: 'Get current snapshot',
    description:
      "Get the mini app's current snapshot: its live state, plus a screenshot of what the user is seeing when the " +
      'mini app is open. Call this to ground your answer in the actual UI and data before responding to questions ' +
      'about the app or what the user is looking at.',
    parameters: Type.Object({}),
    execute: async () => {
      const state = record.state ?? {}
      if (opts.requestScreenshot) {
        const shot = await opts.requestScreenshot()
        if (shot.ok && shot.imageUrl) {
          const image = dataUrlToImageContent(shot.imageUrl)
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ ok: true, hasScreenshot: true, state }) },
              ...(image ? [image] : []),
            ],
            details: { ok: true, hasScreenshot: true },
          } as ReturnType<typeof toolResult>
        }
        return toolResult({ ok: true, hasScreenshot: false, note: shot.error || 'Screenshot unavailable (mini app not open); state only.', state })
      }
      return toolResult({ ok: true, hasScreenshot: false, note: 'No screenshot channel in this context; state only.', state })
    },
    executionMode: 'sequential',
  }
}

function toolResult(payload: unknown, terminate = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], details: payload, terminate }
}

async function llm(system: string, user: string): Promise<string> {
  const c = await openai.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: 1200,
  })
  return c.choices[0]?.message?.content?.trim() ?? ''
}

function parseJsonMaybe(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function queryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) qs.set(key, value.map(String).join(','))
    else qs.set(key, String(value))
  }
  const out = qs.toString()
  return out ? `?${out}` : ''
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(String).map((s) => s.trim()).filter(Boolean)
}

function repoRef(creds: Record<string, string>, args: any): { owner: string; repo: string } | { error: string } {
  const owner = String(args?.owner ?? creds.default_owner ?? '').trim()
  const repo = String(args?.repo ?? creds.default_repo ?? '').trim()
  if (!owner || !repo) return { error: 'owner and repo are required, or configure default_owner/default_repo credentials.' }
  return { owner, repo }
}

function compactGithubItem(item: any) {
  if (!isPlainObject(item)) return item
  return {
    id: item.id,
    number: item.number,
    name: item.name,
    full_name: item.full_name,
    title: item.title,
    state: item.state,
    html_url: item.html_url,
    description: item.description,
    private: item.private,
    default_branch: item.default_branch,
    updated_at: item.updated_at,
    user: isPlainObject(item.user) ? { login: item.user.login, html_url: item.user.html_url } : undefined,
    labels: Array.isArray(item.labels) ? item.labels.map((label: any) => (isPlainObject(label) ? label.name : label)).filter(Boolean) : undefined,
  }
}

async function githubApi(creds: Record<string, string>, path: string, init: RequestInit = {}) {
  const token = String(creds.token ?? '').trim()
  if (!token) return { ok: false, error: 'GitHub token is not configured.' }
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  const body = parseJsonMaybe(text.slice(0, 12000))
  return { ok: res.ok, status: res.status, body, headers: { rateLimitRemaining: res.headers.get('x-ratelimit-remaining') } }
}

function githubError(res: any, fallback = 'GitHub request failed.') {
  if (typeof res?.error === 'string') return res.error
  return isPlainObject(res?.body) ? String(res.body.message ?? fallback) : fallback
}

function requireConfirmed(args: any) {
  return args?.userConfirmed === true ? null : toolResult({ ok: false, error: 'This GitHub write requires explicit user confirmation. Re-ask the user and call with userConfirmed=true only after they confirm the exact change.' })
}

function configuredHttpBase(resolved: ResolvedSkillSettings) {
  const creds = resolved.credentials
  const base = String(creds.base_url ?? resolved.config?.baseUrl ?? '').trim()
  if (!base) return { error: 'HTTP API base_url is not configured.', creds }
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'base_url must use http or https.', creds }
    return { base: url, creds }
  } catch {
    return { error: 'HTTP API base_url is not a valid URL.', creds }
  }
}

function resolveHttpTarget(base: URL, args: any, creds: Record<string, string>) {
  const raw = String(args?.url ?? args?.path ?? creds.test_path ?? '').trim()
  const target = raw ? new URL(raw, base) : new URL(base)
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const sameOrigin = target.origin === base.origin
  const underBasePath = target.pathname === base.pathname || target.pathname.startsWith(basePath) || base.pathname === '/'
  if (!sameOrigin || !underBasePath) throw new Error('HTTP request target must stay under the configured base_url.')
  const query = isPlainObject(args?.query) ? args.query : {}
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) target.searchParams.append(key, String(item))
    else target.searchParams.set(key, String(value))
  }
  return target
}

function httpAuthHeaders(creds: Record<string, string>, target: URL): Record<string, string> | { error: string } {
  const authType = String(creds.auth_type ?? 'none').trim().toLowerCase()
  if (!authType || authType === 'none') return {}
  if (authType === 'bearer_token') {
    const token = String(creds.token ?? '').trim()
    if (!token) return { error: 'Bearer token is required for auth_type=bearer_token.' }
    return { Authorization: `Bearer ${token}` }
  }
  if (authType === 'api_key_header') {
    const key = String(creds.api_key ?? '').trim()
    if (!key) return { error: 'API key is required for auth_type=api_key_header.' }
    return { [String(creds.api_key_name ?? 'X-API-Key').trim() || 'X-API-Key']: key }
  }
  if (authType === 'api_key_query') {
    const key = String(creds.api_key ?? '').trim()
    if (!key) return { error: 'API key is required for auth_type=api_key_query.' }
    target.searchParams.set(String(creds.api_key_name ?? 'api_key').trim() || 'api_key', key)
    return {}
  }
  if (authType === 'basic_auth') {
    const username = String(creds.username ?? '').trim()
    const password = String(creds.password ?? '')
    if (!username || !password) return { error: 'username and password are required for auth_type=basic_auth.' }
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
  }
  return { error: `Unsupported HTTP auth_type: ${authType}` }
}

async function callConfiguredHttp(resolved: ResolvedSkillSettings, args: any) {
  const baseInfo = configuredHttpBase(resolved)
  if ('error' in baseInfo) return toolResult({ ok: false, error: baseInfo.error })
  try {
    const target = resolveHttpTarget(baseInfo.base, args, baseInfo.creds)
    const authHeaders = httpAuthHeaders(baseInfo.creds, target)
    if ('error' in authHeaders) return toolResult({ ok: false, error: authHeaders.error })
    const method = String(args?.method ?? 'GET').trim().toUpperCase()
    const allowedMethods = Array.isArray(resolved.config?.allowedMethods) ? (resolved.config.allowedMethods as unknown[]).map(String) : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    if (!allowedMethods.includes(method)) return toolResult({ ok: false, error: `HTTP method ${method} is not allowed for this skill.` })
    const inputHeaders = isPlainObject(args?.headers) ? args.headers : {}
    const safeHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(inputHeaders)) {
      const lower = key.toLowerCase()
      if (['authorization', 'cookie', 'set-cookie', 'proxy-authorization'].includes(lower)) continue
      safeHeaders[key] = String(value)
    }
    const hasBody = args?.body !== undefined && args?.body !== null && method !== 'GET'
    const res = await fetch(target, {
      method,
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...safeHeaders,
        ...authHeaders,
      },
      ...(hasBody ? { body: typeof args.body === 'string' ? args.body : JSON.stringify(args.body) } : {}),
    })
    const limit = Math.min(Number(resolved.config?.responseLimitBytes) || 8000, 20000)
    const text = (await res.text()).slice(0, limit)
    return toolResult({
      ok: res.ok,
      status: res.status,
      url: target.toString().replace(target.searchParams.get(String(baseInfo.creds.api_key_name ?? 'api_key')) ?? '__never__', '[redacted]'),
      body: parseJsonMaybe(text),
      truncated: text.length >= limit,
    })
  } catch (err) {
    return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
  }
}

function validColumnType(value: unknown): ColumnType {
  return value === 'number' || value === 'boolean' || value === 'json' ? value : 'text'
}

function normalizeColumns(raw: unknown): Column[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!isPlainObject(item)) return null
      const name = String(item.name ?? '').trim().replace(/[^a-zA-Z0-9_]/g, '_')
      if (!name) return null
      return { name, type: validColumnType(item.type) }
    })
    .filter((item): item is Column => !!item)
}

function tableName(raw: unknown, fallback = ''): string {
  return String(raw || fallback).trim().replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80)
}

function skillFileSlug(skill: MiniappSkill) {
  return skill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'
}

function pickRows(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter(isPlainObject) : []
}

function applyRecordMapping(rows: Record<string, unknown>[], mapping: unknown) {
  if (!isPlainObject(mapping) || !Object.keys(mapping).length) return rows
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(mapping).map(([target, source]) => [target, typeof source === 'string' ? row[source] : undefined]),
    ),
  )
}

async function transformRowsWithModel(rows: Record<string, unknown>[], instruction: string, targetTable: string, skill: MiniappSkill) {
  const raw = await llm(
    [
      'Transform input records into JSON rows for the requested database table.',
      'Return ONLY a JSON array of objects. No markdown, no prose.',
      `Known database interface: ${JSON.stringify(skill.config?.databaseInterface ?? skill.config?.tables ?? {})}`,
      `Target table: ${targetTable}`,
    ].join('\n'),
    [`Instruction: ${instruction || 'Map fields into the target table schema.'}`, `Input records: ${JSON.stringify(rows).slice(0, 12000)}`].join('\n\n'),
  )
  const json = raw.replace(/^```json\n?/i, '').replace(/^```\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  const parsed = JSON.parse(json)
  return pickRows(parsed)
}

function rememberDatabaseTable(skill: MiniappSkill, table: string, columns: Column[], rowCount?: number) {
  const existingTables = isPlainObject(skill.config?.tables) ? (skill.config!.tables as Record<string, unknown>) : {}
  const existing = isPlainObject(existingTables[table]) ? (existingTables[table] as Record<string, unknown>) : {}
  skill.config = {
    ...skill.config,
    datastore: getDatastoreDriver().name,
    table,
    schema: columns.length ? columns : skill.config?.schema,
    ...(typeof rowCount === 'number' ? { rowCount } : {}),
    tables: {
      ...existingTables,
      [table]: {
        ...existing,
        schema: columns.length ? columns : existing.schema,
        ...(typeof rowCount === 'number' ? { rowCount } : {}),
        updatedAt: new Date().toISOString(),
      },
    },
  }
}

async function defineDatabaseInterface(skill: MiniappSkill, record: MiniappRecord, args: any) {
  const rawTables = Array.isArray(args?.tables)
    ? args.tables
    : args?.table
      ? [{ name: args.table, primaryKey: args.primaryKey, fields: args.columns }]
      : []
  const tables = rawTables
    .map((table: any) => {
      const name = tableName(table?.name)
      const fields = normalizeColumns(table?.fields ?? table?.columns)
      if (!name || !fields.length) return null
      return {
        name,
        primaryKey: typeof table?.primaryKey === 'string' ? table.primaryKey : undefined,
        description: typeof table?.description === 'string' ? table.description : undefined,
        fields,
      }
    })
    .filter((table: any): table is { name: string; primaryKey?: string; description?: string; fields: Column[] } => !!table)
  if (!tables.length) return toolResult({ ok: false, error: 'tables must include at least one table with fields' })
  for (const table of tables) {
    await getDatastoreDriver().ensureTable(record.id, table.name, table.fields)
    rememberDatabaseTable(skill, table.name, table.fields)
  }
  skill.config = {
    ...skill.config,
    databaseInterface: {
      tables,
      readme: typeof args?.readme === 'string' ? args.readme : undefined,
      updatedAt: new Date().toISOString(),
    },
  }
  if (typeof args?.readme === 'string' && args.readme.trim()) {
    writeAgentFile(record.id, `skills/${skillFileSlug(skill)}/skill.md`, args.readme.trim())
  }
  saveRecord(record)
  return toolResult({ ok: true, tables })
}

async function queryRecords(skill: MiniappSkill, record: MiniappRecord, args: any) {
  const table = tableName(args?.table, (skill.config?.table as string) ?? '')
  if (!table) return toolResult({ ok: false, error: 'table is required' })
  const res = await getDatastoreDriver().query(record.id, { table, where: isPlainObject(args?.where) ? args.where : undefined, limit: Math.min(Number(args?.limit) || 50, MAX_LIMIT), columns: Array.isArray(args?.columns) ? args.columns.map(String) : undefined })
  return toolResult({ ok: true, table, ...res })
}

async function createRecords(skill: MiniappSkill, record: MiniappRecord, args: any) {
  const rows = pickRows(args?.rows)
  if (!rows.length) return toolResult({ ok: false, error: 'rows must be a non-empty array' })
  const targetTable = tableName(args?.table, (skill.config?.table as string) ?? 'data')
  const columns = inferColumns(rows)
  await getDatastoreDriver().ensureTable(record.id, targetTable, columns)
  const inserted = await getDatastoreDriver().insertRows(record.id, targetTable, rows)
  rememberDatabaseTable(skill, targetTable, columns)
  saveRecord(record)
  return toolResult({ ok: true, table: targetTable, inserted, columns })
}

async function loadMiniappData(record: MiniappRecord, args: any) {
  const rawSources = Array.isArray(args?.sources)
    ? args.sources
    : args?.table
      ? [{ table: args.table, alias: args.alias, where: args.where, limit: args.limit, columns: args.columns }]
      : []
  const sources = rawSources
    .map((source: any) => {
      const table = tableName(source?.table)
      if (!table) return null
      return {
        table,
        alias: tableName(source?.alias, table),
        where: isPlainObject(source?.where) ? source.where : undefined,
        limit: Math.min(Number(source?.limit) || 50, MAX_LIMIT),
        columns: Array.isArray(source?.columns) ? source.columns.map(String) : undefined,
      }
    })
    .filter((source: any): source is { table: string; alias: string; where?: Record<string, unknown>; limit: number; columns?: string[] } => !!source)

  if (!sources.length) return toolResult({ ok: false, error: 'sources must include at least one table.' })

  const data: Record<string, unknown> = {}
  for (const source of sources) {
    const res = await getDatastoreDriver().query(record.id, {
      table: source.table,
      where: source.where,
      limit: source.limit,
      columns: source.columns,
    })
    data[source.alias] = { table: source.table, rows: res.rows, total: res.total }
  }
  return toolResult({ ok: true, data })
}

function patchStateTool(Type: Type, record: MiniappRecord): AgentTool {
  return {
    name: 'patch_state',
    label: 'Patch state',
    description: 'Shallow-merge a patch into the miniapp state model. Provide the full new value for any field you change.',
    parameters: Type.Object({ patch: Type.Record(Type.String(), Type.Any()) }),
    execute: async (_id, rawArgs) => {
      const patch = (rawArgs as any)?.patch
      if (!isPlainObject(patch)) return toolResult({ ok: false, error: 'patch must be an object' })
      record.state = { ...record.state, ...patch }
      record.stateVersion += 1
      saveRecord(record)
      return toolResult({ ok: true, stateVersion: record.stateVersion })
    },
    executionMode: 'sequential',
  }
}

const seq = 'sequential' as const

/** ask_user: present a question + quick-reply buttons; ends the turn so the user
 *  can respond. The chat layer renders the buttons and the click becomes the next
 *  user message. */
function askUserTool(Type: Type, opts: RuntimeToolOptions): AgentTool {
  return {
    name: 'ask_user',
    label: 'Ask the user',
    description:
      'Ask the user a question and show a few quick-reply buttons. Use when you need them to choose between options or confirm. ' +
      'options is a list of { label, value }: label is shown on the button; value is what the user "says" when they tap it (defaults to label). ' +
      'Set allowFreeText=true if they may also type their own answer. After calling this, STOP — wait for the user to reply.',
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.Object({ label: Type.String(), value: Type.Optional(Type.String()) })),
      allowFreeText: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, rawArgs) => {
      const args = rawArgs as any
      const question = String(args?.question ?? '').trim()
      const choices: ChatChoice[] = (Array.isArray(args?.options) ? args.options : [])
        .map((o: any) => {
          const label = String(o?.label ?? o?.value ?? '').trim()
          return label ? { label, value: String(o?.value ?? label) } : null
        })
        .filter(Boolean) as ChatChoice[]
      if (opts.ui) {
        opts.ui.choices = choices
        opts.ui.allowFreeText = Boolean(args?.allowFreeText)
        if (question) opts.ui.question = question
      }
      return toolResult(
        { ok: true, presented: { question, options: choices, allowFreeText: Boolean(args?.allowFreeText) }, note: 'Shown to the user. Stop and wait for their reply.' },
        true,
      )
    },
    executionMode: seq,
  }
}

/** send_image: attach an image to the assistant's reply. */
function sendImageTool(Type: Type, opts: RuntimeToolOptions): AgentTool {
  return {
    name: 'send_image',
    label: 'Send an image',
    description:
      'Send an image to the user in the chat. Provide an http(s) image URL or a data:image/... URL, and optionally an alt/caption. ' +
      'Call once per image; you may also write text in your reply.',
    parameters: Type.Object({ url: Type.String(), alt: Type.Optional(Type.String()) }),
    execute: async (_id, rawArgs) => {
      const args = rawArgs as any
      const url = String(args?.url ?? '').trim()
      if (!/^(https?:\/\/|data:image\/)/i.test(url)) return toolResult({ ok: false, error: 'url must be an http(s) or data:image URL' })
      const image: ChatImage = { url, alt: args?.alt ? String(args.alt) : undefined }
      if (opts.ui) opts.ui.images = [...(opts.ui.images ?? []), image]
      return toolResult({ ok: true, sent: image })
    },
    executionMode: seq,
  }
}

/** Build the pi-agent tool for one built-in handler key, per the skill's tool spec. */
function builtinTool(Type: Type, key: string, spec: SkillToolCall, skill: MiniappSkill, record: MiniappRecord, resolved: ResolvedSkillSettings): AgentTool | null {
  const base = { name: spec.name, label: spec.name, description: spec.description || skill.name, executionMode: seq }

  switch (key) {
    case 'text_generate':
      return { ...base, parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_i, a) => toolResult({ ok: true, text: await llm('You generate concise, high-quality text.', String((a as any)?.prompt ?? '')) }) }
    case 'summarize':
      return { ...base, parameters: Type.Object({ text: Type.String() }),
        execute: async (_i, a) => toolResult({ ok: true, summary: await llm('Summarize the input in 1-3 sentences.', String((a as any)?.text ?? '')) }) }
    case 'classify':
      return { ...base, parameters: Type.Object({ text: Type.String(), labels: Type.Optional(Type.Array(Type.String())) }),
        execute: async (_i, a) => {
          const labels = ((a as any)?.labels as string[] | undefined)?.join(', ') || 'relevant categories'
          return toolResult({ ok: true, label: await llm(`Classify the input into one of: ${labels}. Reply with only the label.`, String((a as any)?.text ?? '')) })
        } }
    case 'image_generate':
      return { ...base, parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_i, a) => toolResult({ ok: true, url: `https://placehold.co/512?text=${encodeURIComponent(String((a as any)?.prompt ?? 'image').slice(0, 40))}`, simulated: true }) }
    case 'web_search':
      return { ...base, parameters: Type.Object({ query: Type.String() }),
        execute: async (_i, a) => {
          const q = String((a as any)?.query ?? '')
          return toolResult({ ok: true, query: q, results: await llm('You simulate a web search. Return 3 short result snippets as plain text.', q), simulated: true })
        } }
    case 'http_request':
      return { ...base, parameters: Type.Object({
          path: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          method: Type.Optional(Type.String()),
          query: Type.Optional(Type.Record(Type.String(), Type.Any())),
          headers: Type.Optional(Type.Record(Type.String(), Type.Any())),
          body: Type.Optional(Type.Any()),
        }),
        execute: async (_i, a) => {
          return await callConfiguredHttp(resolved,a)
        } }
    case 'http_connection_status':
      return { ...base, parameters: Type.Object({ path: Type.Optional(Type.String()) }),
        execute: async (_i, a) => await callConfiguredHttp(resolved,{ path: (a as any)?.path, method: 'GET' }) }
    case 'github_connection_status':
      return {
        ...base,
        parameters: Type.Object({}),
        execute: async () => {
          try {
            const user = await githubApi(resolved.credentials,'/user')
            if (!user.ok) return toolResult({ ok: false, status: user.status, error: githubError(user, 'GitHub authentication failed.') })
            const rate = await githubApi(resolved.credentials,'/rate_limit')
            const body = user.body as any
            return toolResult({
              ok: true,
              authenticated: true,
              login: body?.login,
              scopes: 'token accepted',
              rateLimitRemaining: rate.headers?.rateLimitRemaining,
            })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'github_list_repositories':
      return {
        ...base,
        parameters: Type.Object({ type: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
        execute: async (_i, a) => {
          const args = a as any
          const limit = Math.min(Number(args?.limit) || 30, 100)
          const type = ['all', 'owner', 'member'].includes(String(args?.type)) ? String(args.type) : 'owner'
          const res = await githubApi(resolved.credentials,`/user/repos${queryString({ type, sort: 'updated', per_page: limit })}`)
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          const repos = Array.isArray(res.body) ? res.body.map(compactGithubItem) : []
          return toolResult({ ok: true, total: repos.length, repos })
        },
      }
    case 'github_get_repository':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()) }),
        execute: async (_i, a) => {
          const ref = repoRef(resolved.credentials,a)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`)
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          return toolResult({ ok: true, repository: compactGithubItem(res.body) })
        },
      }
    case 'github_list_issues':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), state: Type.Optional(Type.String()), labels: Type.Optional(Type.String()), since: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
        execute: async (_i, a) => {
          const args = a as any
          const ref = repoRef(resolved.credentials,args)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          const limit = Math.min(Number(args?.limit) || 30, 100)
          const state = ['open', 'closed', 'all'].includes(String(args?.state)) ? String(args.state) : 'open'
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues${queryString({ state, labels: args?.labels, since: args?.since, per_page: limit })}`)
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          const issues = Array.isArray(res.body) ? res.body.filter((item: any) => !item.pull_request).map(compactGithubItem) : []
          return toolResult({ ok: true, total: issues.length, issues })
        },
      }
    case 'github_get_issue':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), issueNumber: Type.Number() }),
        execute: async (_i, a) => {
          const args = a as any
          const ref = repoRef(resolved.credentials,args)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          const issueNumber = Number(args?.issueNumber)
          if (!Number.isFinite(issueNumber)) return toolResult({ ok: false, error: 'issueNumber is required.' })
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${issueNumber}`)
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          return toolResult({ ok: true, issue: compactGithubItem(res.body), body: (res.body as any)?.body })
        },
      }
    case 'github_create_issue':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), title: Type.String(), body: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())), userConfirmed: Type.Optional(Type.Boolean()) }),
        execute: async (_i, a) => {
          const denied = requireConfirmed(a)
          if (denied) return denied
          const args = a as any
          const ref = repoRef(resolved.credentials,args)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          if (!String(args?.title ?? '').trim()) return toolResult({ ok: false, error: 'title is required.' })
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: String(args.title), body: String(args.body ?? ''), labels: asStringArray(args.labels) }),
          })
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          return toolResult({ ok: true, issue: compactGithubItem(res.body) })
        },
      }
    case 'github_comment_issue':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), issueNumber: Type.Number(), body: Type.String(), userConfirmed: Type.Optional(Type.Boolean()) }),
        execute: async (_i, a) => {
          const denied = requireConfirmed(a)
          if (denied) return denied
          const args = a as any
          const ref = repoRef(resolved.credentials,args)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          const issueNumber = Number(args?.issueNumber)
          const body = String(args?.body ?? '').trim()
          if (!Number.isFinite(issueNumber) || !body) return toolResult({ ok: false, error: 'issueNumber and body are required.' })
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${issueNumber}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
          })
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          return toolResult({ ok: true, comment: compactGithubItem(res.body), body: (res.body as any)?.body })
        },
      }
    case 'github_update_issue':
      return {
        ...base,
        parameters: Type.Object({ owner: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), issueNumber: Type.Number(), title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), state: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())), userConfirmed: Type.Optional(Type.Boolean()) }),
        execute: async (_i, a) => {
          const denied = requireConfirmed(a)
          if (denied) return denied
          const args = a as any
          const ref = repoRef(resolved.credentials,args)
          if ('error' in ref) return toolResult({ ok: false, error: ref.error })
          const issueNumber = Number(args?.issueNumber)
          if (!Number.isFinite(issueNumber)) return toolResult({ ok: false, error: 'issueNumber is required.' })
          const patch: Record<string, unknown> = {}
          if (typeof args?.title === 'string') patch.title = args.title
          if (typeof args?.body === 'string') patch.body = args.body
          if (args?.state === 'open' || args?.state === 'closed') patch.state = args.state
          const labels = asStringArray(args?.labels)
          if (labels) patch.labels = labels
          if (!Object.keys(patch).length) return toolResult({ ok: false, error: 'Provide title, body, state, or labels to update.' })
          const res = await githubApi(resolved.credentials,`/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${issueNumber}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (!res.ok) return toolResult({ ok: false, status: res.status, error: githubError(res) })
          return toolResult({ ok: true, issue: compactGithubItem(res.body) })
        },
      }
    case 'notify':
      return { ...base, parameters: Type.Object({ message: Type.String() }),
        execute: async (_i, a) => {
          console.log(`[notify] ${String((a as any)?.message ?? '')}`)
          return toolResult({ ok: true, delivered: true, simulated: true })
        } }
    case 'query_dataset': {
      const table = (skill.config?.table as string) ?? ''
      const schema = (skill.config?.schema as { name: string }[] | undefined)?.map((c) => c.name).join(', ')
      return {
        ...base,
        description: `${base.description} — table "${table || '(not loaded yet)'}"${schema ? ` columns: ${schema}.` : '.'} Use \`where\` for exact-match filters and \`limit\`.`,
        parameters: Type.Object({ where: Type.Optional(Type.Record(Type.String(), Type.Any())), limit: Type.Optional(Type.Number()), columns: Type.Optional(Type.Array(Type.String())) }),
        execute: async (_i, a) => {
          if (!table) return toolResult({ ok: true, rows: [], total: 0, note: 'No dataset loaded yet.' })
          const args = a as any
          try {
            const res = await getDatastoreDriver().query(record.id, { table, where: args?.where, limit: Math.min(Number(args?.limit) || 50, MAX_LIMIT), columns: args?.columns })
            return toolResult({ ok: true, ...res })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    }
    case 'define_database_interface':
    case 'define_database_table':
      return {
        ...base,
        parameters: Type.Object({
          tables: Type.Optional(Type.Array(Type.Object({
            name: Type.String(),
            primaryKey: Type.Optional(Type.String()),
            fields: Type.Array(Type.Object({ name: Type.String(), type: Type.Optional(Type.String()) })),
            description: Type.Optional(Type.String()),
          }))),
          table: Type.Optional(Type.String()),
          columns: Type.Optional(Type.Array(Type.Object({ name: Type.String(), type: Type.Optional(Type.String()) }))),
          readme: Type.Optional(Type.String()),
        }),
        execute: async (_i, a) => {
          try {
            return await defineDatabaseInterface(skill, record, a)
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'transform_records':
      return {
        ...base,
        parameters: Type.Object({
          sourceRows: Type.Array(Type.Record(Type.String(), Type.Any())),
          targetTable: Type.String(),
          mapping: Type.Optional(Type.Record(Type.String(), Type.String())),
          instruction: Type.Optional(Type.String()),
          write: Type.Optional(Type.Boolean()),
        }),
        execute: async (_i, a) => {
          const args = a as any
          const sourceRows = pickRows(args?.sourceRows)
          const targetTable = tableName(args?.targetTable)
          if (!sourceRows.length) return toolResult({ ok: false, error: 'sourceRows must be a non-empty array' })
          if (!targetTable) return toolResult({ ok: false, error: 'targetTable is required' })
          try {
            const rows = isPlainObject(args?.mapping)
              ? applyRecordMapping(sourceRows, args.mapping)
              : await transformRowsWithModel(sourceRows, String(args?.instruction ?? ''), targetTable, skill)
            if (args?.write) {
              const written = await createRecords(skill, record, { table: targetTable, rows })
              return written
            }
            return toolResult({ ok: true, table: targetTable, rows, total: rows.length })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'create_records':
    case 'write_rows':
      return { ...base, parameters: Type.Object({ rows: Type.Array(Type.Record(Type.String(), Type.Any())), table: Type.Optional(Type.String()) }),
        execute: async (_i, a) => {
          try {
            return await createRecords(skill, record, a)
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        } }
    case 'query_records':
    case 'query_database':
      return {
        ...base,
        parameters: Type.Object({ table: Type.Optional(Type.String()), where: Type.Optional(Type.Record(Type.String(), Type.Any())), limit: Type.Optional(Type.Number()), columns: Type.Optional(Type.Array(Type.String())) }),
        execute: async (_i, a) => {
          try {
            return await queryRecords(skill, record, a)
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'load_miniapp_data':
      return {
        ...base,
        parameters: Type.Object({
          sources: Type.Array(Type.Object({
            table: Type.String(),
            alias: Type.Optional(Type.String()),
            where: Type.Optional(Type.Record(Type.String(), Type.Any())),
            limit: Type.Optional(Type.Number()),
            columns: Type.Optional(Type.Array(Type.String())),
          })),
        }),
        execute: async (_i, a) => {
          try {
            return await loadMiniappData(record, a)
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'update_records':
      return {
        ...base,
        parameters: Type.Object({ table: Type.String(), where: Type.Record(Type.String(), Type.Any()), patch: Type.Record(Type.String(), Type.Any()) }),
        execute: async (_i, a) => {
          const args = a as any
          const table = tableName(args?.table)
          if (!table) return toolResult({ ok: false, error: 'table is required' })
          if (!isPlainObject(args?.where) || !Object.keys(args.where).length) return toolResult({ ok: false, error: 'where must be a non-empty object' })
          if (!isPlainObject(args?.patch)) return toolResult({ ok: false, error: 'patch must be an object' })
          try {
            const updated = await getDatastoreDriver().updateRows(record.id, table, args.where, args.patch)
            rememberDatabaseTable(skill, table, inferColumns([args.patch]))
            saveRecord(record)
            return toolResult({ ok: true, table, updated })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'delete_records':
      return {
        ...base,
        parameters: Type.Object({ table: Type.String(), where: Type.Record(Type.String(), Type.Any()) }),
        execute: async (_i, a) => {
          const args = a as any
          const table = tableName(args?.table)
          if (!table) return toolResult({ ok: false, error: 'table is required' })
          if (!isPlainObject(args?.where) || !Object.keys(args.where).length) return toolResult({ ok: false, error: 'where must be a non-empty object' })
          try {
            const deleted = await getDatastoreDriver().deleteRows(record.id, table, args.where)
            return toolResult({ ok: true, table, deleted })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'upsert_records':
      return {
        ...base,
        parameters: Type.Object({ table: Type.String(), rows: Type.Array(Type.Record(Type.String(), Type.Any())), keys: Type.Array(Type.String()) }),
        execute: async (_i, a) => {
          const args = a as any
          const table = tableName(args?.table)
          const rows = pickRows(args?.rows)
          const keys = Array.isArray(args?.keys) ? args.keys.map(String).filter(Boolean) : []
          if (!table) return toolResult({ ok: false, error: 'table is required' })
          if (!rows.length) return toolResult({ ok: false, error: 'rows must be a non-empty array' })
          if (!keys.length) return toolResult({ ok: false, error: 'keys must be a non-empty array' })
          try {
            await getDatastoreDriver().ensureTable(record.id, table, inferColumns(rows))
            const result = await getDatastoreDriver().upsertRows(record.id, table, rows, keys)
            rememberDatabaseTable(skill, table, inferColumns(rows))
            saveRecord(record)
            return toolResult({ ok: true, table, ...result })
          } catch (err) {
            return toolResult({ ok: false, error: String((err as Error)?.message ?? err) })
          }
        },
      }
    case 'gmail_connection_status':
      return {
        ...base,
        parameters: Type.Object({}),
        execute: async () => {
          const r = await fetchGmailLive(record.id, 1, { limit: 1, includeSnippet: false }, resolved.credentials)
          return toolResult({
            ok: r.ok,
            mode: r.mode,
            reachable: r.ok,
            authenticated: r.ok,
            sampleCount: r.emails?.length ?? 0,
            ...(r.ok ? {} : { error: r.error ?? 'Gmail not connected.' }),
          })
        },
      }
    case 'gmail_search':
      return { ...base, parameters: Type.Object({
          query: Type.Optional(Type.String()),
          from: Type.Optional(Type.String()),
          subject: Type.Optional(Type.String()),
          sinceDays: Type.Optional(Type.Number()),
          unread: Type.Optional(Type.Boolean()),
          flagged: Type.Optional(Type.Boolean()),
          includeSnippet: Type.Optional(Type.Boolean()),
          snippetBytes: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()),
        }),
        execute: async (_i, a) => {
          const limit = Math.min(Number((a as any)?.limit) || 50, 200)
          const r = await fetchGmailLive(record.id, limit, a as GmailSearchInput, resolved.credentials)
          if (!r.ok) return toolResult({ ok: false, error: r.error ?? 'Gmail not connected — fill the skill credentials.' })
          return toolResult({ ok: true, total: r.emails?.length ?? 0, emails: r.emails ?? [] })
        } }
    case 'gmail_modify_message':
      return { ...base, parameters: Type.Object({
          messageIds: Type.Array(Type.String()),
          operation: Type.Union([
            Type.Literal('archive'),
            Type.Literal('delete'),
            Type.Literal('move'),
            Type.Literal('mark_read'),
            Type.Literal('mark_unread'),
          ]),
          mailbox: Type.Optional(Type.String()),
          sourceMailbox: Type.Optional(Type.String()),
        }),
        execute: async (_i, a) => {
          const r = await modifyGmailLive(record.id, a as GmailModifyInput, resolved.credentials)
          return toolResult(r.ok ? r : { ...r, ok: false, error: r.error ?? 'Gmail modification failed.' })
        } }
    default:
      return null
  }
}

/** A custom skill's tool: run its script in the sandbox, injecting args + credentials. */
function customTool(Type: Type, spec: SkillToolCall, skill: MiniappSkill, record: MiniappRecord, resolved: ResolvedSkillSettings): AgentTool | null {
  const file = spec.entry ?? (skill.config?.file as string | undefined)
  const code = file ? readAgentFile(record.id, file) : (typeof skill.config?.code === 'string' ? String(skill.config.code) : null)
  if (!code) return null
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description || `${skill.name}: run this custom skill in the sandbox.`,
    parameters: Type.Object({ input: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
    execute: async (_i, a) => {
      const input = (a as any)?.input ?? {}
      const creds = resolved.credentials
      const wrapped = `globalThis.__INPUT__ = ${JSON.stringify(input)};\nglobalThis.__CREDENTIALS__ = ${JSON.stringify(creds)};\n${code}`
      const run = await getSandboxDriver().runCode(wrapped, { timeoutMs: 15_000 })
      return toolResult({ ok: run.ok, stdout: run.stdout.slice(0, 3000), error: run.error })
    },
    executionMode: seq,
  }
}

/** Wrap a tool so each invocation is logged — useful to see skills firing. */
function summarizeToolCall(tool: AgentTool, args: unknown): string {
  const parsed = isPlainObject(args) ? args : {}
  if (tool.name === 'patch_state') return 'Updating app state'
  if (tool.name.startsWith('gmail_')) return `Calling Gmail tool: ${tool.name}`
  if (tool.name.startsWith('github_')) return `Calling GitHub tool: ${tool.name}`
  if (tool.name.startsWith('http_')) return `Calling HTTP API tool: ${tool.name}`
  if (tool.name === 'load_miniapp_data') return 'Loading miniapp data source'
  if (tool.name.includes('database')) {
    const table = typeof parsed.table === 'string' ? ` (${parsed.table})` : ''
    return `Calling database tool: ${tool.name}${table}`
  }
  if (tool.name === 'inbox_triage') return 'Running inbox triage'
  return `Calling tool: ${tool.name}`
}

function resultOk(result: unknown): boolean {
  if (!isPlainObject(result)) return true
  const details = result.details
  if (isPlainObject(details) && details.ok === false) return false
  return true
}

function resultDetail(result: unknown): string | undefined {
  if (!isPlainObject(result)) return undefined
  const details = result.details
  if (isPlainObject(details) && typeof details.error === 'string') return details.error
  return undefined
}

function withLog(tool: AgentTool, opts: RuntimeToolOptions): AgentTool {
  const execute = tool.execute
  return {
    ...tool,
    execute: async (id, args) => {
      console.log(`[skill] ${tool.name}`)
      opts.onActivity?.({ kind: 'call', name: tool.name, summary: summarizeToolCall(tool, args) })
      try {
        const result = await execute(id, args)
        opts.onActivity?.({ kind: 'result', name: tool.name, ok: resultOk(result), detail: resultDetail(result) })
        return result
      } catch (err) {
        const detail = String((err as Error)?.message ?? err)
        opts.onActivity?.({ kind: 'result', name: tool.name, ok: false, detail })
        throw err
      }
    },
  }
}

function inboxTriageTool(Type: Type, record: MiniappRecord): AgentTool {
  return {
    name: 'inbox_triage',
    label: 'Inbox triage',
    description:
      'Scan the inbox (Gmail), store the messages in the app DB, and compute category counts + a 7×24 receive heatmap + a short summary. Returns { total, byCategory, heatmap, summary, lastScan }.',
    parameters: Type.Object({}),
    execute: async () => toolResult(await runInboxTriage(record)),
    executionMode: seq,
  }
}

export async function makeRuntimeTools(
  Type: Type,
  record: MiniappRecord,
  ctx: SkillBindingContext = { record },
  opts: RuntimeToolOptions = {},
): Promise<AgentTool[]> {
  const active = (record.skills ?? []).filter((s) => s.status === 'active')
  const out: AgentTool[] = []
  const seen = new Set<string>()
  const add = (t: AgentTool | null) => {
    if (t && !seen.has(t.name)) {
      seen.add(t.name)
      out.push(t)
    }
  }

  for (const skill of active) {
    // Settings/credentials resolve per runtime×agent (falling back to dev) so the
    // same shared agent can be configured differently per runtime.
    const resolved = await resolveSkillSettings(ctx, skill)
    const platformTools = skill.platformSkillId ? findPlatformSkill(skill.platformSkillId)?.tools : undefined
    for (const spec of platformTools?.length ? platformTools : skill.tools ?? []) {
      add(spec.builtin ? builtinTool(Type, spec.builtin, spec, skill, record, resolved) : customTool(Type, spec, skill, record, resolved))
    }
    // Legacy generated skill with no declared contract → expose its code as one tool.
    if (!(skill.tools ?? []).length && skill.source === 'generated' && (skill.config?.file || skill.config?.code)) {
      add(customTool(Type, { name: ('run_' + skill.name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase()).slice(0, 48), description: skill.name }, skill, record, resolved))
    }
  }

  // App-level orchestration: inbox triage when the app can reach Gmail.
  const hasGmail = active.some((s) => s.platformSkillId === 'gmail') || (await listAgentTree(record.id)).tools.includes('gmail_fetch.ts')
  if (hasGmail) add(inboxTriageTool(Type, record))

  // Always-available runtime abilities: see the app, state, talk back, images.
  const base: AgentTool[] = [getCurrentSnapshotTool(Type, record, opts), patchStateTool(Type, record), askUserTool(Type, opts), sendImageTool(Type, opts)]
  // Inside a runtime, the agent can also manage its own scheduled tasks (cron).
  if (ctx.runtimeId) base.push(...makeCronTools(Type, ctx.runtimeId))

  return [...base, ...out].map((tool) => withLog(tool, opts))
}

/** Human-readable list of the skills the agent has, for the system prompt. */
export function describeSkills(record: MiniappRecord): string {
  const active = (record.skills ?? []).filter((s) => s.status === 'active')
  if (!active.length) return 'No extra skills — you can only patch_state.'
  return active
    .map((s) => {
      const calls = (s.tools ?? []).map((t) => t.name).join(', ')
      return `- ${s.name}${calls ? ` → ${calls}` : ''}`
    })
    .join('\n')
}
