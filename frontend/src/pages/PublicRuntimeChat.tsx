import { useEffect, useState } from 'react'
import { getPublicRuntime, streamPublicRuntimeChat, type PublicRuntime, type ChatTurn } from '@/lib/api'
import { BuildChat, applyBuildChatEvent } from '@/wizard/AgentCanvas'
import type { UiMessage } from '@/chat/ChatPanel'
import type { RuntimeAgentRef } from '@shared/protocol'

/**
 * Standalone, read-only chat for one runtime, reachable at /r/:id without login.
 * The owner shares the URL; visitors can only chat — no settings, no other UI.
 * Conversations are ephemeral (not persisted to the owner's transcript).
 */
export function PublicRuntimeChat({ id }: { id: string }) {
  const [runtime, setRuntime] = useState<PublicRuntime | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let alive = true
    getPublicRuntime(id)
      .then((rt) => alive && setRuntime(rt))
      .catch((e) => alive && setError(String((e as Error)?.message ?? e)))
    return () => { alive = false }
  }, [id])

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    const userMsg: UiMessage = { id: 'u-' + Date.now().toString(36), role: 'user', content: text }
    const history: ChatTurn[] = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    const assistantId = 'a-' + Date.now().toString(36)
    const assistantMsg: UiMessage = { id: assistantId, role: 'assistant', content: '', activities: [{ kind: 'status', text: 'Thinking…' }] }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    try {
      for await (const ev of streamPublicRuntimeChat(id, history)) {
        setMessages((prev) => applyBuildChatEvent(prev, assistantId, ev))
      }
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: String((err as Error)?.message ?? err), activities: [{ kind: 'error', text: 'Chat failed', ok: false }] } : m)))
    } finally {
      setSending(false)
    }
  }

  if (error) {
    return (
      <div className="dot-bg grid h-full w-full place-items-center p-6 text-center">
        <div>
          <div className="text-[15px] font-semibold text-ink">This runtime isn’t available</div>
          <div className="mt-1.5 text-[13px] text-ink-tertiary">{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="dot-bg flex h-full w-full flex-col items-center">
      <div className="flex min-h-0 w-full max-w-[760px] flex-1 flex-col px-3 sm:px-5">
        {/* Slim header — runtime identity only */}
        <header className="flex shrink-0 items-center gap-3 py-3.5">
          <span className="flex size-[34px] items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="size-[18px]">
              <rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" />
              <path d="M6 6h.01M6 18h.01" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold tracking-tight text-ink">{runtime?.name ?? 'Runtime'}</div>
            <div className="truncate text-[11.5px] text-ink-tertiary">
              {runtime ? `${runtime.agents.length} agent${runtime.agents.length === 1 ? '' : 's'} · powered by Cirrus` : 'Loading…'}
            </div>
          </div>
        </header>
        {/* Chat fills the rest; rounded surface so it reads as a self-contained app */}
        <div className="mb-4 flex min-h-0 flex-1 overflow-hidden rounded-[18px] border border-border bg-surface/70 shadow-[0_18px_50px_-24px_rgba(25,25,23,0.28)] backdrop-blur-xl">
          <BuildChat
            title=""
            placeholder={`Message ${runtime?.name ?? 'this runtime'}…`}
            empty="Say hello — this runtime will respond."
            messages={messages}
            building={sending}
            loading={!runtime}
            onSend={send}
            mentionAgents={(runtime?.agents ?? []) as RuntimeAgentRef[]}
          />
        </div>
      </div>
    </div>
  )
}
