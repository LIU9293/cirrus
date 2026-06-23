import { config } from '../config.ts'
import { runInRuntimeSandbox } from '../sandbox/runtimeSandbox.ts'
import { makeRuntimeTools, type RuntimeMessageUi, type RuntimeToolActivity } from './skillTools.ts'
import type { ChatTurn } from './developerAgent.ts'
import type { DeveloperChatActivity, MiniappRecord } from '../../../shared/protocol.ts'

export interface SandboxAgentResult {
  ok: boolean
  reply: string
  ranInSandbox: boolean
  sandboxHost?: string
  error?: string
}

export interface SandboxRuntimeAgentResult {
  message: string
  patched: boolean
  activities: DeveloperChatActivity[]
  ranInSandbox: boolean
  sandboxHost?: string
  error?: string
  ui?: RuntimeMessageUi
}

type SandboxToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type SandboxStepResult = {
  ok: boolean
  host?: string
  content?: string
  tool_calls?: SandboxToolCall[]
  error?: string
}

/**
 * Run an agent's reasoning turn *inside* the runtime's own E2B sandbox.
 *
 * This is what makes a community agent (e.g. Hermes) genuinely "live" in the
 * runtime: we ship a small program into the sandbox that calls the model from
 * there and prints the reply. The orchestration call physically executes on the
 * sandbox box — we even read back its hostname as proof it ran remotely.
 */
export async function runAgentInSandbox(
  sandboxId: string,
  systemPrompt: string,
  history: ChatTurn[],
): Promise<SandboxAgentResult> {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((t) => ({ role: t.role, content: t.content })),
  ]
  const payload = { model: config.model, messages, max_completion_tokens: 800 }
  const endpoint = config.baseURL.replace(/\/$/, '') + '/chat/completions'

  // Program executed inside the sandbox. Uses global fetch (Node 18+/Deno) and
  // reports the sandbox hostname so the caller can prove it ran remotely.
  // The E2B JS kernel is a PERSISTENT REPL, so we wrap everything in an awaited
  // IIFE — otherwise top-level `const`/`let` would redeclare and fail on the
  // second turn in the same sandbox.
  const code = [
    `await (async () => {`,
    `  const KEY = ${JSON.stringify(config.apiKey)};`,
    `  const ENDPOINT = ${JSON.stringify(endpoint)};`,
    `  const PAYLOAD = ${JSON.stringify(payload)};`,
    `  let host = '';`,
    `  try { host = (await import('node:os')).hostname(); } catch {}`,
    `  try {`,
    `    const res = await fetch(ENDPOINT, {`,
    `      method: 'POST',`,
    `      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },`,
    `      body: JSON.stringify(PAYLOAD),`,
    `    });`,
    `    const data = await res.json();`,
    `    const reply = data?.choices?.[0]?.message?.content ?? '';`,
    `    console.log(JSON.stringify({ ok: true, reply, host }));`,
    `  } catch (err) {`,
    `    console.log(JSON.stringify({ ok: false, error: String(err && err.message || err), host }));`,
    `  }`,
    `})();`,
  ].join('\n')

  const out = await runInRuntimeSandbox(sandboxId, code, { timeoutMs: 90_000 })
  if (!out.ok) {
    return { ok: false, reply: '', ranInSandbox: false, error: out.error ?? (out.stderr || 'Sandbox execution failed.') }
  }
  const line = out.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { ok: boolean; reply?: string; error?: string; host?: string }
    if (!parsed.ok) return { ok: false, reply: '', ranInSandbox: true, sandboxHost: parsed.host, error: parsed.error }
    return { ok: true, reply: parsed.reply ?? '', ranInSandbox: true, sandboxHost: parsed.host }
  } catch {
    return { ok: false, reply: '', ranInSandbox: true, error: `Unparseable sandbox output: ${out.stdout.slice(0, 500)}` }
  }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { input: parsed }
}

function toolContent(result: unknown): string {
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
    const text = content?.find((part) => part?.type === 'text')?.text
    if (typeof text === 'string') return text
  }
  return JSON.stringify(result ?? null)
}

function mapActivity(activity: RuntimeToolActivity): DeveloperChatActivity | null {
  if (activity.kind === 'call') return { kind: 'tool', text: activity.summary }
  if (!activity.ok) return { kind: 'error', text: `${activity.name} failed${activity.detail ? `: ${activity.detail}` : ''}`, ok: false }
  return null
}

async function runSandboxModelStep(
  sandboxId: string,
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
): Promise<SandboxStepResult> {
  const endpoint = config.baseURL.replace(/\/$/, '') + '/chat/completions'
  const payload = {
    model: config.model,
    messages,
    tools,
    tool_choice: 'auto',
    max_completion_tokens: 1200,
  }

  const code = [
    `await (async () => {`,
    `  const KEY = ${JSON.stringify(config.apiKey)};`,
    `  const ENDPOINT = ${JSON.stringify(endpoint)};`,
    `  const PAYLOAD = ${JSON.stringify(payload)};`,
    `  let host = '';`,
    `  try { host = (await import('node:os')).hostname(); } catch {}`,
    `  try {`,
    `    const res = await fetch(ENDPOINT, {`,
    `      method: 'POST',`,
    `      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },`,
    `      body: JSON.stringify(PAYLOAD),`,
    `    });`,
    `    const data = await res.json();`,
    `    if (!res.ok) { console.log(JSON.stringify({ ok: false, host, error: JSON.stringify(data).slice(0, 1000) })); return; }`,
    `    const msg = data?.choices?.[0]?.message ?? {};`,
    `    console.log(JSON.stringify({ ok: true, host, content: msg.content ?? '', tool_calls: msg.tool_calls ?? [] }));`,
    `  } catch (err) {`,
    `    console.log(JSON.stringify({ ok: false, host, error: String(err && err.message || err) }));`,
    `  }`,
    `})();`,
  ].join('\n')

  const out = await runInRuntimeSandbox(sandboxId, code, { timeoutMs: 90_000 })
  if (!out.ok) return { ok: false, error: out.error ?? (out.stderr || 'Sandbox model step failed.') }
  const line = out.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    return JSON.parse(line) as SandboxStepResult
  } catch {
    return { ok: false, error: `Unparseable sandbox output: ${out.stdout.slice(0, 500)}` }
  }
}

export async function runRuntimeAgentLoopInSandbox(
  record: MiniappRecord,
  sandboxId: string,
  system: string,
  history: ChatTurn[],
  binding?: { runtimeId?: string; agentKey?: string },
): Promise<SandboxRuntimeAgentResult> {
  const activities: DeveloperChatActivity[] = [{ kind: 'status', text: 'Running CirrusRuntimeAgent loop in E2B sandbox…' }]
  const userTurn = history.at(-1)
  if (!userTurn || userTurn.role !== 'user') {
    return { message: '', patched: false, activities, ranInSandbox: false, error: 'Missing user turn.' }
  }

  const [{ Type }] = await Promise.all([import('@earendil-works/pi-ai')])
  const ui: RuntimeMessageUi = {}
  const runtimeTools = await makeRuntimeTools(Type as any, record, { record, ...binding }, {
    ui,
    onActivity: (activity) => {
      const mapped = mapActivity(activity)
      if (mapped) activities.push(mapped)
    },
  })
  const toolMap = new Map(runtimeTools.map((tool) => [tool.name, tool]))
  const tools = runtimeTools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.label || tool.name,
      parameters: (tool as any).parameters ?? { type: 'object', properties: {} },
    },
  }))

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: system },
    ...history.slice(0, -1).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: userTurn.content },
  ]
  const before = record.stateVersion
  let finalText = ''
  let sandboxHost: string | undefined
  let reportedHost = false

  for (let i = 0; i < 8; i += 1) {
    const step = await runSandboxModelStep(sandboxId, messages, tools)
    sandboxHost = step.host ?? sandboxHost
    if (sandboxHost && !reportedHost) {
      activities.push({ kind: 'status', text: `Sandbox host: ${sandboxHost}` })
      reportedHost = true
    }
    if (!step.ok) {
      return {
        message: `Sandbox agent failed: ${step.error ?? 'unknown error'}`,
        patched: record.stateVersion > before,
        activities,
        ranInSandbox: !!step.host,
        sandboxHost,
        error: step.error,
      }
    }

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    finalText = (step.content ?? '').trim() || finalText
    messages.push({
      role: 'assistant',
      content: step.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    })

    if (!toolCalls.length) {
      return {
        message: finalText,
        patched: record.stateVersion > before,
        activities,
        ranInSandbox: true,
        sandboxHost,
        ui,
      }
    }

    for (const call of toolCalls) {
      const tool = toolMap.get(call.function.name)
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `Tool not active: ${call.function.name}` }) })
        continue
      }
      try {
        const args = parseToolArgs(call.function.arguments)
        const result = await tool.execute(call.id, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent(result).slice(0, 20000) })
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
        })
      }
    }

    // ask_user ends the turn so the user can reply (the sandbox loop doesn't
    // honor the tool's terminate flag, so handle it explicitly).
    if (ui.choices) {
      return {
        message: finalText || ui.question || '',
        patched: record.stateVersion > before,
        activities,
        ranInSandbox: true,
        sandboxHost,
        ui,
      }
    }
  }

  return {
    message: finalText || 'Sandbox agent stopped after the maximum tool iterations.',
    patched: record.stateVersion > before,
    activities,
    ranInSandbox: true,
    sandboxHost,
    ui,
  }
}
