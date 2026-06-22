import { readAgentFile } from '../agentfs.ts'

// Real Gmail fetch over IMAP, using a credential the agent stored in
// agent/secrets/gmail.json. Supports an App Password (fast path):
//   { "email": "you@gmail.com", "app_password": "abcd efgh ijkl mnop" }
// Returns recent inbox messages (no classification — triage classifies them).

export interface FetchedEmail {
  id: string
  from: string
  subject: string
  received_at: string
  seen?: boolean
  flagged?: boolean
  snippet?: string
}
export interface GmailFetchResult {
  ok: boolean
  mode: 'live' | 'e2b' | 'none'
  emails?: FetchedEmail[]
  error?: string
}

export interface GmailSearchInput {
  query?: string
  from?: string
  subject?: string
  sinceDays?: number
  unread?: boolean
  flagged?: boolean
  limit?: number
  includeSnippet?: boolean
  snippetBytes?: number
}

export interface GmailModifyInput {
  messageIds?: string[]
  operation?: 'archive' | 'delete' | 'move' | 'mark_read' | 'mark_unread'
  mailbox?: string
  sourceMailbox?: string
}

export interface GmailModifyResult {
  ok: boolean
  mode: 'live' | 'none'
  operation?: string
  messageIds?: string[]
  mailbox?: string
  error?: string
}

export function normalizeSearch(input: GmailSearchInput | string | undefined, fallbackLimit: number): Required<GmailSearchInput> {
  const base = typeof input === 'string' ? { query: input } : input ?? {}
  return {
    query: String(base.query ?? ''),
    from: String(base.from ?? ''),
    subject: String(base.subject ?? ''),
    sinceDays: Math.max(1, Math.min(Number(base.sinceDays) || 30, 365)),
    unread: base.unread === true,
    flagged: base.flagged === true,
    limit: Math.max(1, Math.min(Number(base.limit) || fallbackLimit, 200)),
    includeSnippet: base.includeSnippet !== false,
    snippetBytes: Math.max(0, Math.min(Number(base.snippetBytes) || 2048, 12000)),
  }
}

export function sourceToSnippet(source?: Buffer): string {
  if (!source) return ''
  const raw = source.toString('utf-8')
  const body = raw.includes('\r\n\r\n') ? raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') : raw
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/=[\r\n]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
}

export function readGmailCredentials(recordId: string): { ok: true; cfg: any; user: string; pass: string } | { ok: false; error: string } {
  const raw = readAgentFile(recordId, 'secrets/gmail.json')
  if (!raw) return { ok: false, error: 'no agent/secrets/gmail.json' }
  let cfg: any
  try {
    cfg = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'secrets/gmail.json is not valid JSON' }
  }
  const user = cfg.email || cfg.user || cfg.imap?.user
  const pass = cfg.app_password || cfg.appPassword || cfg.imap?.password || cfg.password
  if (!user || !pass || String(pass).startsWith('REPLACE')) {
    return { ok: false, error: 'no live IMAP credentials in secret (need email + app_password)' }
  }
  return { ok: true, cfg, user: String(user), pass: String(pass).replace(/\s+/g, '') }
}

export async function fetchGmailLive(recordId: string, maxN = 200, input?: GmailSearchInput | string): Promise<GmailFetchResult> {
  const search = normalizeSearch(input, maxN)
  const creds = readGmailCredentials(recordId)
  if (!creds.ok) return { ok: false, mode: 'none', error: creds.error }

  // @ts-ignore optional peer dependency
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: creds.cfg.host || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  })
  const emails: FetchedEmail[] = []
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const criteria: Record<string, unknown> = { since: new Date(Date.now() - search.sinceDays * 86400000) }
      if (search.from) criteria.from = search.from
      if (search.subject) criteria.subject = search.subject
      if (search.unread) criteria.seen = false
      if (search.flagged) criteria.flagged = true
      if (search.query) criteria.text = search.query
      const uids = (await client.search(criteria, { uid: true })) || []
      const pick = uids.slice(-search.limit)
      if (pick.length) {
        const q = search.query.trim().toLowerCase()
        for await (const msg of client.fetch(
          pick,
          {
            envelope: true,
            flags: true,
            uid: true,
            ...(search.includeSnippet && search.snippetBytes ? { source: { start: 0, maxLength: search.snippetBytes } } : {}),
          },
          { uid: true },
        )) {
          const env: any = msg.envelope ?? {}
          const f = env.from?.[0]
          const date = env.date ? new Date(env.date) : new Date()
          const email = {
            id: String(msg.uid),
            from: f ? f.address || f.name || '' : '',
            subject: env.subject || '(no subject)',
            received_at: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
            seen: Array.from((msg.flags ?? []) as Iterable<unknown>).some((flag) => String(flag).toLowerCase() === '\\seen'),
            flagged: Array.from((msg.flags ?? []) as Iterable<unknown>).some((flag) => String(flag).toLowerCase() === '\\flagged'),
            snippet: sourceToSnippet(msg.source),
          }
          if (!q || `${email.from} ${email.subject} ${email.snippet}`.toLowerCase().includes(q)) emails.push(email)
        }
      }
    } finally {
      lock.release()
    }
    await client.logout()
    return { ok: true, mode: 'live', emails }
  } catch (err) {
    try {
      await client.close?.()
    } catch {
      /* ignore */
    }
    return { ok: false, mode: 'none', error: String((err as Error)?.message ?? err) }
  }
}

export async function modifyGmailLive(recordId: string, input: GmailModifyInput): Promise<GmailModifyResult> {
  const creds = readGmailCredentials(recordId)
  if (!creds.ok) return { ok: false, mode: 'none', error: creds.error }
  const operation = input.operation
  const messageIds = (input.messageIds ?? []).map((id) => String(id).trim()).filter(Boolean)
  const uids = messageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
  if (!operation) return { ok: false, mode: 'none', error: 'operation is required' }
  if (!uids.length) return { ok: false, mode: 'none', operation, error: 'messageIds must contain IMAP UID values' }
  if (operation === 'move' && !input.mailbox) return { ok: false, mode: 'none', operation, messageIds, error: 'mailbox is required for move' }

  // @ts-ignore optional peer dependency
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: creds.cfg.host || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  })
  const sourceMailbox = input.sourceMailbox || creds.cfg.sourceMailbox || 'INBOX'
  try {
    await client.connect()
    const lock = await client.getMailboxLock(sourceMailbox)
    try {
      if (operation === 'archive') {
        const archiveMailbox = input.mailbox || creds.cfg.archiveMailbox || '[Gmail]/All Mail'
        await client.messageMove(uids, archiveMailbox, { uid: true })
      } else if (operation === 'delete') {
        if (creds.cfg.trashMailbox) await client.messageMove(uids, String(creds.cfg.trashMailbox), { uid: true })
        else await client.messageDelete(uids, { uid: true })
      } else if (operation === 'move') {
        await client.messageMove(uids, String(input.mailbox), { uid: true })
      } else if (operation === 'mark_read') {
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
      } else if (operation === 'mark_unread') {
        await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true })
      }
    } finally {
      lock.release()
    }
    await client.logout()
    return { ok: true, mode: 'live', operation, messageIds, mailbox: input.mailbox }
  } catch (err) {
    try {
      await client.logout()
    } catch {
      /* ignore logout errors */
    }
    return { ok: false, mode: 'none', operation, messageIds, mailbox: input.mailbox, error: String((err as Error)?.message ?? err) }
  }
}
