import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from '../config.ts'

// Stateless session: a compact HS256-style JWT in an httpOnly cookie. Signed with
// SESSION_SECRET; no server-side session store to maintain.

const COOKIE = 'terr_session'
const MAX_AGE_SEC = 60 * 60 * 24 * 30 // 30 days

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj))
}
function sign(data: string): string {
  return b64url(createHmac('sha256', config.sessionSecret).update(data).digest())
}

export function signSession(userId: string): string {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' })
  const payload = b64urlJson({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC })
  const body = `${header}.${payload}`
  return `${body}.${sign(body)}`
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts
  const expected = sign(`${header}.${payload}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as { sub?: string; exp?: number }
    if (!data.sub || (data.exp && data.exp * 1000 < Date.now())) return null
    return data.sub
  } catch {
    return null
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export function setSessionCookie(res: Response, token: string) {
  const secure = config.appBaseUrl.startsWith('https')
  res.cookie?.(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE_SEC * 1000, path: '/' })
}
export function clearSessionCookie(res: Response) {
  res.clearCookie?.(COOKIE, { path: '/' })
}

export function sessionUserId(req: Request): string | null {
  return verifySession(parseCookies(req)[COOKIE])
}

export { COOKIE as SESSION_COOKIE }
