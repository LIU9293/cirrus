import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { join } from 'node:path'
import { config } from './config.ts'
import { registerAuthRoutes, requireAuth } from './auth/index.ts'
import * as db from './db.ts'
import { createMiniapp, deleteMiniapp, listRecords, loadRecord, saveRecord } from './store.ts'
import { runDeveloperAgent, type ChatTurn, type AgentEvent } from './agent/developerAgent.ts'
import {
  decideTerrRuntimeRouting,
  describeTerrRuntimeAgentSpecsForRuntime,
  routeTerrRuntimeMessage,
  runTerrRuntimeCommunityChat,
  runTerrRuntimeCoordinatorChat,
  runTerrRuntimeAction,
  runTerrRuntimeChat,
} from './agent/terrRuntimeAgent.ts'
import { resolveCanvasScreenshot } from './canvasScreenshot.ts'
import { PLATFORM_SKILLS } from './skills/library.ts'
import { resolveSkillSettings, writeSkillSettings, settingsFilled, declaredSettings, skillBindingKey, type SkillBindingContext } from './skills/settings.ts'
import { planAndAttachSkills, developSkill, refineFile, chatAboutSkill, chatAboutSurface } from './skills/service.ts'
import { listAgentTree, readAgentFile, writeAgentFile, ensureSoul } from './agentfs.ts'
import { getDatastoreDriver } from './datastore/index.ts'
import { getSandboxDriver } from './sandbox/index.ts'
import { createRuntime, deleteRuntime, listRuntimes, loadRuntime, saveRuntime } from './runtimeStore.ts'
import { getRuntimeSandboxStatus, provisionRuntimeSandbox } from './sandbox/runtimeSandbox.ts'
import { startScheduler } from './scheduler.ts'
import { installCommunityAgentInSandbox, normalizeRuntimeAgentRef } from './communityAgents.ts'
import { clarifyConcept } from './define/clarify.ts'
import { loadDataset, queryDataset, listTables } from './datastore/load.ts'
import { diagnoseRuntimeGmail, diagnoseRuntimeNetwork } from './runtimeDiagnostics.ts'
import type { SkillDevelopMethod } from '../../shared/protocol.ts'
import {
  SET_STATE_ACTION,
  isPlainObject,
  type DeveloperChatMessage,
  type MiniappRecord,
  type BotPlatform,
  type RuntimeAgentRef,
  type RuntimeBot,
  type RuntimeRecord,
} from '../../shared/protocol.ts'

const app = express()
app.use(cors({ origin: true, credentials: true })) // reflect origin + allow session cookie
app.use(express.json({ limit: '4mb' }))

// Auth endpoints (public). Everything under /api/miniapps and /api/runtimes is
// gated to the signed-in user and scoped to data they own.
registerAuthRoutes(app)

async function requireOwnMiniapp(req: Request, res: Response, next: NextFunction) {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  if (record.ownerId && req.userId && record.ownerId !== req.userId) return res.status(404).json({ error: 'not found' })
  next()
}
async function requireOwnRuntime(req: Request, res: Response, next: NextFunction) {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  if (runtime.ownerId && req.userId && runtime.ownerId !== req.userId) return res.status(404).json({ error: 'not found' })
  next()
}

app.use('/api/miniapps', requireAuth)
app.use('/api/miniapps/:id', requireOwnMiniapp)
app.use('/api/runtimes', requireAuth)
app.use('/api/runtimes/:id', requireOwnRuntime)

// Strip the built html from list responses to keep them light.
function summary(record: MiniappRecord) {
  const { html, ...rest } = record
  return { ...rest, hasHtml: !!html }
}

function assistantChunks(text: string, size = 80) {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks.length ? chunks : ['']
}

function activityToEvent(activity: NonNullable<DeveloperChatMessage['activities']>[number]): AgentEvent {
  if (activity.kind === 'tool') return { type: 'tool_call', name: 'runtime_tool', summary: activity.text }
  if (activity.kind === 'build') return activity.ok === false ? { type: 'build', ok: false, error: activity.text } : { type: 'build', ok: true }
  if (activity.kind === 'error' || activity.ok === false) return { type: 'error', message: activity.text }
  return { type: 'status', text: activity.text }
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, model: config.model })
})

app.get('/api/miniapps', async (req, res) => {
  res.json({ miniapps: (await listRecords(req.userId!)).map(summary) })
})

app.post('/api/miniapps', async (req, res) => {
  const record = await createMiniapp(req.userId!)
  res.json({ miniapp: summary(record) })
})

app.get('/api/miniapps/:id', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  res.json({ miniapp: record })
})

app.delete('/api/miniapps/:id', async (req, res) => {
  await getDatastoreDriver().drop(req.params.id).catch(() => {})
  const deleted = await deleteMiniapp(req.params.id)
  if (!deleted) return res.status(404).json({ error: 'not found' })
  res.json({ ok: true })
})

// Load data into the instance's datastore (paste JSON / CSV → a table the skill owns).
app.post('/api/miniapps/:id/datastore/load', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const body = req.body ?? {}
  const result = await loadDataset(record, {
    skillId: String(body.skillId ?? ''),
    format: body.format === 'csv' ? 'csv' : 'json',
    text: String(body.text ?? ''),
    table: body.table ? String(body.table) : undefined,
    mapping: body.mapping ?? undefined,
  })
  res.json(result)
})

// Preview/query a datastore table (structured, scoped — no raw SQL).
app.post('/api/miniapps/:id/datastore/query', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const body = req.body ?? {}
  try {
    const result = await queryDataset(record, {
      table: String(body.table ?? ''),
      where: body.where ?? undefined,
      limit: body.limit ?? 50,
      columns: body.columns ?? undefined,
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.json({ ok: false, error: String((err as Error)?.message ?? err) })
  }
})

app.get('/api/miniapps/:id/datastore/tables', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  res.json({ tables: await listTables(record) })
})

app.post('/api/miniapps/:id/freeze', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  record.frozen = !record.frozen
  record.status = record.frozen ? 'frozen' : record.html ? 'ready' : 'draft'
  await saveRecord(record)
  res.json({ miniapp: summary(record) })
})

app.put('/api/miniapps/:id/messages', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const messages = Array.isArray(req.body?.messages) ? (req.body.messages as DeveloperChatMessage[]) : []
  record.messages = messages
  await saveRecord(record)
  res.json({ miniapp: summary(record) })
})

app.put('/api/miniapps/:id/live-messages', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const messages = Array.isArray(req.body?.messages) ? (req.body.messages as DeveloperChatMessage[]) : []
  record.liveMessages = messages
  await saveRecord(record)
  res.json({ miniapp: summary(record) })
})

// Skill settings — the DEV/default binding. The creator configures a skill's
// declared settings (credentials + non-secret config) for their own studio. This
// is the agent's own default binding; runtimes that import the agent override it
// with their own values via the runtime-scoped endpoint below. Secret values are
// written to the agent's secrets folder and never returned to the client.
app.post('/api/miniapps/:id/skills/:skillId/credentials', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const skill = (record.skills ?? []).find((s) => s.id === req.params.skillId)
  if (!skill) return res.status(404).json({ error: 'unknown skill' })
  if (!declaredSettings(skill).length) return res.status(400).json({ error: 'skill has no settings' })
  const values = (req.body?.values ?? {}) as Record<string, unknown>
  const ctx: SkillBindingContext = { record }
  const result = await writeSkillSettings(ctx, skill, values)
  skill.credentialsFilled = await settingsFilled(ctx, skill)
  await saveRecord(record)
  res.json({ ok: true, skillId: skill.id, credentialsFilled: skill.credentialsFilled, values: result.publicValues })
})

// Define-step concept interview: ask clarifying questions until the idea is a
// complete agent-native concept, then return name + goal (saved to the draft).
app.post('/api/miniapps/:id/define/clarify', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const history = (req.body?.history ?? []) as ChatTurn[]
  const context = typeof req.body?.context === 'string' ? req.body.context : ''
  const result = await clarifyConcept(history, context)
  const assistantText = result.ready ? `Got it — ${result.name ?? 'agent'}.` : result.question ?? 'Tell me a bit more?'
  record.defineMessages = [
    ...history.map((m, i) => ({
      id: `define-${i}-${m.role}`,
      role: m.role,
      content: m.content,
    })),
    {
      id: `define-${history.length}-assistant`,
      role: 'assistant',
      content: assistantText,
    },
  ]
  if (result.ready) {
    record.draft = { ...record.draft, name: result.name, goal: result.goal }
  }
  await saveRecord(record)
  res.json({ ...result, miniapp: summary(record) })
})

// --- Agent folder (filesystem-first capability model) ---
app.get('/api/miniapps/:id/agent/tree', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  await ensureSoul(record)
  res.json({ tree: listAgentTree(record.id) })
})

app.get('/api/miniapps/:id/agent/file', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const path = String(req.query.path ?? '')
  // Soul self-heals: seed it from Define (or migrate legacy instructions.md) on first read.
  if (path === 'soul.md') await ensureSoul(record)
  const content = await readAgentFile(record.id, path)
  if (content == null) return res.status(404).json({ error: 'no such file' })
  res.json({ path, content })
})

// Write/overwrite an agent file directly (e.g. editing instructions.md or a tool).
app.put('/api/miniapps/:id/agent/file', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const path = String(req.body?.path ?? '')
  const content = String(req.body?.content ?? '')
  if (!path) return res.status(400).json({ error: 'path is required' })
  await writeAgentFile(record.id, path, content)
  res.json({ ok: true, path })
})

// Test a tool file by running it in the sandbox (optional input via __INPUT__).
app.post('/api/miniapps/:id/agent/run-tool', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const path = String(req.body?.path ?? '')
  const code = await readAgentFile(record.id, path)
  if (code == null) return res.status(404).json({ error: 'no such file' })
  const input = req.body?.input ?? {}
  const wrapped = `globalThis.__INPUT__ = ${JSON.stringify(input)};\n${code}`
  const run = await getSandboxDriver().runCode(wrapped, { timeoutMs: 15_000 })
  res.json({ ok: run.ok, stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000), error: run.error })
})

// Skill-scoped chat: discuss/refine one skill, grounded in its contract.
app.post('/api/miniapps/:id/skills/:skillId/chat', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const history = (req.body?.history ?? []) as { role: 'user' | 'assistant'; content: string }[]
  const out = await chatAboutSkill(record, req.params.skillId, history)
  res.json(out)
})

// Surface-scoped chat: discuss/refine one surface, with the full agent context.
app.post('/api/miniapps/:id/surfaces/:surfaceId/chat', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const history = (req.body?.history ?? []) as { role: 'user' | 'assistant'; content: string }[]
  const out = await chatAboutSurface(record, req.params.surfaceId, history)
  res.json(out)
})

// Test one skill tool call by name — runs the SAME tool the runtime agent would
// call (built-in handler or custom script), with sample input + injected credentials.
app.post('/api/miniapps/:id/skills/:skillId/tools/:toolName/test', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const input = req.body?.input ?? {}
  try {
    const { Type } = await import('@earendil-works/pi-ai')
    const { makeRuntimeTools } = await import('./agent/skillTools.ts')
    const tool = (await makeRuntimeTools(Type as any, record)).find((t) => t.name === req.params.toolName)
    if (!tool) return res.status(404).json({ ok: false, error: `tool not active: ${req.params.toolName}` })
    const r: any = await tool.execute('test', { input, ...input })
    res.json({ ok: true, result: r?.details ?? null })
  } catch (err) {
    res.json({ ok: false, error: String((err as Error)?.message ?? err) })
  }
})

// Per-capability "refine with AI": rewrite one agent file from an instruction.
app.post('/api/miniapps/:id/agent/refine', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const path = String(req.body?.path ?? '')
  const instruction = String(req.body?.instruction ?? '')
  if (!path || !instruction) return res.status(400).json({ error: 'path and instruction are required' })
  res.json(await refineFile(record, path, instruction))
})

// The platform Skills Library (catalog).
app.get('/api/skills/library', async (_req, res) => {
  const visible = new Set(['gmail', 'github', 'http_request', 'database'])
  res.json({ skills: PLATFORM_SKILLS.filter((skill) => visible.has(skill.id)) })
})

// Analyse the app's goal and attach the planned skills (auto-add library matches,
// flag the gaps as needs_dev). Returns the full plan.
app.post('/api/miniapps/:id/skills/plan', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const result = await planAndAttachSkills(record)
  res.json(result)
})

// Build one missing (needs_dev) skill via the chosen method.
app.post('/api/miniapps/:id/skills/develop', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const skillId = String(req.body?.skillId ?? '')
  const method = String(req.body?.method ?? 'generate') as SkillDevelopMethod
  const input = (req.body?.input ?? {}) as Record<string, unknown>
  const result = await developSkill(record, skillId, method, input)
  res.json(result)
})

// Persist the guided-creation flow state (phase, draft identity, skills).
app.put('/api/miniapps/:id/flow', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const body = (req.body ?? {}) as Partial<Pick<MiniappRecord, 'creationPhase' | 'draft' | 'skills' | 'defineMessages'>>
  if (body.creationPhase) record.creationPhase = body.creationPhase
  if (body.draft) record.draft = { ...record.draft, ...body.draft }
  if (Array.isArray(body.skills)) record.skills = body.skills
  if (Array.isArray(body.defineMessages)) record.defineMessages = body.defineMessages
  await saveRecord(record)
  res.json({ miniapp: summary(record) })
})

app.post('/api/miniapps/:id/live-chat', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const history = (req.body?.history ?? []) as ChatTurn[]
  const agentRef: RuntimeAgentRef = {
    key: `own:${record.id}`,
    name: record.manifest?.name ?? record.draft?.name ?? record.id,
    source: 'own',
    miniappId: record.id,
  }
  const outcome = await runTerrRuntimeChat(record, history, {
    routing: decideTerrRuntimeRouting(1),
    agentSpecs: describeTerrRuntimeAgentSpecsForRuntime([agentRef], new Map([[record.id, record]])),
  })
  return res.json(outcome)
})

app.post('/api/miniapps/:id/canvas-screenshot-responses', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const requestId = String(req.body?.requestId ?? '')
  const imageUrl = typeof req.body?.imageUrl === 'string' ? req.body.imageUrl : ''
  const error = typeof req.body?.error === 'string' ? req.body.error : ''
  const ok = req.body?.ok === true && imageUrl.startsWith('data:image/')
  if (!requestId) return res.status(400).json({ error: 'requestId is required' })
  const resolved = resolveCanvasScreenshot(record.id, requestId, {
    ok,
    ...(ok ? { imageUrl } : {}),
    ...(!ok ? { error: error || 'Canvas screenshot failed.' } : {}),
  })
  res.json({ ok: resolved })
})

// Developer-agent chat: streams build progress as Server-Sent Events.
app.post('/api/miniapps/:id/chat', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const history = (req.body?.history ?? []) as ChatTurn[]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const emit = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  try {
    await runDeveloperAgent(record, history, emit)
  } catch (err) {
    emit({ type: 'error', message: String((err as Error)?.message ?? err) })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

// Host action handler. Called by the frontend host when the iframe posts an action
// through the bridge. Returns the new state so the host can push it to the frame.
async function runMiniappHostAction(record: MiniappRecord, actionId: string, payload: unknown) {
  if (actionId === SET_STATE_ACTION) {
    const patch = (payload as { patch?: unknown }).patch
    if (!isPlainObject(patch)) {
      return { ok: false, message: 'set_state requires an object patch.', state: record.state, stateVersion: record.stateVersion }
    }
    record.state = { ...record.state, ...patch }
    record.stateVersion += 1
    await saveRecord(record)
    return { ok: true, message: 'State updated.', state: record.state, stateVersion: record.stateVersion }
  }

  const action = record.manifest?.actions.find((a) => a.id === actionId)
  if (!action) {
    return { ok: false, message: `Unknown action: ${actionId}`, state: record.state, stateVersion: record.stateVersion }
  }

  if (action.kind === 'mutate_state') {
    const patch = (payload as { patch?: unknown }).patch
    if (!isPlainObject(patch)) {
      return { ok: false, message: 'This action requires an object patch.', state: record.state, stateVersion: record.stateVersion }
    }
    record.state = { ...record.state, ...patch }
    record.stateVersion += 1
    await saveRecord(record)
    return { ok: true, message: 'State updated.', state: record.state, stateVersion: record.stateVersion }
  }

  // kind: 'agent'. When invoked inside a runtime, the payload carries runtimeId so
  // skill settings/credentials resolve against this runtime's per-agent binding.
  const runtimeId = isPlainObject(payload) && typeof payload.runtimeId === 'string' ? payload.runtimeId : undefined
  const binding = runtimeId ? { runtimeId, agentKey: `own:${record.id}` } : undefined
  return await runTerrRuntimeAction(record, action, payload, binding)
}

app.post('/api/miniapps/:id/actions', async (req, res) => {
  const record = await loadRecord(req.params.id)
  if (!record) return res.status(404).json({ error: 'not found' })
  const actionId = String(req.body?.actionId ?? '')
  const payload = req.body?.payload ?? {}
  res.json(await runMiniappHostAction(record, actionId, payload))
})

/* ───────── Runtimes ─────────
 * A Runtime is a running home for one or more agents, backed by a real E2B
 * sandbox. Users chat with the runtime, view a hosted miniapp, and connect bots. */

const BOT_LABELS: Record<BotPlatform, string> = { slack: 'Slack', discord: 'Discord', lark: 'Lark' }

// Never send stored bot tokens to the client; expose only `hasToken`.
function publicRuntime(rt: RuntimeRecord): RuntimeRecord {
  return {
    ...rt,
    bots: rt.bots.map(({ token, ...b }) => ({ ...b, hasToken: !!token })),
  }
}

async function refreshRuntimeStatus(runtime: RuntimeRecord): Promise<RuntimeRecord> {
  if (runtime.sandboxKind !== 'e2b' || !runtime.sandboxId) return runtime
  const result = await getRuntimeSandboxStatus(runtime.sandboxId)
  if (runtime.status === result.status && (runtime.sandboxError ?? null) === (result.error ?? null)) return runtime
  const next = { ...runtime, status: result.status, sandboxError: result.error ?? null }
  await saveRuntime(next)
  return next
}

async function installRuntimeCommunityAgents(runtime: RuntimeRecord): Promise<RuntimeRecord> {
  if (runtime.sandboxKind !== 'e2b' || !runtime.sandboxId) return runtime
  let changed = false
  const originalAgents = runtime.agents.map(normalizeRuntimeAgentRef)
  const agents: RuntimeAgentRef[] = []
  for (const agent of originalAgents) {
    if (agent.source !== 'community') {
      agents.push(agent)
      continue
    }
    if (agent.installation?.status === 'ready') {
      agents.push(agent)
      continue
    }
    changed = true
    const installing: RuntimeAgentRef = {
      ...agent,
      installation: {
        ...agent.installation,
        status: 'installing',
        logs: [`${new Date().toISOString()} install queued`, ...(agent.installation?.logs ?? [])].slice(0, 8),
      },
    }
    agents.push(installing)
    runtime.agents = agents.concat(originalAgents.slice(agents.length))
    await saveRuntime(runtime)
    const installed = await installCommunityAgentInSandbox(runtime.sandboxId, installing)
    agents[agents.length - 1] = installed
  }
  if (!changed) return runtime
  runtime.agents = agents
  await saveRuntime(runtime)
  return runtime
}

app.get('/api/runtimes', async (req, res) => {
  const runtimes = await Promise.all((await listRuntimes(req.userId!)).map(refreshRuntimeStatus))
  res.json({ runtimes: runtimes.map(publicRuntime) })
})

app.get('/api/runtimes/:id', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  res.json({ runtime: publicRuntime(await refreshRuntimeStatus(runtime)) })
})

app.post('/api/runtimes/:id/diagnostics/network', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const result = await diagnoseRuntimeNetwork(runtime)
  if (!result.ok && result.error === 'Runtime is not backed by an E2B sandbox.') return res.status(400).json({ ...result, runtime: publicRuntime(runtime) })
  res.json(result)
})

app.post('/api/runtimes/:id/diagnostics/gmail', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const miniappId = typeof req.body?.miniappId === 'string' ? req.body.miniappId : ''
  const result = await diagnoseRuntimeGmail(runtime, miniappId)
  if (!result.ok && result.error === 'Runtime is not backed by an E2B sandbox.') return res.status(400).json({ ...result, runtime: publicRuntime(runtime) })
  if (!result.ok && result.error === 'Miniapp agent not found.') return res.status(404).json(result)
  res.json(result)
})

// Runtime-scoped miniapp action handler. This preserves the runtime identity for
// miniapps opened inside a runtime window; today it delegates to the same host
// action runner, and it is the correct hook for moving own-agent execution fully
// into the runtime sandbox.
app.post('/api/runtimes/:id/miniapps/:miniappId/actions', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'runtime not found' })
  if (!runtime.agents.some((agent) => agent.source === 'own' && agent.miniappId === req.params.miniappId)) {
    return res.status(403).json({ error: 'miniapp is not attached to this runtime' })
  }
  const record = await loadRecord(req.params.miniappId)
  if (!record) return res.status(404).json({ error: 'miniapp not found' })
  const actionId = String(req.body?.actionId ?? '')
  const payload = { ...(isPlainObject(req.body?.payload) ? req.body.payload : {}), runtimeId: runtime.id, sandboxId: runtime.sandboxId }
  res.json(await runMiniappHostAction(record, actionId, payload))
})

app.post('/api/runtimes', async (req, res) => {
  const name = String(req.body?.name ?? '')
  const agents = (Array.isArray(req.body?.agents) ? req.body.agents : []) as RuntimeAgentRef[]
  if (agents.length === 0) return res.status(400).json({ error: 'A runtime needs at least one agent.' })

  const runtime = await createRuntime(req.userId!, name, agents)
  res.json({ runtime: publicRuntime(runtime) })

  // Provision the real sandbox in the background; the client polls GET for status.
  void provisionRuntimeSandbox()
    .then(async (result) => {
      const fresh = await loadRuntime(runtime.id)
      if (!fresh) return
      fresh.sandboxKind = result.kind
      fresh.sandboxId = result.sandboxId
      fresh.sandboxError = result.error ?? null
      fresh.status = result.kind === 'e2b' ? 'running' : 'local'
      await saveRuntime(fresh)
      if (fresh.sandboxKind === 'e2b' && fresh.sandboxId) void installRuntimeCommunityAgents(fresh).catch(async (err) => {
        const latest = await loadRuntime(fresh.id)
        if (!latest) return
        latest.sandboxError = String((err as Error)?.message ?? err)
        await saveRuntime(latest)
      })
    })
    .catch(async (err) => {
      const fresh = await loadRuntime(runtime.id)
      if (!fresh) return
      fresh.status = 'error'
      fresh.sandboxError = String((err as Error)?.message ?? err)
      await saveRuntime(fresh)
    })
})

app.patch('/api/runtimes/:id', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const name = String(req.body?.name ?? '').trim()
  if (!name) return res.status(400).json({ error: 'Runtime name is required.' })
  runtime.name = name
  await saveRuntime(runtime)
  res.json({ runtime: publicRuntime(runtime) })
})

app.delete('/api/runtimes/:id', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  // Do not manually kill E2B sandboxes when a runtime is removed from the
  // local studio. E2B should auto-pause/expire them from their idle timeout so
  // we can reconnect by id during the timeout window and avoid destructive
  // cleanup as the default behavior.
  await deleteRuntime(req.params.id)
  res.json({ ok: true })
})

// Chat with a runtime. Single-agent runtimes use direct handoff. Multi-agent
// runtimes first pass through TerrRuntimeAgent for a lightweight routing /
// coordination decision, then hand off to the selected own or community agent.
app.post('/api/runtimes/:id/chat', async (req, res) => {
  const startedAt = Date.now()
  let runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const wantsStream = req.query.stream === '1' || String(req.headers.accept ?? '').includes('text/event-stream')
  const emit = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    emit({ type: 'status', text: 'Working with TerrRuntimeAgent…' })
  }
  if (runtime.sandboxKind === 'e2b' && runtime.sandboxId && runtime.agents.some((agent) => agent.source === 'community' && agent.installation?.status !== 'ready')) {
    runtime = await installRuntimeCommunityAgents(runtime)
  }
  const history = (req.body?.history ?? []) as ChatTurn[]

  const ownRecordsByMiniappId = new Map<string, MiniappRecord>()
  for (const agent of runtime.agents) {
    if (agent.source !== 'own' || !agent.miniappId) continue
    const record = await loadRecord(agent.miniappId)
    if (record) ownRecordsByMiniappId.set(agent.miniappId, record)
  }
  const routing = decideTerrRuntimeRouting(runtime.agents.length)
  const agentSpecs = describeTerrRuntimeAgentSpecsForRuntime(runtime.agents, ownRecordsByMiniappId)
  const route = routing.mode === 'direct' ? routeTerrRuntimeMessage(history, agentSpecs.slice(0, 1)) : routeTerrRuntimeMessage(history, agentSpecs)
  const selectedAgent = route.targetAgentKey ? runtime.agents.find((agent) => agent.key === route.targetAgentKey) : null
  const selectedRecord = selectedAgent?.source === 'own' && selectedAgent.miniappId ? ownRecordsByMiniappId.get(selectedAgent.miniappId) : null
  const sandboxId = runtime.sandboxKind === 'e2b' ? runtime.sandboxId : null

  let message: string
  let activities: DeveloperChatMessage['activities'] = []
  if (selectedRecord) {
    // A built own-agent: drive its real runtime agent (skills + soul). When the
    // runtime has an E2B sandbox, the model/tool-choice loop runs there and the
    // host only brokers declared tools + persistence.
    const outcome = await runTerrRuntimeChat(selectedRecord, history, {
      sandboxId,
      routing,
      agentSpecs,
      route,
      binding: { runtimeId: runtime.id, agentKey: selectedAgent!.key },
    })
    message = outcome.message
    activities = outcome.activities ?? []
  } else if (selectedAgent?.source === 'community') {
    const outcome = await runTerrRuntimeCommunityChat(selectedAgent, history, {
      sandboxId,
      routing,
      agentSpecs,
      route,
    })
    message = outcome.message
    activities = outcome.activities ?? []
  } else if (runtime.agents.length > 0) {
    const outcome = await runTerrRuntimeCoordinatorChat(history, {
      sandboxId,
      routing,
      agentSpecs,
      route,
    })
    message = outcome.message
    activities = outcome.activities ?? []
  } else {
    // No sandbox yet (still provisioning, or local fallback).
    const names = runtime.agents.map((a) => a.name).join(', ')
    message =
      runtime.status === 'provisioning'
        ? `The sandbox for ${names} is still starting up — try again in a moment.`
        : `This runtime hosts ${names}, but no E2B sandbox is available (running locally).`
  }

  // Persist the exchange on the runtime record.
  const userTurn = history.at(-1)
  const now = Date.now()
  const durationMs = now - startedAt
  if (userTurn?.role === 'user') {
    runtime.messages.push({ id: 'm-' + now.toString(36), role: 'user', content: userTurn.content })
  }
  runtime.messages.push({ id: 'a-' + now.toString(36), role: 'assistant', content: message, durationMs, activities })
  await saveRuntime(runtime)

  if (wantsStream) {
    for (const activity of activities) emit(activityToEvent(activity))
    for (const chunk of assistantChunks(message)) emit({ type: 'assistant', text: chunk })
    emit({ type: 'done', durationMs })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  res.json({ ok: true, message, activities, durationMs })
})

app.post('/api/runtimes/:id/agents', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const agent = req.body?.agent as RuntimeAgentRef | undefined
  if (!agent?.key || !agent?.name) return res.status(400).json({ error: 'agent { key, name } is required.' })
  if (!runtime.agents.some((a) => a.key === agent.key)) {
    runtime.agents.push(normalizeRuntimeAgentRef(agent))
    await saveRuntime(runtime)
    if (runtime.sandboxKind === 'e2b' && runtime.sandboxId) await installRuntimeCommunityAgents(runtime).catch(() => runtime)
  }
  res.json({ runtime: publicRuntime(runtime) })
})

app.patch('/api/runtimes/:id/agents/:key/model-config', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const key = req.params.key
  const agent = runtime.agents.find((a) => a.key === key)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  const body = req.body?.modelConfig
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'modelConfig is required.' })
  const mode = String((body as { mode?: unknown }).mode ?? agent.modelConfig?.mode ?? 'platform')
  if (!['platform', 'custom_llm_api', 'subscription_auth'].includes(mode)) return res.status(400).json({ error: 'unsupported model config mode.' })
  const customApiKey = typeof body.customApiKey === 'string' ? body.customApiKey.trim() : ''
  if (customApiKey) {
    const path = `secrets/${agent.key.replace(/[^a-zA-Z0-9._-]+/g, '_')}.model.json`
    await db.query(
      `insert into runtime_files (runtime_id, path, content, updated_at) values ($1, $2, $3, now())
       on conflict (runtime_id, path) do update set content = excluded.content, updated_at = now()`,
      [runtime.id, path, JSON.stringify({ customApiKey, updatedAt: new Date().toISOString() }, null, 2)],
    )
  }
  agent.modelConfig = {
    ...agent.modelConfig,
    mode: mode as 'platform' | 'custom_llm_api' | 'subscription_auth',
    platformModel: typeof body.platformModel === 'string' ? body.platformModel : agent.modelConfig?.platformModel,
    customEndpoint: mode === 'custom_llm_api' && typeof body.customEndpoint === 'string' ? body.customEndpoint : mode === 'custom_llm_api' ? agent.modelConfig?.customEndpoint : undefined,
    customApiKeySet: mode === 'custom_llm_api' ? Boolean(customApiKey || body.customApiKeySet || agent.modelConfig?.customApiKeySet || false) : false,
    subscriptionProvider: typeof body.subscriptionProvider === 'string' ? body.subscriptionProvider : agent.modelConfig?.subscriptionProvider,
    authStatus: typeof body.authStatus === 'string' ? body.authStatus : agent.modelConfig?.authStatus,
  }
  await saveRuntime(runtime)
  res.json({ runtime: publicRuntime(runtime) })
})

// List an own-agent's active skills and their settings status FOR THIS RUNTIME.
// Returns the declared settings (redacted: secret values are never sent, only a
// `filled` flag) plus the non-secret values bound for this runtime×agent.
app.get('/api/runtimes/:id/agents/:key/skills', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const agent = runtime.agents.find((a) => a.key === req.params.key)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (agent.source !== 'own' || !agent.miniappId) return res.json({ skills: [] })
  const record = await loadRecord(agent.miniappId)
  if (!record) return res.status(404).json({ error: 'miniapp not found' })
  const ctx: SkillBindingContext = { record, runtimeId: runtime.id, agentKey: agent.key }
  const skills = await Promise.all((record.skills ?? [])
    .filter((s) => s.status === 'active' && declaredSettings(s).length)
    .map(async (s) => {
      const resolved = await resolveSkillSettings(ctx, s)
      const filled = new Set(await settingsFilled(ctx, s))
      return {
        id: s.id,
        name: s.name,
        category: s.category,
        bindingKey: skillBindingKey(s),
        settings: declaredSettings(s).map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type ?? 'text',
          options: f.options,
          required: f.required,
          secret: !!f.secret,
          placeholder: f.placeholder,
          filled: filled.has(f.key),
          // Echo non-secret values only so the form can prefill.
          value: f.secret ? undefined : resolved.credentials[f.key],
        })),
      }
    }))
  res.json({ skills })
})

// Set a skill's settings for ONE agent in ONE runtime. Secret values land in the
// runtime's per-agent secrets file; non-secret values are stored on the runtime
// record binding. Neither touches the shared agent, so other runtimes/users keep
// their own configuration.
app.post('/api/runtimes/:id/agents/:key/skills/:skillId/credentials', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const agent = runtime.agents.find((a) => a.key === req.params.key)
  if (!agent) return res.status(404).json({ error: 'agent not found' })
  if (agent.source !== 'own' || !agent.miniappId) return res.status(400).json({ error: 'agent has no configurable skills' })
  const record = await loadRecord(agent.miniappId)
  if (!record) return res.status(404).json({ error: 'miniapp not found' })
  const skill = (record.skills ?? []).find((s) => s.id === req.params.skillId)
  if (!skill) return res.status(404).json({ error: 'unknown skill' })
  if (!declaredSettings(skill).length) return res.status(400).json({ error: 'skill has no settings' })

  const values = (req.body?.values ?? {}) as Record<string, unknown>
  const ctx: SkillBindingContext = { record, runtimeId: runtime.id, agentKey: agent.key }
  const result = await writeSkillSettings(ctx, skill, values)

  // Persist the non-secret binding + filled flags on the runtime record.
  const key = skillBindingKey(skill)
  const bindings = agent.bindings ?? (agent.bindings = {})
  const skills = bindings.skills ?? (bindings.skills = {})
  const prev = skills[key]?.config ?? {}
  skills[key] = { config: { ...prev, ...result.config }, secretsFilled: result.secretsFilled }
  await saveRuntime(runtime)

  res.json({ ok: true, agentKey: agent.key, skillId: skill.id, secretsFilled: await settingsFilled(ctx, skill), values: result.publicValues })
})

app.delete('/api/runtimes/:id/agents/:key', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  runtime.agents = runtime.agents.filter((a) => a.key !== req.params.key)
  await saveRuntime(runtime)
  res.json({ runtime: publicRuntime(runtime) })
})

app.post('/api/runtimes/:id/bots', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  const platform = String(req.body?.platform ?? '') as BotPlatform
  if (!BOT_LABELS[platform]) return res.status(400).json({ error: 'Unknown bot platform.' })
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''

  const bot: RuntimeBot = {
    id: 'bot-' + Math.random().toString(36).slice(2, 8),
    platform,
    label: String(req.body?.label ?? BOT_LABELS[platform]),
    connectedAt: new Date().toISOString(),
    ...(token ? { token } : {}),
  }
  runtime.bots.push(bot)
  await saveRuntime(runtime)
  res.json({ runtime: publicRuntime(runtime) })
})

app.delete('/api/runtimes/:id/bots/:botId', async (req, res) => {
  const runtime = await loadRuntime(req.params.id)
  if (!runtime) return res.status(404).json({ error: 'not found' })
  runtime.bots = runtime.bots.filter((b) => b.id !== req.params.botId)
  await saveRuntime(runtime)
  res.json({ runtime: publicRuntime(runtime) })
})

// ── Serve the built SPA (production single-service: API + frontend, same origin) ──
const frontendDist = process.env.FRONTEND_DIST || join(config.repoRoot, 'frontend', 'dist')
app.use(express.static(frontendDist))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  res.sendFile(join(frontendDist, 'index.html'))
})

async function start() {
  await db.init()
  app.listen(config.port, () => {
    console.log(`[terr-miniapp-3] backend on http://localhost:${config.port} (model: ${config.model})`)
    void startScheduler().catch((err) => console.error('[scheduler] failed to start', err))
  })
}
void start()
