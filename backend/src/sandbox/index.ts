import { execFile } from 'node:child_process'

// Sandbox abstraction. Generated/untrusted skill code runs through a SandboxDriver
// so we can develop locally now and flip to E2B later by changing one env var:
//
//   SANDBOX_DRIVER=local   (default) — runs code in a local Node child process.
//                                       NOT isolated; for development only.
//   SANDBOX_DRIVER=e2b     — runs in an E2B sandbox via @e2b/code-interpreter.
//                            Set E2B_API_KEY, and optionally E2B_DOMAIN to point
//                            at a self-hosted / local E2B-compatible control plane
//                            (Docker / Shuru microVM) instead of the cloud.

export interface SandboxRunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface SandboxDriver {
  readonly name: string
  runCode(code: string, opts?: { timeoutMs?: number }): Promise<SandboxRunResult>
}

const LocalDriver: SandboxDriver = {
  name: 'local',
  runCode(code, opts) {
    const timeout = opts?.timeoutMs ?? 10_000
    return new Promise((resolve) => {
      execFile('node', ['--input-type=module', '-e', code], { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', error: `Timed out after ${timeout}ms` })
          return
        }
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? String(err.message) : undefined })
      })
    })
  },
}

const E2BDriver: SandboxDriver = {
  name: 'e2b',
  async runCode(code, opts) {
    if (!process.env.E2B_API_KEY) {
      return { ok: false, stdout: '', stderr: '', error: 'E2B_API_KEY is not set. Set it (and optionally E2B_DOMAIN) to use the E2B sandbox.' }
    }
    let mod: any
    try {
      // @ts-ignore optional peer dependency — install @e2b/code-interpreter to enable
      mod = await import('@e2b/code-interpreter')
    } catch {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: 'E2B SDK not installed. Run `npm i @e2b/code-interpreter` in backend to enable the e2b driver.',
      }
    }
    const Sandbox = mod.Sandbox
    let sbx: any
    try {
      // `domain` (or E2B_DOMAIN env) points at a self-hosted / local control plane.
      sbx = await Sandbox.create({
        apiKey: process.env.E2B_API_KEY,
        ...(process.env.E2B_DOMAIN ? { domain: process.env.E2B_DOMAIN } : {}),
        timeoutMs: opts?.timeoutMs ?? 30_000,
      })
      // E2B's code-interpreter defaults to Python; our skills are JS.
      const exec = await sbx.runCode(code, { language: 'js' })
      const stdout = (exec.logs?.stdout ?? []).join('\n')
      const stderr = (exec.logs?.stderr ?? []).join('\n')
      return { ok: !exec.error, stdout, stderr, error: exec.error ? String(exec.error.value ?? exec.error) : undefined }
    } catch (err) {
      return { ok: false, stdout: '', stderr: '', error: String((err as Error)?.message ?? err) }
    } finally {
      try {
        await sbx?.kill?.()
      } catch {
        /* ignore */
      }
    }
  },
}

export function getSandboxDriver(): SandboxDriver {
  return (process.env.SANDBOX_DRIVER ?? 'local') === 'e2b' ? E2BDriver : LocalDriver
}
