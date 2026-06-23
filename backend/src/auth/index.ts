import { randomBytes } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { config, devAuthEnabled, oauthRedirectUri } from '../config.ts'
import { upsertGoogleUser, upsertDevUser, getUser, publicUser, type GoogleProfile } from './users.ts'
import { signSession, setSessionCookie, clearSessionCookie, sessionUserId, parseCookies } from './session.ts'
import { claimLegacyData, hasNoOwners } from '../paths.ts'
import type { User } from '../../../shared/protocol.ts'

// Claim pre-auth (legacy flat) data for the bootstrap owner, or for the very
// first user when no bootstrap email is configured.
function maybeClaimLegacy(user: User) {
  const isBootstrap = config.bootstrapOwnerEmail && user.email === config.bootstrapOwnerEmail.toLowerCase()
  if (isBootstrap || (!config.bootstrapOwnerEmail && hasNoOwners())) {
    const claimed = claimLegacyData(user.id)
    if (claimed.miniapps || claimed.runtimes) {
      console.log(`[auth] claimed legacy data for ${user.email}: ${claimed.miniapps} agents, ${claimed.runtimes} runtimes`)
    }
  }
}

// Augment Express's Request with the resolved user id (set by requireAuth).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

/** Gate a route: 401 unless a valid session cookie maps to a real user. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = sessionUserId(req)
  if (!userId || !(await getUser(userId))) return res.status(401).json({ error: 'unauthorized' })
  req.userId = userId
  next()
}

function decodeIdToken(idToken: string): GoogleProfile | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf-8'))
    if (!payload.sub || !payload.email) return null
    return { sub: String(payload.sub), email: String(payload.email), name: payload.name, picture: payload.picture }
  } catch {
    return null
  }
}

export function registerAuthRoutes(app: Express) {
  // Begin the Google OAuth Authorization Code flow.
  app.get('/api/auth/google/start', (req, res) => {
    if (!config.googleClientId) return res.status(503).json({ error: 'Google login is not configured.' })
    const state = randomBytes(16).toString('hex')
    res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' })
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', config.googleClientId)
    url.searchParams.set('redirect_uri', oauthRedirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    url.searchParams.set('access_type', 'online')
    url.searchParams.set('prompt', 'select_account')
    res.redirect(url.toString())
  })

  // OAuth callback: verify state, exchange the code, establish the session.
  app.get('/api/auth/google/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string }
    if (!code || !state || state !== parseCookies(req)['oauth_state']) {
      return res.status(400).send('Invalid OAuth state. <a href="/">Back</a>')
    }
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: oauthRedirectUri,
          grant_type: 'authorization_code',
        }),
      })
      const tok = (await tokenRes.json()) as { id_token?: string; error?: string }
      const profile = tok.id_token ? decodeIdToken(tok.id_token) : null
      if (!profile) return res.status(401).send('Google sign-in failed. <a href="/">Back</a>')
      const user = await upsertGoogleUser(profile)
      maybeClaimLegacy(user)
      setSessionCookie(res, signSession(user.id))
      res.clearCookie('oauth_state', { path: '/' })
      res.redirect(config.appBaseUrl)
    } catch (err) {
      res.status(500).send(`Sign-in error: ${String((err as Error)?.message ?? err)}`)
    }
  })

  // Dev fallback when Google OAuth isn't configured — sign in by email only.
  app.post('/api/auth/dev-login', async (req, res) => {
    if (!devAuthEnabled) return res.status(404).json({ error: 'dev login disabled' })
    const email = String(req.body?.email ?? '').trim().toLowerCase()
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'a valid email is required' })
    const user = await upsertDevUser(email, typeof req.body?.name === 'string' ? req.body.name : undefined)
    maybeClaimLegacy(user)
    setSessionCookie(res, signSession(user.id))
    res.json({ user: publicUser(user) })
  })

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res)
    res.json({ ok: true })
  })

  // Current user (and whether dev login is available, so the UI can adapt).
  app.get('/api/auth/me', async (req, res) => {
    const id = sessionUserId(req)
    const user = id ? await getUser(id) : null
    if (!user) return res.status(401).json({ error: 'unauthorized', devAuth: devAuthEnabled, googleAuth: !!config.googleClientId })
    res.json({ user: publicUser(user), devAuth: devAuthEnabled, googleAuth: !!config.googleClientId })
  })
}
