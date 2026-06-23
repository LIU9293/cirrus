import { query } from './db.ts'
import type { CronJob } from '../../shared/protocol.ts'
import { cronMatches, isValidCron, nextCronRun, parseCron } from './cron.ts'

// Postgres-backed store for scheduled tasks. Each row is one CronJob; the
// scheduler tick reads due jobs and fires them into the runtime chat pipeline.

interface CronRow {
  id: string
  runtime_id: string
  owner_id: string
  name: string
  schedule: string
  message: string
  target_agent_key: string | null
  enabled: boolean
  last_run_at: Date | string | null
  last_run_status: string | null
  next_run_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function rowToJob(r: CronRow): CronJob {
  return {
    id: r.id,
    runtimeId: r.runtime_id,
    ownerId: r.owner_id,
    name: r.name ?? '',
    schedule: r.schedule,
    message: r.message,
    targetAgentKey: r.target_agent_key,
    enabled: r.enabled,
    lastRunAt: iso(r.last_run_at),
    lastRunStatus: r.last_run_status,
    nextRunAt: iso(r.next_run_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }
}

function newCronId(): string {
  return 'cron-' + Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4)
}

export async function listCronJobs(runtimeId: string): Promise<CronJob[]> {
  const { rows } = await query<CronRow>('select * from cron_jobs where runtime_id = $1 order by created_at desc', [runtimeId])
  return rows.map(rowToJob)
}

export async function getCronJob(id: string): Promise<CronJob | null> {
  const { rows } = await query<CronRow>('select * from cron_jobs where id = $1', [id])
  return rows[0] ? rowToJob(rows[0]) : null
}

export interface CreateCronInput {
  runtimeId: string
  ownerId: string
  name?: string
  schedule: string
  message: string
  targetAgentKey?: string | null
  enabled?: boolean
}

export async function createCronJob(input: CreateCronInput): Promise<CronJob> {
  if (!isValidCron(input.schedule)) throw new Error(`Invalid cron expression: "${input.schedule}"`)
  if (!input.message?.trim()) throw new Error('message is required')
  const id = newCronId()
  const enabled = input.enabled ?? true
  const next = enabled ? nextCronRun(input.schedule) : null
  const { rows } = await query<CronRow>(
    `insert into cron_jobs (id, runtime_id, owner_id, name, schedule, message, target_agent_key, enabled, next_run_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [id, input.runtimeId, input.ownerId, input.name?.trim() ?? '', input.schedule.trim(), input.message.trim(), input.targetAgentKey ?? null, enabled, next],
  )
  return rowToJob(rows[0])
}

export interface UpdateCronInput {
  name?: string
  schedule?: string
  message?: string
  targetAgentKey?: string | null
  enabled?: boolean
}

export async function updateCronJob(id: string, patch: UpdateCronInput): Promise<CronJob | null> {
  const existing = await getCronJob(id)
  if (!existing) return null
  const schedule = patch.schedule !== undefined ? patch.schedule.trim() : existing.schedule
  if (!isValidCron(schedule)) throw new Error(`Invalid cron expression: "${schedule}"`)
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled
  const next = enabled ? nextCronRun(schedule) : null
  const { rows } = await query<CronRow>(
    `update cron_jobs set
       name = $2, schedule = $3, message = $4, target_agent_key = $5, enabled = $6, next_run_at = $7, updated_at = now()
     where id = $1 returning *`,
    [
      id,
      patch.name !== undefined ? patch.name.trim() : existing.name,
      schedule,
      patch.message !== undefined ? patch.message.trim() : existing.message,
      patch.targetAgentKey !== undefined ? patch.targetAgentKey : existing.targetAgentKey ?? null,
      enabled,
      next,
    ],
  )
  return rows[0] ? rowToJob(rows[0]) : null
}

export async function deleteCronJob(id: string): Promise<boolean> {
  const { rowCount } = await query('delete from cron_jobs where id = $1', [id])
  return rowCount > 0
}

/** Enabled jobs whose schedule matches the given minute and that haven't already
 *  run in this same minute. */
export async function listDueCronJobs(now: Date): Promise<CronJob[]> {
  const { rows } = await query<CronRow>('select * from cron_jobs where enabled = true')
  const minuteStart = new Date(now)
  minuteStart.setSeconds(0, 0)
  return rows
    .map(rowToJob)
    .filter((job) => {
      const parsed = parseCron(job.schedule)
      if (!parsed || !cronMatches(parsed, now)) return false
      // Guard against double-fire within the same minute.
      if (job.lastRunAt && new Date(job.lastRunAt).getTime() >= minuteStart.getTime()) return false
      return true
    })
}

/** Record a run: stamp last_run_at/status and recompute next_run_at. */
export async function markCronJobRun(id: string, at: Date, status: string): Promise<void> {
  const job = await getCronJob(id)
  const next = job ? nextCronRun(job.schedule, at) : null
  await query(
    `update cron_jobs set last_run_at = $2, last_run_status = $3, next_run_at = $4, updated_at = now() where id = $1`,
    [id, at, status.slice(0, 500), next],
  )
}
