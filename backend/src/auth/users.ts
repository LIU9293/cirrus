import { query } from '../db.ts'
import type { AuthUser, User } from '../../../shared/protocol.ts'

// User store, backed by Postgres (table `users`). Keyed by Google subject id for
// login; email is also unique so a dev/bootstrap account can be claimed by Google.

interface UserRow {
  id: string
  google_sub: string
  email: string
  name: string | null
  picture: string | null
  created_at: Date | string
  updated_at: Date | string
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    googleSub: r.google_sub,
    email: r.email,
    name: r.name ?? undefined,
    picture: r.picture ?? undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }
}

function newUserId(): string {
  return 'usr-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

export async function getUser(id: string): Promise<User | null> {
  const { rows } = await query<UserRow>('select * from users where id = $1', [id])
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const { rows } = await query<UserRow>('select * from users where email = $1', [email.toLowerCase()])
  return rows[0] ? rowToUser(rows[0]) : null
}

export interface GoogleProfile {
  sub: string
  email: string
  name?: string
  picture?: string
}

/** Create or update a user from a verified Google profile, keyed by sub (then email). */
export async function upsertGoogleUser(profile: GoogleProfile): Promise<User> {
  const email = profile.email.toLowerCase()
  const { rows } = await query<UserRow>('select * from users where google_sub = $1 or email = $2 limit 1', [profile.sub, email])
  const existing = rows[0] ? rowToUser(rows[0]) : null
  if (existing) {
    const { rows: updated } = await query<UserRow>(
      `update users set google_sub = $2, email = $3,
         name = coalesce($4, name), picture = coalesce($5, picture), updated_at = now()
       where id = $1 returning *`,
      [existing.id, profile.sub, email, profile.name ?? null, profile.picture ?? null],
    )
    return rowToUser(updated[0])
  }
  const { rows: created } = await query<UserRow>(
    `insert into users (id, google_sub, email, name, picture) values ($1, $2, $3, $4, $5) returning *`,
    [newUserId(), profile.sub, email, profile.name ?? null, profile.picture ?? null],
  )
  return rowToUser(created[0])
}

/** Dev-only: create/get a user by email without Google (used when OAuth is off). */
export async function upsertDevUser(email: string, name?: string): Promise<User> {
  return upsertGoogleUser({ sub: `dev:${email.toLowerCase()}`, email, name: name ?? email.split('@')[0] })
}

export function publicUser(user: User): AuthUser {
  return { id: user.id, email: user.email, name: user.name, picture: user.picture }
}
