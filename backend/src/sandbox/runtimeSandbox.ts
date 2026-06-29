import { config } from '../config.ts'
import { currentSandbox } from '../agent/llmContext.ts'

// Persistent sandbox lifecycle for Runtimes.
//
// Unlike the ephemeral SandboxDriver (sandbox/index.ts) — which spins a sandbox
// up and tears it down around a single runCode call — a Runtime owns a sandbox
// for its whole lifetime. We create a real sandbox, keep its id, and reconnect
// to it later by id. When no provider is available we degrade to a "local"
// runtime so the rest of the product still works.
//
// Two providers, one image: every runtime runs the public Cirrus runtime image
// (config.runtimeImage, see runtime-image/Dockerfile). Daytona pulls it directly;
// E2B runs the template built FROM it (config.runtimeSandboxTemplate). The image
// is public so a user's OWN sandbox key (a different org) can still pull it.

export type SandboxProvider = 'e2b' | 'daytona'

export interface ProvisionResult {
  kind: 'e2b' | 'daytona' | 'local'
  sandboxId: string | null
  error?: string
}

export interface RuntimeSandboxStatus {
  status: 'running' | 'paused' | 'stopped' | 'error'
  error?: string | null
}

interface SandboxTarget {
  provider: SandboxProvider
  key?: string
  domain?: string
}

// Keep sandboxes alive for an hour of idle time; reconnecting refreshes this.
const SANDBOX_TTL_MS = 60 * 60 * 1000

/** Resolve which provider + key to use for the acting request: the runtime's BYO
 *  sandbox (currentSandbox, set by the runtime ALS ctx) → the platform E2B env. */
function resolveTarget(): SandboxTarget {
  const byo = currentSandbox()
  if (byo?.key) return { provider: byo.provider === 'daytona' ? 'daytona' : 'e2b', key: byo.key }
  if (process.env.DAYTONA_API_KEY && (process.env.SANDBOX_DRIVER ?? '') === 'daytona') {
    return { provider: 'daytona', key: process.env.DAYTONA_API_KEY }
  }
  return { provider: 'e2b', key: process.env.E2B_API_KEY, domain: process.env.E2B_DOMAIN }
}

// ─────────────────────────── E2B ───────────────────────────

async function loadE2B(): Promise<any | null> {
  try {
    // @ts-ignore optional peer dependency
    const mod = await import('@e2b/code-interpreter')
    return mod.Sandbox
  } catch {
    return null
  }
}

const e2bOpts = (t: SandboxTarget) => ({ apiKey: t.key, ...(t.domain ? { domain: t.domain } : {}) })
const e2bConnectOpts = (t: SandboxTarget) => ({ ...e2bOpts(t), autoResume: true })

async function provisionE2B(t: SandboxTarget): Promise<ProvisionResult> {
  const Sandbox = await loadE2B()
  if (!Sandbox || !t.key) {
    return { kind: 'local', sandboxId: null, error: t.key ? 'E2B SDK not installed.' : 'No E2B API key — running locally.' }
  }
  try {
    const sbx = await Sandbox.create({
      ...e2bOpts(t),
      // Custom template, built FROM the public runtime image (CLIs baked in).
      template: config.runtimeSandboxTemplate,
      timeoutMs: SANDBOX_TTL_MS,
      lifecycle: { onTimeout: 'pause', autoResume: true },
    })
    return { kind: 'e2b', sandboxId: sbx.sandboxId ?? sbx.id ?? null }
  } catch (err) {
    return { kind: 'local', sandboxId: null, error: String((err as Error)?.message ?? err) }
  }
}

async function runE2B(t: SandboxTarget, sandboxId: string, code: string, opts?: RunOpts): Promise<RunResult> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return { ok: false, stdout: '', stderr: '', error: 'E2B unavailable.' }
  try {
    const sbx = await Sandbox.connect(sandboxId, e2bConnectOpts(t))
    await sbx.setTimeout?.(SANDBOX_TTL_MS)
    const exec = await sbx.runCode(code, {
      language: 'js',
      timeoutMs: opts?.timeoutMs ?? 30_000,
      ...(opts?.onStdout ? { onStdout: (o: { line?: string }) => { try { opts.onStdout!(o?.line ?? String(o)) } catch {} } } : {}),
    })
    const stdout = (exec.logs?.stdout ?? []).join('\n')
    const stderr = (exec.logs?.stderr ?? []).join('\n')
    return { ok: !exec.error, stdout, stderr, error: exec.error ? String(exec.error.value ?? exec.error) : undefined }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: String((err as Error)?.message ?? err) }
  }
}

async function statusE2B(t: SandboxTarget, sandboxId: string): Promise<RuntimeSandboxStatus> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return { status: 'error', error: 'E2B unavailable.' }
  try {
    const paginator = Sandbox.list({ ...e2bOpts(t), query: { state: ['running', 'paused'] }, limit: 100 })
    while (paginator.hasNext) {
      const sandboxes = (await paginator.nextItems(e2bOpts(t))) as Array<{ sandboxId?: string; state?: string }>
      const info = sandboxes.find((sandbox) => sandbox.sandboxId === sandboxId)
      if (!info && sandboxes.length === 0) break
      if (!info) continue
      if (info.state === 'paused') return { status: 'paused', error: null }
      if (info.state === 'running') return { status: 'running', error: null }
      return { status: 'error', error: `Unknown E2B sandbox state: ${String(info.state ?? 'missing')}` }
    }
    const info = await Sandbox.getInfo(sandboxId, e2bOpts(t))
    if (info?.state === 'paused') return { status: 'paused', error: null }
    if (info?.state === 'running') return { status: 'running', error: null }
    return { status: 'error', error: `Unknown E2B sandbox state: ${String(info?.state ?? 'missing')}` }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/not found/i.test(message)) return { status: 'stopped', error: message }
    return { status: 'error', error: message }
  }
}

async function killE2B(t: SandboxTarget, sandboxId: string): Promise<void> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return
  try {
    const sbx = await Sandbox.connect(sandboxId, e2bConnectOpts(t))
    await sbx.kill?.()
  } catch {
    /* already gone — ignore */
  }
}

// ───────────────────────── Daytona ─────────────────────────

async function loadDaytona(): Promise<any | null> {
  try {
    // @ts-ignore optional peer dependency
    const mod = await import('@daytonaio/sdk')
    return mod.Daytona
  } catch {
    return null
  }
}

async function provisionDaytona(t: SandboxTarget): Promise<ProvisionResult> {
  const Daytona = await loadDaytona()
  if (!Daytona || !t.key) {
    return { kind: 'local', sandboxId: null, error: t.key ? 'Daytona SDK not installed.' : 'No Daytona API key — running locally.' }
  }
  try {
    const daytona = new Daytona({ apiKey: t.key })
    // Pull the public runtime image directly (CLIs baked in). Idle-stop after an
    // hour to mirror the E2B TTL; the sandbox persists and is reconnected by id.
    const sandbox = await daytona.create({
      image: config.runtimeImage,
      language: 'javascript',
      autoStopInterval: Math.round(SANDBOX_TTL_MS / 60_000),
    })
    return { kind: 'daytona', sandboxId: sandbox.id ?? null }
  } catch (err) {
    return { kind: 'local', sandboxId: null, error: String((err as Error)?.message ?? err) }
  }
}

/** Reconnect to a Daytona sandbox by id, starting it if it idle-stopped. */
async function getDaytonaSandbox(daytona: any, sandboxId: string): Promise<any> {
  const sandbox = await daytona.get(sandboxId)
  const state = String(sandbox?.state ?? '')
  if (state && state !== 'started' && state !== 'running') {
    try {
      await daytona.start(sandbox)
    } catch {
      /* may already be starting — proceed */
    }
  }
  return sandbox
}

async function runDaytona(t: SandboxTarget, sandboxId: string, code: string, opts?: RunOpts): Promise<RunResult> {
  const Daytona = await loadDaytona()
  if (!Daytona) return { ok: false, stdout: '', stderr: '', error: 'Daytona unavailable.' }
  try {
    const daytona = new Daytona({ apiKey: t.key })
    const sandbox = await getDaytonaSandbox(daytona, sandboxId)
    const res = await sandbox.process.codeRun(code, undefined, Math.round((opts?.timeoutMs ?? 30_000) / 1000))
    const stdout = String(res?.result ?? res?.stdout ?? '')
    const exit = Number(res?.exitCode ?? 0)
    // Daytona codeRun returns the full output at once — surface it to a streaming
    // caller as a single chunk so post-hoc stdout handlers still fire.
    if (opts?.onStdout && stdout) { try { opts.onStdout(stdout) } catch {} }
    return { ok: exit === 0, stdout, stderr: String(res?.stderr ?? ''), error: exit === 0 ? undefined : `exited with code ${exit}` }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: String((err as Error)?.message ?? err) }
  }
}

async function statusDaytona(t: SandboxTarget, sandboxId: string): Promise<RuntimeSandboxStatus> {
  const Daytona = await loadDaytona()
  if (!Daytona) return { status: 'error', error: 'Daytona unavailable.' }
  try {
    const daytona = new Daytona({ apiKey: t.key })
    const sandbox = await daytona.get(sandboxId)
    const state = String(sandbox?.state ?? '')
    if (state === 'started' || state === 'running') return { status: 'running', error: null }
    if (state === 'stopped') return { status: 'paused', error: null }
    if (state === 'archived' || state === 'destroyed') return { status: 'stopped', error: null }
    return { status: state ? 'paused' : 'error', error: state ? null : 'Unknown Daytona sandbox state.' }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/not found/i.test(message)) return { status: 'stopped', error: message }
    return { status: 'error', error: message }
  }
}

async function killDaytona(t: SandboxTarget, sandboxId: string): Promise<void> {
  const Daytona = await loadDaytona()
  if (!Daytona) return
  try {
    const daytona = new Daytona({ apiKey: t.key })
    const sandbox = await daytona.get(sandboxId)
    await (sandbox?.delete?.() ?? daytona.delete(sandbox))
  } catch {
    /* already gone — ignore */
  }
}

// ──────────────────── Provider-agnostic API ────────────────────

interface RunOpts {
  timeoutMs?: number
  onStdout?: (line: string) => void
}
interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

/** Create a real, persistent sandbox for a runtime. Falls back to local.
 *  Pass an explicit target to provision against a specific runtime sandbox; omit
 *  to resolve from the acting request's BYO sandbox / platform default. */
export async function provisionRuntimeSandbox(target?: SandboxTarget): Promise<ProvisionResult> {
  const t = target ?? resolveTarget()
  return t.provider === 'daytona' ? provisionDaytona(t) : provisionE2B(t)
}

/** Run code inside a runtime's existing sandbox (reconnect by id). */
export async function runInRuntimeSandbox(sandboxId: string, code: string, opts?: RunOpts): Promise<RunResult> {
  const t = resolveTarget()
  return t.provider === 'daytona' ? runDaytona(t, sandboxId, code, opts) : runE2B(t, sandboxId, code, opts)
}

/** Read a runtime sandbox's state without resuming it. */
export async function getRuntimeSandboxStatus(sandboxId: string): Promise<RuntimeSandboxStatus> {
  const t = resolveTarget()
  return t.provider === 'daytona' ? statusDaytona(t, sandboxId) : statusE2B(t, sandboxId)
}

/** Tear down a runtime's sandbox. Best-effort. */
export async function killRuntimeSandbox(sandboxId: string): Promise<void> {
  const t = resolveTarget()
  return t.provider === 'daytona' ? killDaytona(t, sandboxId) : killE2B(t, sandboxId)
}
