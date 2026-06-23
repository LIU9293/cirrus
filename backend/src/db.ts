import { config } from './config.ts'

// Postgres access. A single shared pool; `init()` applies the (idempotent) schema
// at boot. Storage modules (users, store, runtimeStore, agentfs, settings) read
// and write through here instead of the local filesystem.

// `pg` is a CommonJS module; import the default and read Pool off it.
// @ts-ignore optional native-ish dependency
import pg from 'pg'

type Pool = import('pg').Pool
type QueryResultRow = Record<string, any>

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })
    pool.on('error', (err) => console.error('[db] idle client error', err))
  }
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await getPool().query(sql, params)
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 }
}

/** Run a function inside a transaction. */
export async function withTx<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn((sql, params) => client.query(sql, params))
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const SCHEMA = `
create table if not exists users (
  id          text primary key,
  google_sub  text unique not null,
  email       text unique not null,
  name        text,
  picture     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists miniapps (
  id            text primary key,
  owner_id      text not null,
  data          jsonb not null,          -- full MiniappRecord minus html
  html          text,                    -- built single-file dist.html
  state_version int  not null default 0, -- mirror of data->>'stateVersion' for optimistic locking
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists miniapps_owner_idx on miniapps(owner_id);

create table if not exists miniapp_files (
  miniapp_id text not null references miniapps(id) on delete cascade,
  path       text not null,              -- 'agent/soul.md', 'src/App.tsx', 'agent/secrets/gmail.json', ...
  content    text not null,
  updated_at timestamptz not null default now(),
  primary key (miniapp_id, path)
);

create table if not exists runtimes (
  id         text primary key,
  owner_id   text not null,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists runtimes_owner_idx on runtimes(owner_id);

create table if not exists runtime_files (
  runtime_id text not null references runtimes(id) on delete cascade,
  path       text not null,
  content    text not null,
  updated_at timestamptz not null default now(),
  primary key (runtime_id, path)
);

create table if not exists cron_jobs (
  id               text primary key,
  runtime_id       text not null references runtimes(id) on delete cascade,
  owner_id         text not null,
  name             text not null default '',
  schedule         text not null,          -- 5-field cron expression
  message          text not null,          -- delivered to the agent on each run
  target_agent_key text,                   -- RuntimeAgentRef.key, or null to route
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  last_run_status  text,
  next_run_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists cron_jobs_runtime_idx on cron_jobs(runtime_id);
`

let initialized = false

/** Apply the schema. Safe to call repeatedly; runs once per process. */
export async function init(): Promise<void> {
  if (initialized) return
  await query(SCHEMA)
  initialized = true
  console.log('[db] schema ready')
}
