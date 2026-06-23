import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Minimal .env loader (no dependency). Loads backend/.env if present.
function loadEnv() {
  try {
    const text = readFileSync(resolve(here, '..', '.env'), 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!(key in process.env)) process.env[key] = value
    }
  } catch {
    // No .env file — rely on the ambient environment.
  }
}

loadEnv()

export const config = {
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://ai-relay.chainbot.io/v1',
  apiKey: process.env.OPENAI_API_KEY ?? '',
  model: process.env.MINIAPP_MODEL ?? 'gpt-5.5',
  port: Number(process.env.PORT ?? 3000),
  // Repo roots, resolved from backend/src.
  repoRoot: resolve(here, '..', '..'),
  runtimeDir: resolve(here, '..', '..', 'miniapp-runtime'),
  dataDir: resolve(here, '..', 'data'),
}

if (!config.apiKey) {
  console.warn('[config] OPENAI_API_KEY is empty — set backend/.env (see .env.example).')
}
