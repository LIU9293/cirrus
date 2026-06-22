import { listRecords, loadRecord, saveRecord } from './store.ts'
import { runInboxTriage } from './apps/inboxTriage.ts'
import { listAgentTree } from './agentfs.ts'
import type { MiniappRecord } from '../../shared/protocol.ts'

// Minimal trigger scheduler. Every CHECK_MS it looks for apps with an active
// `schedule` skill that are "due" (now − lastScan ≥ their frequency) and runs the
// inbox triage, patching the same state the canvas dashboard renders from.
// (A real deploy would use a durable cron; this is enough to make the hourly
// trigger actually fire end-to-end.)

const CHECK_MS = 30_000

function frequencyToMs(freq: unknown): number {
  const f = String(freq ?? '').toLowerCase()
  if (f === '* * * * *' || f.includes('min')) return 60_000 // every minute (test)
  if (f.includes('day') || f.startsWith('0 0')) return 24 * 3600_000
  return 3600_000 // default: hourly ("0 * * * *")
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const summary of listRecords()) {
    const sched = (summary.skills ?? []).find((s) => s.platformSkillId === 'schedule' && s.status === 'active')
    if (!sched) continue
    // Only apps wired for inbox triage (have the gmail tool).
    if (!listAgentTree(summary.id).tools.includes('gmail_fetch.ts')) continue
    const last = summary.state?.lastScan ? Date.parse(String(summary.state.lastScan)) : 0
    if (now - last < frequencyToMs(sched.config?.frequency)) continue

    const record = loadRecord(summary.id)
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
        saveRecord(record)
        console.log(`[scheduler] ran triage for ${record.id} (${res.total} emails)`)
      }
    } catch (err) {
      console.log(`[scheduler] ${summary.id} failed: ${String((err as Error)?.message ?? err)}`)
    }
  }
}

export function startScheduler(): void {
  setInterval(() => {
    void tick()
  }, CHECK_MS)
  console.log('[scheduler] started')
}
