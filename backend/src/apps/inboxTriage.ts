import { openai } from '../agent/client.ts'
import { config } from '../config.ts'
import { readAgentFile } from '../agentfs.ts'
import { getSandboxDriver } from '../sandbox/index.ts'
import { getDatastoreDriver } from '../datastore/index.ts'
import { fetchGmailLive, type FetchedEmail } from './gmailFetch.ts'
import { fetchGmailInRuntimeSandbox } from './gmailFetchSandbox.ts'
import type { MiniappRecord } from '../../../shared/protocol.ts'

// Inbox triage, wired end-to-end:
//   fetch (REAL Gmail over IMAP if a credential is in agent/secrets/gmail.json,
//   else the agent's mock gmail_fetch.ts in the sandbox) → classify (LLM) →
//   store in the per-app DB → category proportions + 7×24 heatmap → LLM summary.

const CATEGORIES = ['important', 'notifications', 'promotions', 'spam']

export interface InboxTriageResult {
  ok: boolean
  mode?: 'live' | 'e2b' | 'mock'
  total?: number
  byCategory?: Record<string, number>
  heatmap?: number[][]
  summary?: string
  lastScan?: string
  error?: string
}

type Email = FetchedEmail & { category?: string }

async function recordOperation(
  record: MiniappRecord,
  row: { operation_id: string; operation: string; status: string; created_at: string; details: Record<string, unknown> },
) {
  const ds = getDatastoreDriver()
  await ds.ensureTable(record.id, 'agent_operations', [
    { name: 'operation_id', type: 'text' },
    { name: 'operation', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'created_at', type: 'text' },
    { name: 'details', type: 'json' },
  ])
  await ds.insertRows(record.id, 'agent_operations', [row])
}

async function fetchMock(record: MiniappRecord): Promise<Email[]> {
  const code = await readAgentFile(record.id, 'tools/gmail_fetch.ts')
  if (!code) return []
  const run = await getSandboxDriver().runCode(code, { timeoutMs: 20_000 })
  if (!run.ok) return []
  try {
    const m = run.stdout.match(/\[[\s\S]*\]/)
    return m ? JSON.parse(m[0]) : []
  } catch {
    return []
  }
}

async function classify(emails: Email[]): Promise<Email[]> {
  const todo = emails.filter((e) => !e.category)
  if (!todo.length) return emails
  try {
    const items = todo.map((e, i) => `${i}. from=${e.from} | subject=${e.subject} | snippet=${e.snippet ?? ''}`).join('\n')
    const c = await openai.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: `Classify each email into exactly one of: ${CATEGORIES.join(', ')}. Reply ONLY a JSON array of {i:number, category:string} for every item.`,
        },
        { role: 'user', content: items },
      ],
      max_completion_tokens: 1500,
    })
    const txt = c.choices[0]?.message?.content ?? '[]'
    const arr = JSON.parse((txt.match(/\[[\s\S]*\]/) ?? ['[]'])[0]) as { i: number; category: string }[]
    const map = new Map(arr.map((x) => [x.i, x.category]))
    todo.forEach((e, i) => {
      const cat = String(map.get(i) ?? 'notifications').toLowerCase()
      e.category = CATEGORIES.includes(cat) ? cat : 'notifications'
    })
  } catch {
    todo.forEach((e) => (e.category = 'notifications'))
  }
  return emails
}

export async function runInboxTriage(record: MiniappRecord, opts: { sandboxId?: string; requireSandbox?: boolean } = {}): Promise<InboxTriageResult> {
  const runId = `triage-${Date.now()}`
  const startedAt = new Date().toISOString()
  // 1) Fetch — prefer the real mailbox.
  let mode: 'live' | 'e2b' | 'mock' = 'mock'
  let emails: Email[] = []
  const live = opts.sandboxId
    ? await fetchGmailInRuntimeSandbox(record.id, opts.sandboxId, 100, { limit: 100, sinceDays: 30, includeSnippet: true, snippetBytes: 4096 })
    : await fetchGmailLive(record.id, 100, { limit: 100, sinceDays: 30, includeSnippet: true, snippetBytes: 4096 })
  if (live.ok) {
    emails = live.emails ?? []
    mode = live.mode === 'e2b' ? 'e2b' : 'live'
  }
  if (!emails.length && !opts.requireSandbox) {
    const mock = await fetchMock(record)
    if (mock.length) emails = mock
  }
  if (!emails.length) {
    const source = opts.sandboxId ? 'e2b' : 'live'
    const error = live.error ? `no emails (${source}: ${live.error}${opts.requireSandbox ? '' : '; mock empty'})` : 'no emails fetched'
    await recordOperation(record, {
      operation_id: `${runId}-fetch-failed`,
      operation: 'gmail_digest_scan',
      status: 'failed',
      created_at: new Date().toISOString(),
      details: { run_id: runId, mode: opts.sandboxId ? 'e2b' : live.ok ? 'mock' : 'live', error },
    })
    return { ok: false, error }
  }

  // 2) Classify anything without a category (real emails always need it).
  emails = await classify(emails)

  // 3) Store in the per-app database.
  const ds = getDatastoreDriver()
  await ds.ensureTable(record.id, 'emails', [
    { name: 'id', type: 'text' },
    { name: 'run_id', type: 'text' },
    { name: 'from', type: 'text' },
    { name: 'subject', type: 'text' },
    { name: 'category', type: 'text' },
    { name: 'received_at', type: 'text' },
    { name: 'seen', type: 'boolean' },
    { name: 'flagged', type: 'boolean' },
    { name: 'snippet', type: 'text' },
  ])
  await ds.replaceRows(
    record.id,
    'emails',
    emails.map((e) => ({
      id: e.id,
      run_id: runId,
      from: e.from,
      subject: e.subject,
      category: e.category,
      received_at: e.received_at,
      seen: e.seen ?? null,
      flagged: e.flagged ?? null,
      snippet: e.snippet ?? '',
    })),
  )

  // 4) Aggregate.
  const byCategory: Record<string, number> = {}
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
  for (const e of emails) {
    const c = String(e.category ?? 'other')
    byCategory[c] = (byCategory[c] ?? 0) + 1
    const d = new Date(e.received_at)
    if (!isNaN(d.getTime())) heatmap[d.getDay()][d.getHours()]++
  }
  const total = emails.length

  // 5) Summary.
  let summary = ''
  try {
    const c = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: '用一两句中文总结这次邮箱扫描：强调重要邮件数量，并给一句清理建议。' },
        { role: 'user', content: `共扫描 ${total} 封邮件（来源：${mode === 'mock' ? '演示数据' : mode === 'e2b' ? 'E2B 内的真实 Gmail' : '真实 Gmail'}），分类统计：${JSON.stringify(byCategory)}` },
      ],
      max_completion_tokens: 200,
    })
    summary = c.choices[0]?.message?.content?.trim() ?? ''
  } catch {
    summary = `扫描了 ${total} 封邮件。`
  }

  await ds.ensureTable(record.id, 'digest_runs', [
    { name: 'run_id', type: 'text' },
    { name: 'scanned_at', type: 'text' },
    { name: 'mode', type: 'text' },
    { name: 'total', type: 'number' },
    { name: 'by_category', type: 'json' },
    { name: 'heatmap', type: 'json' },
    { name: 'summary', type: 'text' },
  ])
  await ds.insertRows(record.id, 'digest_runs', [
    {
      run_id: runId,
      scanned_at: startedAt,
      mode,
      total,
      by_category: byCategory,
      heatmap,
      summary,
    },
  ])

  await recordOperation(record, {
    operation_id: `${runId}-store-analysis`,
    operation: 'gmail_digest_scan',
    status: 'completed',
    created_at: new Date().toISOString(),
    details: { run_id: runId, mode, total, byCategory },
  })

  return { ok: true, mode, total, byCategory, heatmap, summary, lastScan: new Date().toISOString() }
}
