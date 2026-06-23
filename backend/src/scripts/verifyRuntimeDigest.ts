import { loadRuntime } from '../runtimeStore.ts'
import { loadRecord } from '../store.ts'
import { runCirrusRuntimeAction } from '../agent/cirrusRuntimeAgent.ts'
import { getDatastoreDriver } from '../datastore/index.ts'

async function main() {
  const runtimeId = process.argv[2]
  const miniappId = process.argv[3] || process.argv.find((arg) => arg.startsWith('--miniapp='))?.slice('--miniapp='.length) || ''
  if (!runtimeId) throw new Error('Usage: npm run verify:runtime-digest -- <runtimeId> [miniappId]')
  const runtime = await loadRuntime(runtimeId)
  if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`)
  const ownAgent = miniappId
    ? runtime.agents.find((agent) => agent.source === 'own' && agent.miniappId === miniappId)
    : runtime.agents.find((agent) => agent.source === 'own' && agent.miniappId)
  if (!ownAgent?.miniappId) throw new Error(`Runtime ${runtime.id} does not contain the requested own miniapp agent.`)
  if (runtime.sandboxKind !== 'e2b' || !runtime.sandboxId) throw new Error(`Runtime ${runtime.id} is not backed by E2B.`)
  const record = await loadRecord(ownAgent.miniappId)
  if (!record) throw new Error(`Miniapp not found: ${ownAgent.miniappId}`)
  const action = record.manifest?.actions.find((item) => item.id === 'run_gmail_digest')
  if (!action) throw new Error(`Miniapp ${record.id} does not declare run_gmail_digest.`)

  const actionOutcome = await runCirrusRuntimeAction(record, action, { source: 'verify:runtime-digest', runtimeId: runtime.id, sandboxId: runtime.sandboxId })
  const ds = getDatastoreDriver()
  const digestRuns = await ds.query(record.id, { table: 'digest_runs', limit: 1000 })
  const emails = await ds.query(record.id, { table: 'emails', limit: 1 })
  const latest = [...digestRuns.rows].reverse().find((row) => row.mode === 'e2b') ?? null
  const ok = actionOutcome.ok === true && latest?.mode === 'e2b' && emails.total > 0

  console.log(
    JSON.stringify(
      {
        ok,
        runtime: { id: runtime.id, name: runtime.name, sandboxKind: runtime.sandboxKind, sandboxId: runtime.sandboxId },
        miniapp: { id: record.id, name: record.draft?.name ?? record.manifest?.name },
        action: {
          ok: actionOutcome.ok,
          message: actionOutcome.message,
          stateVersion: actionOutcome.stateVersion,
          state: {
            status: actionOutcome.state.status,
            lastScan: actionOutcome.state.lastScan,
            total: actionOutcome.state.total,
            byCategory: actionOutcome.state.byCategory,
            error: actionOutcome.state.error,
          },
        },
        datastore: {
          driver: ds.name,
          latestE2BDigestRun: latest
            ? {
                run_id: latest.run_id,
                scanned_at: latest.scanned_at,
                mode: latest.mode,
                total: latest.total,
                by_category: latest.by_category,
                summary: latest.summary,
              }
            : null,
          emailsTotal: emails.total,
        },
      },
      null,
      2,
    ),
  )
  if (!ok) process.exitCode = 1
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }, null, 2))
  process.exit(1)
})
