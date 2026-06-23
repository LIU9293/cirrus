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

  /** Postgres connection (Docker compose default for local dev). */
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://terr:terr@localhost:5433/terr',

  // ── Auth ──
  /** Where the SPA lives; used as the post-login redirect + OAuth redirect base. */
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5180',
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  /** OAuth callback (must be registered in Google console). Defaults under appBaseUrl. */
  oauthRedirectUri: process.env.OAUTH_REDIRECT_URI ?? '',
  /** Secret for signing the session JWT cookie. */
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-insecure-session-secret-change-me',
  /** Existing (legacy, pre-auth) data is claimed by this email on first login. */
  bootstrapOwnerEmail: process.env.BOOTSTRAP_OWNER_EMAIL ?? '',
  /** Allow local email-only sign-in even when Google OAuth is configured. */
  devAuthEnabled: process.env.DEV_AUTH_ENABLED === 'true',
}

/** Dev-login is available as a fallback, or explicitly for local development. */
export const devAuthEnabled = config.devAuthEnabled || !config.googleClientId
/** The OAuth callback URL, derived from appBaseUrl when not set explicitly. */
export const oauthRedirectUri = config.oauthRedirectUri || `${config.appBaseUrl}/api/auth/google/callback`

if (!config.apiKey) {
  console.warn('[config] OPENAI_API_KEY is empty — set backend/.env (see .env.example).')
}
