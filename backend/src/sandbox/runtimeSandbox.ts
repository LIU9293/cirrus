// Persistent sandbox lifecycle for Runtimes.
//
// Unlike the ephemeral SandboxDriver (sandbox/index.ts) — which spins a sandbox
// up and tears it down around a single runCode call — a Runtime owns a sandbox
// for its whole lifetime. We create a real E2B sandbox, keep its id, and can
// reconnect to it later by id (Sandbox.connect). When E2B isn't available we
// degrade to a "local" runtime so the rest of the product still works.

export interface ProvisionResult {
  kind: 'e2b' | 'local'
  sandboxId: string | null
  error?: string
}

export interface RuntimeSandboxStatus {
  status: 'running' | 'paused' | 'stopped' | 'error'
  error?: string | null
}

// Keep sandboxes alive for an hour of idle time; reconnecting refreshes this.
const SANDBOX_TTL_MS = 60 * 60 * 1000

async function loadE2B(): Promise<any | null> {
  if (!process.env.E2B_API_KEY) return null
  try {
    // @ts-ignore optional peer dependency
    const mod = await import('@e2b/code-interpreter')
    return mod.Sandbox
  } catch {
    return null
  }
}

const e2bOpts = () => ({
  apiKey: process.env.E2B_API_KEY,
  ...(process.env.E2B_DOMAIN ? { domain: process.env.E2B_DOMAIN } : {}),
})

const e2bConnectOpts = () => ({
  ...e2bOpts(),
  autoResume: true,
})

/** Create a real, persistent E2B sandbox for a runtime. Falls back to local. */
export async function provisionRuntimeSandbox(): Promise<ProvisionResult> {
  const Sandbox = await loadE2B()
  if (!Sandbox) {
    return {
      kind: 'local',
      sandboxId: null,
      error: process.env.E2B_API_KEY ? 'E2B SDK not installed.' : 'E2B_API_KEY not set — running locally.',
    }
  }
  try {
    const sbx = await Sandbox.create({
      ...e2bOpts(),
      timeoutMs: SANDBOX_TTL_MS,
      lifecycle: { onTimeout: 'pause', autoResume: true },
    })
    const id = sbx.sandboxId ?? sbx.id ?? null
    return { kind: 'e2b', sandboxId: id }
  } catch (err) {
    return { kind: 'local', sandboxId: null, error: String((err as Error)?.message ?? err) }
  }
}

/** Run a command inside a runtime's existing sandbox (reconnect by id). */
export async function runInRuntimeSandbox(
  sandboxId: string,
  code: string,
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return { ok: false, stdout: '', stderr: '', error: 'E2B unavailable.' }
  try {
    const sbx = await Sandbox.connect(sandboxId, e2bConnectOpts())
    // Refresh the idle timeout on use.
    await sbx.setTimeout?.(SANDBOX_TTL_MS)
    const exec = await sbx.runCode(code, { language: 'js', timeoutMs: opts?.timeoutMs ?? 30_000 })
    const stdout = (exec.logs?.stdout ?? []).join('\n')
    const stderr = (exec.logs?.stderr ?? []).join('\n')
    return { ok: !exec.error, stdout, stderr, error: exec.error ? String(exec.error.value ?? exec.error) : undefined }
  } catch (err) {
    return { ok: false, stdout: '', stderr: '', error: String((err as Error)?.message ?? err) }
  }
}

/** Read the current E2B sandbox state without connecting/resuming it. */
export async function getRuntimeSandboxStatus(sandboxId: string): Promise<RuntimeSandboxStatus> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return { status: 'error', error: 'E2B unavailable.' }
  try {
    const paginator = Sandbox.list({
      ...e2bOpts(),
      query: { state: ['running', 'paused'] },
      limit: 100,
    })
    while (paginator.hasNext) {
      const sandboxes = (await paginator.nextItems(e2bOpts())) as Array<{ sandboxId?: string; state?: string }>
      const info = sandboxes.find((sandbox) => sandbox.sandboxId === sandboxId)
      if (!info && sandboxes.length === 0) break
      if (!info) continue
      if (info.state === 'paused') return { status: 'paused', error: null }
      if (info.state === 'running') return { status: 'running', error: null }
      return { status: 'error', error: `Unknown E2B sandbox state: ${String(info.state ?? 'missing')}` }
    }
    const info = await Sandbox.getInfo(sandboxId, e2bOpts())
    if (info?.state === 'paused') return { status: 'paused', error: null }
    if (info?.state === 'running') return { status: 'running', error: null }
    return { status: 'error', error: `Unknown E2B sandbox state: ${String(info?.state ?? 'missing')}` }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/not found/i.test(message)) return { status: 'stopped', error: message }
    return { status: 'error', error: message }
  }
}

/** Tear down a runtime's sandbox. Best-effort. */
export async function killRuntimeSandbox(sandboxId: string): Promise<void> {
  const Sandbox = await loadE2B()
  if (!Sandbox) return
  try {
    const sbx = await Sandbox.connect(sandboxId, e2bConnectOpts())
    await sbx.kill?.()
  } catch {
    /* already gone — ignore */
  }
}
