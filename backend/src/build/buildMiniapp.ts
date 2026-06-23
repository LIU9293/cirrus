import { spawn } from 'node:child_process'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { config } from '../config.ts'
import { readSourceFiles } from '../store.ts'

export interface BuildResult {
  ok: boolean
  html?: string
  error?: string
}

// Builds run in the shared miniapp-runtime project, so serialize them.
let buildChain: Promise<unknown> = Promise.resolve()

function runVite(): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd: config.runtimeDir,
      env: { ...process.env },
    })
    let out = ''
    const onData = (d: Buffer) => {
      out += d.toString()
      if (out.length > 20000) out = out.slice(-20000)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      out += '\n[build timed out after 120s]'
    }, 120000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, out })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: 1, out: out + '\n' + String(err) })
    })
  })
}

async function buildOnce(id: string): Promise<BuildResult> {
  const files = await readSourceFiles(id)
  if (!files.some((f) => f.path === 'app/App.tsx')) {
    return { ok: false, error: 'Missing entry file app/App.tsx. Write the miniapp entry to app/App.tsx (default export a React component).' }
  }

  const runtimeAppDir = join(config.runtimeDir, 'src', 'app')
  // Reset the runtime app dir so stale files from a previous build are gone.
  rmSync(runtimeAppDir, { recursive: true, force: true })
  mkdirSync(runtimeAppDir, { recursive: true })

  for (const f of files) {
    // Source files are rooted at the runtime src dir (paths like "app/App.tsx").
    const target = join(config.runtimeDir, 'src', f.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.content)
  }

  const { code, out } = await runVite()
  if (code !== 0) {
    return { ok: false, error: cleanBuildLog(out) }
  }
  const distFile = join(config.runtimeDir, 'dist', 'index.html')
  if (!existsSync(distFile)) {
    return { ok: false, error: 'Build reported success but produced no dist/index.html.\n' + cleanBuildLog(out) }
  }
  return { ok: true, html: readFileSync(distFile, 'utf-8') }
}

export function buildMiniapp(id: string): Promise<BuildResult> {
  const next = buildChain.then(() => buildOnce(id), () => buildOnce(id))
  buildChain = next.catch(() => undefined)
  return next
}

// Trim noisy vite preamble; keep the lines that point at the actual error.
function cleanBuildLog(out: string): string {
  const lines = out.split('\n').filter((l) => l.trim().length > 0)
  const meaningful = lines.filter(
    (l) => !/^>\s/.test(l) && !/vite v?\d/.test(l) && !/building for production/.test(l) && !/^\s*vite build\s*$/.test(l),
  )
  return (meaningful.length ? meaningful : lines).join('\n').slice(0, 6000)
}
