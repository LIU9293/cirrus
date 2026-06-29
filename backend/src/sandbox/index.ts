import { execFile } from 'node:child_process'
import { currentSandbox } from '../agent/llmContext.ts'

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
      execFile('node', ['--input-type=module', '-e', code], { timeout, maxBuffer: 10 << 20 }, (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          resolve({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', error: `Timed out after ${timeout}ms` })
          return
        }
        resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? String(err.message) : undefined })
      })
    })
  },
}

/** Build an E2B driver bound to a specific API key (the user's BYO key, or env). */
function makeE2BDriver(apiKey: string | undefined, domain?: string): SandboxDriver {
  return {
    name: 'e2b',
    async runCode(code, opts) {
      if (!apiKey) {
        return { ok: false, stdout: '', stderr: '', error: 'No E2B API key configured. Add an E2B sandbox in Dashboard → Sandbox, or set E2B_API_KEY.' }
      }
      let mod: any
      try {
        // @ts-ignore optional peer dependency — install @e2b/code-interpreter to enable
        mod = await import('@e2b/code-interpreter')
      } catch {
        return { ok: false, stdout: '', stderr: '', error: 'E2B SDK not installed. Run `npm i @e2b/code-interpreter` in backend to enable the e2b driver.' }
      }
      const Sandbox = mod.Sandbox
      let sbx: any
      try {
        sbx = await Sandbox.create({ apiKey, ...(domain ? { domain } : {}), timeoutMs: opts?.timeoutMs ?? 30_000 })
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
}

/** Daytona driver: runs JS in a Daytona sandbox via @daytonaio/sdk (optional peer
 *  dep — install it to enable, else this returns a graceful error). */
function makeDaytonaDriver(apiKey: string): SandboxDriver {
  return {
    name: 'daytona',
    async runCode(code) {
      if (!apiKey) return { ok: false, stdout: '', stderr: '', error: 'No Daytona API key configured. Add a Daytona sandbox in Dashboard → Sandbox.' }
      let mod: any
      try {
        // @ts-ignore optional peer dependency — install @daytonaio/sdk to enable
        mod = await import('@daytonaio/sdk')
      } catch {
        return { ok: false, stdout: '', stderr: '', error: 'Daytona SDK not installed. Run `npm i @daytonaio/sdk` in backend to enable the daytona driver.' }
      }
      const Daytona = mod.Daytona ?? mod.default
      let daytona: any
      let sandbox: any
      try {
        daytona = new Daytona({ apiKey })
        sandbox = await daytona.create({ language: 'javascript' })
        const res = await sandbox.process.codeRun(code)
        const stdout = String(res?.result ?? res?.stdout ?? '')
        const exit = Number(res?.exitCode ?? 0)
        return { ok: exit === 0, stdout, stderr: String(res?.stderr ?? ''), error: exit === 0 ? undefined : `exited with code ${exit}` }
      } catch (err) {
        return { ok: false, stdout: '', stderr: '', error: String((err as Error)?.message ?? err) }
      } finally {
        try {
          await (sandbox?.delete?.() ?? daytona?.delete?.(sandbox))
        } catch {
          /* ignore */
        }
      }
    },
  }
}

const envE2BDriver = makeE2BDriver(process.env.E2B_API_KEY, process.env.E2B_DOMAIN)

/** Resolve the sandbox driver for the acting request: the user's configured
 *  sandbox (BYO) → the env-selected default → the local dev driver. */
export function getSandboxDriver(): SandboxDriver {
  const user = currentSandbox()
  if (user?.key) {
    return user.provider === 'daytona' ? makeDaytonaDriver(user.key) : makeE2BDriver(user.key)
  }
  return (process.env.SANDBOX_DRIVER ?? 'local') === 'e2b' ? envE2BDriver : LocalDriver
}
