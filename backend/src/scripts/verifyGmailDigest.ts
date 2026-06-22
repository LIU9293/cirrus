import { Type } from '@earendil-works/pi-ai'
import { loadRecord } from '../store.ts'
import { makeRuntimeTools } from '../agent/skillTools.ts'
import { getDatastoreDriver } from '../datastore/index.ts'
import { runTerrRuntimeAction } from '../agent/terrRuntimeAgent.ts'

async function main() {
  const appId = process.argv[2] || 'app-l99jrh-2cfn'
  const record = loadRecord(appId)
  if (!record) throw new Error(`Miniapp not found: ${appId}`)

  const tools = makeRuntimeTools(Type, record)
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = byName[name]
    if (!tool) throw new Error(`Tool not active: ${name}`)
    const result = await tool.execute(`verify-${name}`, args)
    return result?.details as any
  }

  const gmailStatus = await call('gmail_connection_status')
  const action = record.manifest?.actions.find((item) => item.id === 'run_gmail_digest')
  const actionOutcome = action
    ? await runTerrRuntimeAction(record, action, { source: 'verify:gmail-digest' })
    : { ok: false, message: 'run_gmail_digest action is not declared.', state: record.state, stateVersion: record.stateVersion }
  const ds = getDatastoreDriver()
  const tables = await ds.listTables(record.id)
  const tableSamples: Record<string, unknown> = {}
  for (const table of ['emails', 'digest_runs', 'agent_operations']) {
    const exists = tables.some((item) => item.table === table)
    tableSamples[table] = exists ? await ds.query(record.id, { table, limit: 3 }) : { rows: [], total: 0 }
  }

  const ok = gmailStatus.ok === true && actionOutcome.ok === true
  console.log(
    JSON.stringify(
      {
        ok,
        appId: record.id,
        agent: record.draft?.name ?? record.manifest?.name ?? record.id,
        tools: tools.map((tool) => tool.name),
        gmail: {
          ok: gmailStatus.ok,
          reachable: gmailStatus.reachable,
          authenticated: gmailStatus.authenticated,
          sampleCount: gmailStatus.sampleCount,
          error: gmailStatus.error,
        },
        action: {
          id: action?.id ?? null,
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
          tables,
          samples: tableSamples,
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
