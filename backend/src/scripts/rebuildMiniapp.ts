// Rebuilds a miniapp from its stored source and persists the new dist html.
// Usage: node --import tsx src/scripts/rebuildMiniapp.ts <miniappId>
import { loadRecord, saveRecord } from '../store.ts'
import { buildMiniapp } from '../build/buildMiniapp.ts'

async function main() {
  const id = process.argv[2]
  if (!id) throw new Error('usage: rebuildMiniapp <miniappId>')
  const record = await loadRecord(id)
  if (!record) throw new Error('miniapp not found: ' + id)
  console.log(`Building ${id} (${record.manifest?.name ?? ''})…`)
  const result = await buildMiniapp(id)
  if (!result.ok || !result.html) {
    console.error('BUILD FAILED:\n' + (result.error ?? 'no html'))
    process.exit(1)
  }
  record.html = result.html
  await saveRecord(record)
  console.log(`✅ built + saved (${result.html.length} bytes)`)
  process.exit(0)
}

main().catch((err) => {
  console.error('rebuild failed:', err)
  process.exit(1)
})
