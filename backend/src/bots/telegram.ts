// Telegram inbound listener. For every runtime that has a connected Telegram bot
// (a stored bot token), we long-poll getUpdates and route each incoming message
// through the same executeRuntimeTurn path the web chat uses, then send the reply
// back with sendMessage. No public URL needed (long-poll, works locally + prod).
//
// Tokens live only on the runtime record (Postgres) — never logged or committed.
import { listAllRuntimes, loadRuntime } from '../runtimeStore.ts'
import { executeRuntimeTurn } from '../agent/runtimeTurn.ts'
import type { ChatTurn } from '../agent/developerAgent.ts'
import type { RuntimeRecord } from '../../../shared/protocol.ts'

const API = 'https://api.telegram.org'

async function tg(token: string, method: string, body?: unknown, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

interface Poller {
  botId: string
  runtimeId: string
  stop: () => void
}

const pollers = new Map<string, Poller>() // key: botId

/** Last ~20 turns of the runtime's shared conversation as context for the agent. */
function historyFromRuntime(runtime: RuntimeRecord, userText: string): ChatTurn[] {
  const prior: ChatTurn[] = (runtime.messages ?? [])
    .slice(-20)
    .filter((m) => (m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: m.content }))
  return [...prior, { role: 'user', content: userText }]
}

async function handleIncoming(runtimeId: string, token: string, chatId: number, userText: string): Promise<void> {
  // Reload fresh so we build on the latest persisted conversation.
  const runtime = await loadRuntime(runtimeId)
  if (!runtime) return
  void tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})

  let reply = ''
  let posts: string[] = []
  let choices: { label: string }[] = []
  try {
    const out = await executeRuntimeTurn(runtime, historyFromRuntime(runtime, userText), { persist: true, idPrefix: 'tg' })
    reply = out.message
    posts = out.posts ?? []
    choices = out.ui?.choices ?? []
  } catch (err) {
    reply = `Sorry — I hit an error: ${String((err as Error)?.message ?? err)}`
  }

  // Mid-turn posts each as their own message, then the final reply with any
  // quick-reply choices rendered as a one-time keyboard (tapping sends the label).
  for (const post of posts) {
    if (post.trim()) await tg(token, 'sendMessage', { chat_id: chatId, text: post }).catch(() => {})
  }
  const text = reply.trim() || (posts.length ? '' : 'Done.')
  if (text) {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(choices.length
        ? { reply_markup: { keyboard: choices.map((c) => [{ text: c.label }]), one_time_keyboard: true, resize_keyboard: true } }
        : {}),
    }).catch(() => {})
  }
}

function startPoller(botId: string, runtimeId: string, token: string): Poller {
  let stopped = false
  let offset = 0

  const loop = async () => {
    // Skip any backlog accumulated while we weren't listening — only handle
    // messages sent from now on (confirm them by advancing the offset).
    try {
      const drained = await tg(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] }, 10000)
      if (drained?.ok && Array.isArray(drained.result) && drained.result.length) {
        offset = drained.result[drained.result.length - 1].update_id + 1
      } else if (drained && drained.ok === false) {
        console.warn(`[telegram] bot ${botId} getMe/getUpdates rejected (bad token?) — stopping poller`)
        return
      }
    } catch {
      /* transient — fall through to the poll loop */
    }

    while (!stopped) {
      let updates: any
      try {
        updates = await tg(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 40000)
      } catch {
        if (stopped) break
        await new Promise((r) => setTimeout(r, 2000)) // backoff on network error/abort
        continue
      }
      if (stopped) break
      if (!updates?.ok) {
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      for (const u of updates.result ?? []) {
        offset = u.update_id + 1
        const msg = u.message
        const text: string | undefined = msg?.text
        const chatId: number | undefined = msg?.chat?.id
        if (!text || chatId == null) continue
        try {
          await handleIncoming(runtimeId, token, chatId, text)
        } catch (err) {
          console.error(`[telegram] bot ${botId} handler failed:`, String((err as Error)?.message ?? err))
        }
        if (stopped) break
      }
    }
  }

  void loop()
  return { botId, runtimeId, stop: () => { stopped = true } }
}

/** Start/stop pollers so there's exactly one per connected Telegram bot. */
export async function reconcileTelegramListeners(): Promise<void> {
  let runtimes: RuntimeRecord[]
  try {
    runtimes = await listAllRuntimes()
  } catch {
    return
  }
  const wanted = new Map<string, { runtimeId: string; token: string }>()
  for (const rt of runtimes) {
    for (const bot of rt.bots ?? []) {
      if (bot.platform === 'telegram' && bot.token) wanted.set(bot.id, { runtimeId: rt.id, token: bot.token })
    }
  }
  // Stop pollers whose bot was removed.
  for (const [botId, poller] of pollers) {
    if (!wanted.has(botId)) {
      poller.stop()
      pollers.delete(botId)
      console.log(`[telegram] stopped poller for bot ${botId}`)
    }
  }
  // Start pollers for newly connected bots.
  for (const [botId, { runtimeId, token }] of wanted) {
    if (pollers.has(botId)) continue
    pollers.set(botId, startPoller(botId, runtimeId, token))
    console.log(`[telegram] listening for bot ${botId} on runtime ${runtimeId}`)
  }
}

let supervisorStarted = false

/** Boot the supervisor: reconcile now and every 15s thereafter. */
export function startTelegramListeners(): void {
  if (supervisorStarted) return
  supervisorStarted = true
  void reconcileTelegramListeners()
  setInterval(() => void reconcileTelegramListeners(), 15000)
}
