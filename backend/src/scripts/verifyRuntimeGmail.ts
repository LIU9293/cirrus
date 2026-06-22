import { listRuntimes, loadRuntime } from '../runtimeStore.ts'
import { diagnoseRuntimeGmail, diagnoseRuntimeNetwork } from '../runtimeDiagnostics.ts'

function arg(name: string): string {
  const flag = `--${name}=`
  return process.argv.find((item) => item.startsWith(flag))?.slice(flag.length) ?? ''
}

function pickRuntimeId() {
  const explicit = process.argv[2]?.startsWith('--') ? '' : process.argv[2]
  if (explicit) return explicit
  const withOwnAgent = listRuntimes().find((runtime) => runtime.sandboxKind === 'e2b' && runtime.sandboxId && runtime.agents.some((agent) => agent.source === 'own' && agent.miniappId))
  return withOwnAgent?.id ?? ''
}

async function main() {
  const runtimeId = pickRuntimeId()
  if (!runtimeId) throw new Error('No E2B runtime with an own miniapp agent was found. Pass a runtime id as the first argument.')
  const runtime = loadRuntime(runtimeId)
  if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`)
  const miniappId = arg('miniapp') || arg('app')

  const network = await diagnoseRuntimeNetwork(runtime)
  const gmail = await diagnoseRuntimeGmail(runtime, miniappId)
  const ok = network.ok && gmail.ok

  console.log(
    JSON.stringify(
      {
        ok,
        runtime: {
          id: runtime.id,
          name: runtime.name,
          status: runtime.status,
          sandboxKind: runtime.sandboxKind,
          sandboxId: runtime.sandboxId,
          agents: runtime.agents.map((agent) => ({ name: agent.name, source: agent.source, miniappId: agent.miniappId })),
        },
        network,
        gmail,
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
