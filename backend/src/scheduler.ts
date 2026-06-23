import { PgBoss } from 'pg-boss'
import { config } from './config.ts'
import { listAllRecords, loadRecord, saveRecord } from './store.ts'
import { runInboxTriage } from './apps/inboxTriage.ts'
import { listAgentTree } from './agentfs.ts'

// Durable trigger scheduler, backed by pg-boss (Postgres job queue). A cron job
// fires the tick every minute; pg-boss hands it to exactly ONE worker across all
// running instances, and the `singleton` queue policy prevents overlapping ticks.
// The tick scans agents with an active `schedule` skill and runs their inbox
// triage when due (now − lastScan ≥ frequency).

const QUEUE = 'scheduler-tick'

let boss: PgBoss | null = null

function frequencyToMs(freq: unknown): number {
  const f = String(freq ?? '').toLowerCase()
  if (f === '* * * * *' || f.includes('min')) return 60_000 // every minute (test)
  if (f.includes('day') || f.startsWith('0 0')) return 24 * 3600_000
  return 3600_000 // default: hourly ("0 * * * *")
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const summary of await listAllRecords()) {
    const sched = (summary.skills ?? []).find((s) => s.platformSkillId === 'schedule' && s.status === 'active')
    if (!sched) continue
    // Only apps wired for inbox triage (have the gmail tool).
    if (!(await listAgentTree(summary.id)).tools.includes('gmail_fetch.ts')) continue
    const last = summary.state?.lastScan ? Date.parse(String(summary.state.lastScan)) : 0
    if (now - last < frequencyToMs(sched.config?.frequency)) continue

    const record = await loadRecord(summary.id)
    if (!record) continue
    try {
      const res = await runInboxTriage(record)
      if (res.ok) {
        record.state = {
          ...record.state,
          total: res.total,
          byCategory: res.byCategory,
          heatmap: res.heatmap,
          summary: res.summary,
          lastScan: res.lastScan,
        }
        record.stateVersion += 1
        await saveRecord(record)
        console.log(`[scheduler] ran triage for ${record.id} (${res.total} emails)`)
      }
    } catch (err) {
      console.log(`[scheduler] ${summary.id} failed: ${String((err as Error)?.message ?? err)}`)
    }
  }
}

export async function startScheduler(): Promise<void> {
  boss = new PgBoss({ connectionString: config.databaseUrl })
  boss.on('error', (err: unknown) => console.error('[scheduler] pg-boss error', err))
  await boss.start()
  // singleton: at most one tick queued/active at a time (no pile-up across the
  // per-minute cron); expire a stuck tick so the schedule recovers.
  await boss.createQueue(QUEUE, { policy: 'singleton', expireInSeconds: 600, retryLimit: 0 })
  await boss.work(QUEUE, async () => {
    await tick()
  })
  await boss.schedule(QUEUE, '* * * * *') // every minute (cron's finest granularity)
  console.log('[scheduler] started (pg-boss)')
}

export async function stopScheduler(): Promise<void> {
  await boss?.stop({ graceful: true }).catch(() => {})
  boss = null
}
