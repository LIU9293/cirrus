import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, ChevronDown, Code2, Play, Trash2, ListChecks } from 'lucide-react'
import type { CanvasElementSelection, MiniappRecord } from '@shared/protocol'
import {
  createMiniapp,
  deleteMiniapp,
  freezeMiniapp,
  getMiniapp,
  listMiniapps,
  saveFlow,
  saveMiniappMessages,
  saveMiniappLiveMessages,
  sendLiveChat,
  submitCanvasScreenshotResponse,
  streamChat,
  type AgentEvent,
  type ChatTurn,
} from '@/lib/api'
import { ChatPanel, type UiMessage } from '@/chat/ChatPanel'
import { MiniappCanvas, type MiniappCanvasHandle } from '@/canvas/MiniappCanvas'
import { CreationWizard, type WizardFlowUpdate } from '@/wizard/CreationWizard'
import { AgentCanvas, MyAgentsPage, CommunityPage, RuntimesPage, type NavView } from '@/wizard/AgentCanvas'

export type StudioMode = 'dev' | 'live'

export interface CanvasSelectionAttachment {
  selection: CanvasElementSelection
  imageUrl: string
}

let seq = 0
const nextId = () => `m${Date.now()}-${seq++}`

export function App() {
  const [miniapp, setMiniapp] = useState<MiniappRecord | null>(null)
  const [list, setList] = useState<(MiniappRecord & { hasHtml: boolean })[]>([])
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [liveMessages, setLiveMessages] = useState<UiMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [liveStreaming, setLiveStreaming] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [view, setView] = useState<NavView>('flow')
  const [mode, setMode] = useState<StudioMode>('dev')
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const [selectingElement, setSelectingElement] = useState(false)
  const [selectionAttachment, setSelectionAttachment] = useState<CanvasSelectionAttachment | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<MiniappCanvasHandle | null>(null)
  const messagesHydratedForRef = useRef<string | null>(null)
  const messagesRef = useRef<UiMessage[]>([])
  const liveMessagesRef = useRef<UiMessage[]>([])
  messagesRef.current = messages
  liveMessagesRef.current = liveMessages

  const setActiveMiniapp = useCallback((record: MiniappRecord) => {
    messagesHydratedForRef.current = record.id
    setMiniapp(record)
    setMessages(record.messages ?? [])
    setLiveMessages(record.liveMessages ?? [])
    setSelectingElement(false)
    setSelectionAttachment(null)
  }, [])

  const refreshList = useCallback(async () => {
    try {
      setList(await listMiniapps())
    } catch {
      // backend may still be starting
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await refreshList()
      const existing = await listMiniapps().catch(() => [])
      if (existing.length > 0) {
        setActiveMiniapp(await getMiniapp(existing[0].id))
      } else {
        setActiveMiniapp(await createMiniapp())
      }
    })()
  }, [refreshList, setActiveMiniapp])

  useEffect(() => {
    if (!miniapp || messagesHydratedForRef.current !== miniapp.id) return
    const timeout = window.setTimeout(() => {
      void saveMiniappMessages(miniapp.id, messages).catch(() => {
        /* keep local chat usable if the backend is temporarily unavailable */
      })
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [messages, miniapp])

  useEffect(() => {
    if (!miniapp || messagesHydratedForRef.current !== miniapp.id) return
    const timeout = window.setTimeout(() => {
      void saveMiniappLiveMessages(miniapp.id, liveMessages).catch(() => {
        /* keep local live chat usable if the backend is temporarily unavailable */
      })
    }, 150)
    return () => window.clearTimeout(timeout)
  }, [liveMessages, miniapp])

  useEffect(() => {
    if (mode === 'live') setSelectingElement(false)
  }, [mode])

  const handleNew = useCallback(async () => {
    const created = await createMiniapp()
    setActiveMiniapp(created)
    setPickerOpen(false)
    void refreshList()
  }, [refreshList, setActiveMiniapp])

  const handleSwitch = useCallback(async (id: string) => {
    setPickerOpen(false)
    setActiveMiniapp(await getMiniapp(id))
  }, [setActiveMiniapp])

  const openAgent = useCallback(async (id: string) => {
    setActiveMiniapp(await getMiniapp(id))
    setView('flow')
  }, [setActiveMiniapp])

  const newAgent = useCallback(async () => {
    setActiveMiniapp(await createMiniapp())
    setView('flow')
    void refreshList()
  }, [refreshList, setActiveMiniapp])

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteMiniapp(id)
      const nextList = await listMiniapps()
      setList(nextList)

      if (miniapp?.id === id) {
        const next = nextList[0] ? await getMiniapp(nextList[0].id) : await createMiniapp()
        setActiveMiniapp(next)
        if (nextList.length === 0) void refreshList()
      }
    },
    [miniapp?.id, refreshList, setActiveMiniapp],
  )

  const handleState = useCallback((state: Record<string, unknown>, version: number) => {
    setMiniapp((prev) => (prev ? { ...prev, state, stateVersion: version } : prev))
  }, [])

  const updateFlow = useCallback(
    (partial: WizardFlowUpdate) => {
      if (!miniapp) return
      const id = miniapp.id
      setMiniapp((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              ...partial,
              draft: partial.draft ? { ...prev.draft, ...partial.draft } : prev.draft,
            }
          : prev,
      )
      void saveFlow(id, partial).catch(() => {
        /* keep the wizard usable if the backend is temporarily unavailable */
      })
      void refreshList()
    },
    [miniapp, refreshList],
  )

  const handleFreeze = useCallback(async () => {
    if (!miniapp) return
    const id = miniapp.id
    try {
      const updated = await freezeMiniapp(id)
      setMiniapp((prev) => (prev && prev.id === id ? { ...prev, frozen: updated.frozen, status: updated.status } : prev))
      void refreshList()
    } catch {
      /* ignore */
    }
  }, [miniapp, refreshList])

  const handleToggleElementSelect = useCallback(() => {
    if (!miniapp?.html) return
    setMode('dev')
    setSelectingElement((value) => !value)
  }, [miniapp?.html])

  const handleElementSelected = useCallback((selection: CanvasElementSelection) => {
    setSelectingElement(false)
    setMode('dev')
    setSelectionAttachment({
      selection,
      imageUrl: selection.imageUrl ?? makeSelectionPreview(selection),
    })
  }, [])

  const getResizeBounds = useCallback(() => {
    const total = shellRef.current?.getBoundingClientRect().width ?? 0
    const minChat = Math.min(360, Math.max(260, total * 0.32))
    const minCanvas = Math.min(440, Math.max(320, total * 0.34))
    const maxChat = Math.max(minChat, total - minCanvas)
    return { minChat, maxChat }
  }, [])

  const resizeChatTo = useCallback(
    (clientX: number) => {
      const shell = shellRef.current
      if (!shell) return
      const rect = shell.getBoundingClientRect()
      const { minChat, maxChat } = getResizeBounds()
      const next = Math.min(maxChat, Math.max(minChat, clientX - rect.left))
      setChatWidth(next)
    },
    [getResizeBounds],
  )

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      setResizing(true)
      resizeChatTo(event.clientX)
    },
    [resizeChatTo],
  )

  useEffect(() => {
    if (!resizing) return

    const handlePointerMove = (event: PointerEvent) => resizeChatTo(event.clientX)
    const handlePointerUp = () => setResizing(false)
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [resizeChatTo, resizing])

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const { minChat, maxChat } = getResizeBounds()
      const current = chatWidth ?? shellRef.current?.getBoundingClientRect().width ?? 0
      if (event.key === 'Home') {
        setChatWidth(minChat)
        return
      }
      if (event.key === 'End') {
        setChatWidth(maxChat)
        return
      }
      const delta = event.shiftKey ? 80 : 24
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const renderedChatWidth =
        shellRef.current?.firstElementChild instanceof HTMLElement
          ? shellRef.current.firstElementChild.getBoundingClientRect().width
          : current
      setChatWidth(Math.min(maxChat, Math.max(minChat, renderedChatWidth + direction * delta)))
    },
    [chatWidth, getResizeBounds],
  )

  const handleSend = useCallback(
    async (text: string, agentContentOverride?: string) => {
      if (!miniapp || streaming) return
      const id = miniapp.id
      const baseAgentContent = agentContentOverride ?? text
      const textForAgent = selectionAttachment ? withSelectionContext(baseAgentContent, selectionAttachment.selection) : baseAgentContent
      const userMsg: UiMessage = {
        id: nextId(),
        role: 'user',
        content: text,
        ...(selectionAttachment
          ? {
              agentContent: textForAgent,
              selectionAttachment: {
                imageUrl: selectionAttachment.imageUrl,
                label: selectionAttachment.selection.label,
              },
            }
          : {}),
      }
      const asstMsg: UiMessage = { id: nextId(), role: 'assistant', content: '', activities: [] }
      const priorTurns: ChatTurn[] = messagesRef.current
        .filter((m) => (m.agentContent ?? m.content).trim())
        .map((m) => ({ role: m.role, content: m.agentContent ?? m.content }))
      const history: ChatTurn[] = [...priorTurns, { role: 'user', content: textForAgent }]

      setMessages((prev) => [...prev, userMsg, asstMsg])
      setSelectionAttachment(null)
      setStreaming(true)
      try {
        for await (const ev of streamChat(id, history)) {
          setMessages((prev) => applyEvent(prev, asstMsg.id, ev))
          if (ev.type === 'canvas_screenshot_request') {
            try {
              const imageUrl = await canvasRef.current?.captureScreenshot()
              if (!imageUrl) throw new Error('Canvas is not ready.')
              await submitCanvasScreenshotResponse(id, ev.requestId, { ok: true, imageUrl })
            } catch (err) {
              await submitCanvasScreenshotResponse(id, ev.requestId, {
                ok: false,
                error: String((err as Error)?.message ?? err),
              }).catch(() => {
                /* backend may have timed out */
              })
            }
          }
          if (ev.type === 'record') setMiniapp(ev.record)
        }
      } catch (err) {
        setMessages((prev) => applyEvent(prev, asstMsg.id, { type: 'error', message: String((err as Error)?.message ?? err) }))
      } finally {
        setStreaming(false)
        void saveMiniappMessages(id, messagesRef.current).catch(() => {
          /* keep local chat usable if the backend is temporarily unavailable */
        })
        try {
          setMiniapp(await getMiniapp(id))
        } catch {
          /* ignore */
        }
        void refreshList()
      }
    },
    [miniapp, streaming, refreshList, selectionAttachment],
  )

  const handleLiveSend = useCallback(
    async (text: string) => {
      if (!miniapp || liveStreaming) return
      const id = miniapp.id
      const userMsg: UiMessage = { id: nextId(), role: 'user', content: text }
      const asstMsg: UiMessage = { id: nextId(), role: 'assistant', content: '' }
      const priorTurns: ChatTurn[] = liveMessagesRef.current
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }))
      const history: ChatTurn[] = [...priorTurns, { role: 'user', content: text }]
      const pendingMessages = [...liveMessagesRef.current, userMsg, asstMsg]

      setLiveMessages(pendingMessages)
      setLiveStreaming(true)
      try {
        const outcome = await sendLiveChat(id, history)
        const finalMessages = pendingMessages.map((m) =>
          m.id === asstMsg.id ? { ...m, content: outcome.message } : m,
        )
        setLiveMessages(finalMessages)
        setMiniapp((prev) =>
          prev && prev.id === id ? { ...prev, state: outcome.state, stateVersion: outcome.stateVersion } : prev,
        )
        void saveMiniappLiveMessages(id, finalMessages).catch(() => {
          /* keep local live chat usable if the backend is temporarily unavailable */
        })
      } catch (err) {
        const finalMessages = pendingMessages.map((m) =>
          m.id === asstMsg.id ? { ...m, content: String((err as Error)?.message ?? err) } : m,
        )
        setLiveMessages(finalMessages)
      } finally {
        setLiveStreaming(false)
      }
    },
    [miniapp, liveStreaming],
  )

  // Top-level navigation (menu → My Agents / VMs / Community; else the agent flow).
  if (view === 'agents') {
    return <MyAgentsPage agents={list} onOpen={openAgent} onNew={newAgent} onRemove={handleDelete} onNavigate={setView} />
  }
  if (view === 'vms') return <RuntimesPage agents={list} onNavigate={setView} />
  if (view === 'community') return <CommunityPage onNavigate={setView} />
  if (miniapp) {
    return (
      <AgentCanvas
        miniapp={miniapp}
        onUpdateFlow={updateFlow}
        onNavigate={setView}
        onBuild={handleSend}
        buildMessages={messages}
        building={streaming}
        canvasRef={canvasRef}
        onState={handleState}
        onLiveSend={handleLiveSend}
        liveMessages={liveMessages}
        liveStreaming={liveStreaming}
        selectingElement={selectingElement}
        selectedElement={selectionAttachment?.selection ?? null}
        onToggleElementSelect={handleToggleElementSelect}
        onElementSelected={handleElementSelected}
        onClearSelection={() => setSelectionAttachment(null)}
      />
    )
  }
  // Legacy full-screen studio kept for reference (app canvas edit/preview now lives
  // in the Surface · Mini App panel inside the flow).
  void CreationWizard

  return <div className="dot-bg grid h-full w-full place-items-center text-sm text-muted-foreground">Loading…</div>

}

function applyEvent(messages: UiMessage[], asstId: string, ev: AgentEvent): UiMessage[] {
  return messages.map((m) => {
    if (m.id !== asstId) return m
    const activities = m.activities ? [...m.activities] : []
    switch (ev.type) {
      case 'status':
        activities.push({ kind: 'status', text: ev.text })
        return { ...m, activities }
      case 'assistant':
        return { ...m, content: m.content ? `${m.content}\n\n${ev.text}` : ev.text }
      case 'canvas_screenshot_request':
        activities.push({ kind: 'tool', text: 'Capturing canvas screenshot for visual review' })
        return { ...m, activities }
      case 'tool_call':
        activities.push({ kind: 'tool', text: ev.summary })
        return { ...m, activities }
      case 'tool_result':
        if (!ev.ok) activities.push({ kind: 'error', text: `${ev.name} failed${ev.detail ? `: ${ev.detail}` : ''}`, ok: false })
        return { ...m, activities }
      case 'build':
        activities.push({ kind: 'build', ok: ev.ok, text: ev.ok ? 'Build succeeded' : `Build failed: ${truncate(ev.error)}` })
        return { ...m, activities }
      case 'error':
        activities.push({ kind: 'error', text: ev.message, ok: false })
        return { ...m, activities }
      default:
        return m
    }
  })
}

function truncate(s?: string, n = 160) {
  if (!s) return 'unknown error'
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function withSelectionContext(text: string, selection: CanvasElementSelection) {
  return [
    text,
    '',
    '<selected_canvas_element>',
    `Label: ${selection.label}`,
    `Selector: ${selection.selector}`,
    `Tag: ${selection.tagName}`,
    selection.id ? `ID: ${selection.id}` : '',
    selection.className ? `Classes: ${selection.className}` : '',
    selection.role ? `Role: ${selection.role}` : '',
    selection.ariaLabel ? `ARIA label: ${selection.ariaLabel}` : '',
    selection.text ? `Visible text: ${selection.text}` : '',
    `Bounds: x=${Math.round(selection.rect.x)}, y=${Math.round(selection.rect.y)}, width=${Math.round(selection.rect.width)}, height=${Math.round(selection.rect.height)} in viewport ${Math.round(selection.viewport.width)}x${Math.round(selection.viewport.height)}`,
    '</selected_canvas_element>',
    'Use this selected element as the target area for the requested modification. Preserve unrelated behavior unless the user asks otherwise.',
  ]
    .filter(Boolean)
    .join('\n')
}

function makeSelectionPreview(selection: CanvasElementSelection) {
  const width = 360
  const height = 180
  const scale = Math.min(width / Math.max(selection.viewport.width, 1), height / Math.max(selection.viewport.height, 1))
  const rect = {
    x: Math.max(8, selection.rect.x * scale),
    y: Math.max(8, selection.rect.y * scale),
    width: Math.max(12, selection.rect.width * scale),
    height: Math.max(12, selection.rect.height * scale),
  }
  const label = (selection.label || selection.selector || selection.tagName).slice(0, 42)
  const clippedWidth = Math.max(12, Math.min(rect.width, width - rect.x - 8))
  const clippedHeight = Math.max(12, Math.min(rect.height, height - rect.y - 8))
  if (typeof document !== 'undefined') {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#f8fafc'
        roundRect(ctx, 0, 0, width, height, 14)
        ctx.fill()

        ctx.strokeStyle = '#dbe3ef'
        ctx.lineWidth = 1
        roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 13.5)
        ctx.stroke()

        ctx.fillStyle = 'rgba(22, 131, 255, 0.14)'
        ctx.strokeStyle = '#1683ff'
        ctx.lineWidth = 3
        roundRect(ctx, rect.x, rect.y, clippedWidth, clippedHeight, 8)
        ctx.fill()
        ctx.stroke()

        const labelWidth = Math.min(width - 24, Math.max(92, label.length * 7 + 28))
        ctx.fillStyle = '#0f172a'
        roundRect(ctx, 12, 12, labelWidth, 28, 8)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.font = '700 13px Inter, Arial, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, 26, 26, labelWidth - 28)

        return canvas.toDataURL('image/png')
      }
    } catch {
      // Fall through to the SVG data URL fallback.
    }
  }
  const safeLabel = escapeSvg(label)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="14" fill="#f8fafc"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="13.5" fill="none" stroke="#dbe3ef"/>
  <rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${clippedWidth.toFixed(1)}" height="${clippedHeight.toFixed(1)}" rx="8" fill="#1683ff" fill-opacity="0.14" stroke="#1683ff" stroke-width="3"/>
  <rect x="12" y="12" width="${Math.min(width - 24, safeLabel.length * 7 + 28)}" height="28" rx="8" fill="#0f172a"/>
  <text x="26" y="31" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${safeLabel}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function escapeSvg(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 42)
}
