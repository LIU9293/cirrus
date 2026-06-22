import { runInRuntimeSandbox } from '../sandbox/runtimeSandbox.ts'
import { normalizeSearch, readGmailCredentials, type GmailFetchResult, type GmailSearchInput } from './gmailFetch.ts'

function parseSandboxJson(stdout: string): unknown {
  const line = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
    .find((s) => s.startsWith('{') && s.endsWith('}'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function buildSandboxFetchCode(input: {
  user: string
  pass: string
  host: string
  sinceDays: number
  from: string
  subject: string
  query: string
  unread: boolean
  flagged: boolean
  includeSnippet: boolean
  snippetBytes: number
  limit: number
}) {
  return `
(async () => {
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const dir = '/tmp/terr-gmail-agent';
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir + '/package.json')) fs.writeFileSync(dir + '/package.json', JSON.stringify({ type: 'commonjs' }));
  if (!fs.existsSync(dir + '/node_modules/imapflow')) {
    cp.execFileSync('npm', ['install', 'imapflow@1.4.1', '--silent'], { cwd: dir, timeout: 120000, stdio: 'pipe' });
  }
  const { ImapFlow } = require(dir + '/node_modules/imapflow');

  const cfg = ${JSON.stringify(input)};

  function sourceToSnippet(source) {
    if (!source) return '';
    const raw = Buffer.isBuffer(source) ? source.toString('utf-8') : String(source);
    const body = raw.includes('\\r\\n\\r\\n') ? raw.split('\\r\\n\\r\\n').slice(1).join('\\r\\n\\r\\n') : raw;
    return body
      .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
      .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/=[\\r\\n]+/g, '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 2000);
  }

  const client = new ImapFlow({
    host: cfg.host || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  const emails = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const criteria = { since: new Date(Date.now() - cfg.sinceDays * 86400000) };
      if (cfg.from) criteria.from = cfg.from;
      if (cfg.subject) criteria.subject = cfg.subject;
      if (cfg.unread) criteria.seen = false;
      if (cfg.flagged) criteria.flagged = true;
      if (cfg.query) criteria.text = cfg.query;
      const uids = (await client.search(criteria, { uid: true })) || [];
      const pick = uids.slice(-cfg.limit);
      if (pick.length) {
        const q = String(cfg.query || '').trim().toLowerCase();
        for await (const msg of client.fetch(
          pick,
          {
            envelope: true,
            flags: true,
            uid: true,
            ...(cfg.includeSnippet && cfg.snippetBytes ? { source: { start: 0, maxLength: cfg.snippetBytes } } : {}),
          },
          { uid: true },
        )) {
          const env = msg.envelope || {};
          const f = env.from && env.from[0];
          const date = env.date ? new Date(env.date) : new Date();
          const flags = Array.from(msg.flags || []).map((flag) => String(flag).toLowerCase());
          const email = {
            id: String(msg.uid),
            from: f ? f.address || f.name || '' : '',
            subject: env.subject || '(no subject)',
            received_at: isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
            seen: flags.includes('\\\\seen'),
            flagged: flags.includes('\\\\flagged'),
            snippet: sourceToSnippet(msg.source),
          };
          if (!q || (email.from + ' ' + email.subject + ' ' + email.snippet).toLowerCase().includes(q)) emails.push(email);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    console.log(JSON.stringify({ ok: true, mode: 'e2b', emails }));
  } catch (err) {
    try { await client.close?.(); } catch {}
    console.log(JSON.stringify({ ok: false, mode: 'none', error: String(err && err.message ? err.message : err) }));
  }
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, mode: 'none', error: String(err && err.message ? err.message : err) }));
});
`.trim()
}

export async function fetchGmailInRuntimeSandbox(
  recordId: string,
  sandboxId: string,
  maxN = 200,
  input?: GmailSearchInput | string,
): Promise<GmailFetchResult> {
  const creds = readGmailCredentials(recordId)
  if (!creds.ok) return { ok: false, mode: 'none', error: creds.error }
  const search = normalizeSearch(input, maxN)
  const code = buildSandboxFetchCode({
    user: creds.user,
    pass: creds.pass,
    host: String(creds.cfg.host || 'imap.gmail.com'),
    sinceDays: search.sinceDays,
    from: search.from,
    subject: search.subject,
    query: search.query,
    unread: search.unread,
    flagged: search.flagged,
    includeSnippet: search.includeSnippet,
    snippetBytes: Math.min(search.snippetBytes, 3000),
    limit: search.limit,
  })
  const out = await runInRuntimeSandbox(sandboxId, code, { timeoutMs: 180_000 })
  if (!out.ok) return { ok: false, mode: 'none', error: out.error || out.stderr || 'E2B Gmail fetch failed.' }
  const parsed = parseSandboxJson(out.stdout) as GmailFetchResult | null
  if (!parsed || typeof parsed !== 'object') return { ok: false, mode: 'none', error: 'E2B Gmail fetch returned no JSON result.' }
  if (!parsed.ok) return { ok: false, mode: 'none', error: parsed.error || 'E2B Gmail fetch failed.' }
  return { ok: true, mode: 'e2b', emails: Array.isArray(parsed.emails) ? parsed.emails : [] }
}
