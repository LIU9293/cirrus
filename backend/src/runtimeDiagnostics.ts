import { readAgentFile } from './agentfs.ts'
import { loadRecord } from './store.ts'
import { runInRuntimeSandbox } from './sandbox/runtimeSandbox.ts'
import type { RuntimeRecord } from '../../shared/protocol.ts'

export interface RuntimeDiagnosticResult {
  ok: boolean
  runtimeId: string
  sandboxId?: string
  miniappId?: string
  result?: unknown
  stdout?: string
  stderr?: string
  error?: string
}

function parseSandboxJson(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map((s: string) => s.trim())
    .filter(Boolean)
  const line = [...lines].reverse().find((s) => s.startsWith('{') && s.endsWith('}'))
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function runtimeSandbox(runtime: RuntimeRecord): { ok: true; sandboxId: string } | { ok: false; error: string } {
  if (runtime.sandboxKind === 'local' || !runtime.sandboxId) {
    return { ok: false, error: 'Runtime is not backed by a sandbox.' }
  }
  return { ok: true, sandboxId: runtime.sandboxId }
}

function buildNetworkDiagnosticCode() {
  return `
(async () => {
  const dns = require('node:dns').promises;
  const net = require('node:net');

  async function lookup(host) {
    const startedAt = Date.now();
    try {
      const addresses = await dns.lookup(host, { all: true });
      return { type: 'dns', host, ok: true, ms: Date.now() - startedAt, addresses: addresses.map((a) => a.address) };
    } catch (err) {
      return { type: 'dns', host, ok: false, ms: Date.now() - startedAt, error: String(err && err.message ? err.message : err) };
    }
  }

  async function tcp(host, port) {
    const startedAt = Date.now();
    return await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (result) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve({ type: 'tcp', host, port, ms: Date.now() - startedAt, ...result });
      };
      socket.setTimeout(8000);
      socket.once('connect', () => done({ ok: true }));
      socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
      socket.once('error', (err) => done({ ok: false, error: String(err && err.message ? err.message : err) }));
    });
  }

  const checks = [];
  for (const host of ['imap.gmail.com', 'gmail.com', 'ai-relay.chainbot.io', 'registry.npmjs.org']) checks.push(await lookup(host));
  checks.push(await tcp('imap.gmail.com', 993));
  checks.push(await tcp('gmail.com', 443));
  checks.push(await tcp('ai-relay.chainbot.io', 443));
  checks.push(await tcp('8.8.8.8', 53));
  console.log(JSON.stringify({ ok: checks.some((c) => c.ok), node: process.version, now: new Date().toISOString(), checks }));
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
});
`.trim()
}

async function getGmailCredentials(recordId: string): Promise<{ email: string; appPassword: string } | { error: string }> {
  let raw: string | null = null
  for (const path of ['secrets/gmail.json', 'secrets/Gmail.json']) {
    raw = await readAgentFile(recordId, path)
    if (raw) break
  }
  if (!raw) return { error: 'Gmail credentials are not configured for this agent.' }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const email = String(parsed.email ?? parsed.gmail_address ?? parsed.gmailAddress ?? '').trim()
    const appPassword = String(parsed.app_password ?? parsed.appPassword ?? parsed.password ?? '').replace(/\s+/g, '')
    if (!email || !appPassword) return { error: 'Gmail credentials are missing email or app_password.' }
    return { email, appPassword }
  } catch {
    return { error: 'Gmail credentials file is not valid JSON.' }
  }
}

function buildGmailImapDiagnosticCode(creds: { email: string; appPassword: string }) {
  return `
(async () => {
  const tls = require('node:tls');

  const host = 'imap.gmail.com';
  const port = 993;
  const email = ${JSON.stringify(creds.email)};
  const password = ${JSON.stringify(creds.appPassword)};
  const result = {
    ok: false,
    host,
    port,
    emailDomain: email.includes('@') ? email.split('@').pop() : '',
    connected: false,
    authenticated: false,
    inboxSelected: false,
    searchOk: false,
  };

  function scrub(value) {
    return String(value || '').replaceAll(email, '[email]').replaceAll(password, '[password]');
  }

  function quote(value) {
    return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  }

  function waitFor(socket, bufferRef, predicate, label, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(label + ' timed out'));
      }, timeoutMs);
      const check = () => {
        const value = predicate(bufferRef.value);
        if (!value) return;
        cleanup();
        resolve(value === true ? null : value);
      };
      const onData = () => check();
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('data', onData);
        socket.off('error', onError);
      };
      socket.on('data', onData);
      socket.once('error', onError);
      check();
    });
  }

  const bufferRef = { value: '' };
  const socket = tls.connect({ host, port, servername: host });
  socket.on('data', (chunk) => {
    bufferRef.value += chunk.toString('utf8');
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('secureConnect timed out')), 12000);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  result.connected = true;
  result.tlsAuthorized = socket.authorized === true;
  result.tlsProtocol = typeof socket.getProtocol === 'function' ? socket.getProtocol() : null;
  await waitFor(socket, bufferRef, (buf) => /\\* (OK|PREAUTH)/i.test(buf), 'IMAP greeting');

  let seq = 0;
  async function tagged(command, label) {
    const tag = 'A' + String(++seq).padStart(3, '0');
    const start = bufferRef.value.length;
    socket.write(tag + ' ' + command + '\\r\\n');
    const done = await waitFor(
      socket,
      bufferRef,
      (buf) => {
        const fresh = buf.slice(start);
        const m = fresh.match(new RegExp('^' + tag + ' (OK|NO|BAD).*$', 'mi'));
        return m ? { status: m[1].toUpperCase(), line: scrub(m[0]) } : null;
      },
      label,
    );
    return done;
  }

  const login = await tagged('LOGIN "' + quote(email) + '" "' + quote(password) + '"', 'LOGIN');
  result.loginStatus = login.status;
  result.loginLine = login.line;
  result.authenticated = login.status === 'OK';

  if (result.authenticated) {
    const selected = await tagged('SELECT INBOX', 'SELECT INBOX');
    result.selectStatus = selected.status;
    result.selectLine = selected.line;
    result.inboxSelected = selected.status === 'OK';
    const existsMatches = [...bufferRef.value.matchAll(/^\\* (\\d+) EXISTS$/gmi)];
    if (existsMatches.length) result.inboxExists = Number(existsMatches.at(-1)[1]);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const sinceImap = since.getUTCDate() + '-' + months[since.getUTCMonth()] + '-' + since.getUTCFullYear();
    const search = await tagged('UID SEARCH SINCE ' + sinceImap, 'UID SEARCH');
    result.searchStatus = search.status;
    result.searchOk = search.status === 'OK';
    const searchMatches = [...bufferRef.value.matchAll(/^\\* SEARCH ?(.*)$/gmi)];
    if (searchMatches.length) {
      const ids = String(searchMatches.at(-1)[1] || '').trim().split(/\\s+/).filter(Boolean);
      result.recentUidCount = ids.length;
    }
  }

  await tagged('LOGOUT', 'LOGOUT').catch(() => null);
  socket.destroy();
  result.ok = result.connected && result.authenticated && result.inboxSelected;
  console.log(JSON.stringify(result));
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, host: 'imap.gmail.com', port: 993, connected: false, authenticated: false, inboxSelected: false, searchOk: false, error: String(err && err.message ? err.message : err) }));
});
`.trim()
}

export async function diagnoseRuntimeNetwork(runtime: RuntimeRecord): Promise<RuntimeDiagnosticResult> {
  const sandbox = runtimeSandbox(runtime)
  if (!sandbox.ok) return { ok: false, runtimeId: runtime.id, error: sandbox.error }
  const run = await runInRuntimeSandbox(sandbox.sandboxId, buildNetworkDiagnosticCode(), { timeoutMs: 45_000 })
  return {
    ok: run.ok,
    runtimeId: runtime.id,
    sandboxId: sandbox.sandboxId,
    result: parseSandboxJson(run.stdout),
    stdout: run.stdout.slice(0, 4000),
    stderr: run.stderr.slice(0, 2000),
    error: run.error,
  }
}

export async function diagnoseRuntimeGmail(runtime: RuntimeRecord, requestedMiniappId = ''): Promise<RuntimeDiagnosticResult> {
  const sandbox = runtimeSandbox(runtime)
  if (!sandbox.ok) return { ok: false, runtimeId: runtime.id, error: sandbox.error }

  const ownAgent = requestedMiniappId
    ? runtime.agents.find((a) => a.source === 'own' && a.miniappId === requestedMiniappId)
    : runtime.agents.find((a) => a.source === 'own' && a.miniappId)
  const miniappId = requestedMiniappId || ownAgent?.miniappId || ''
  if (!miniappId) return { ok: false, runtimeId: runtime.id, sandboxId: sandbox.sandboxId, error: 'Runtime has no own miniapp agent to read Gmail credentials from.' }
  const record = await loadRecord(miniappId)
  if (!record) return { ok: false, runtimeId: runtime.id, sandboxId: sandbox.sandboxId, miniappId, error: 'Miniapp agent not found.' }

  const creds = await getGmailCredentials(record.id)
  if ('error' in creds) return { ok: false, runtimeId: runtime.id, sandboxId: sandbox.sandboxId, miniappId: record.id, error: creds.error }

  const run = await runInRuntimeSandbox(sandbox.sandboxId, buildGmailImapDiagnosticCode(creds), { timeoutMs: 45_000 })
  const result = parseSandboxJson(run.stdout)
  return {
    ok: run.ok && !!(result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok),
    runtimeId: runtime.id,
    miniappId: record.id,
    sandboxId: sandbox.sandboxId,
    result,
    stderr: run.stderr.slice(0, 2000),
    error: run.error,
  }
}
