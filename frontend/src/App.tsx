import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, Settings, UserCircle } from 'lucide-react'
import type { AuthUser, CanvasElementSelection, MiniappRecord } from '@shared/protocol'
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
  getAuth,
  logout,
  googleLoginUrl,
  type AuthInfo,
  type AgentEvent,
  type ChatTurn,
} from '@/lib/api'
import { ChatPanel, type UiMessage } from '@/chat/ChatPanel'
import { MiniappCanvas, type MiniappCanvasHandle } from '@/canvas/MiniappCanvas'
import { CreationWizard, type WizardFlowUpdate } from '@/wizard/CreationWizard'
import type { AgentFlowNavState, NavView } from '@/wizard/AgentCanvas'
import { ROUTES, viewFromPath } from '@/routes'
import { AgentFlowPage } from '@/pages/AgentFlowPage'
import { AgentPage } from '@/pages/AgentPage'
import { CommunityAgentsPage } from '@/pages/CommunityAgentsPage'
import { RuntimePage } from '@/pages/RuntimePage'
import { CardNav, type CardNavItem } from '@/components/CardNav'
import { MotionAccordion } from '@/components/unlumen-ui/motion-faqs-accordion'
import DotGrid from '@/components/react-bits/DotGrid'
import { InteractiveHoverButton } from '@/components/magicui/interactive-hover-button'
import { SquigglyText } from '@/components/ui/squiggly-text'

export type StudioMode = 'dev' | 'live'

export interface CanvasSelectionAttachment {
  selection: CanvasElementSelection
  imageUrl: string
}

let seq = 0
const nextId = () => `m${Date.now()}-${seq++}`

export function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null) // null = still loading
  const [miniapp, setMiniapp] = useState<MiniappRecord | null>(null)
  const [list, setList] = useState<(MiniappRecord & { hasHtml: boolean })[]>([])
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [liveMessages, setLiveMessages] = useState<UiMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [liveStreaming, setLiveStreaming] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [view, setView] = useState<NavView>(() => viewFromPath(window.location.pathname))
  const [agentFlowNav, setAgentFlowNav] = useState<AgentFlowNavState | null>(null)
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

  const navigate = useCallback((next: NavView, replace = false) => {
    const path = ROUTES[next]
    if (window.location.pathname !== path) {
      const method = replace ? 'replaceState' : 'pushState'
      window.history[method]({}, '', path)
    }
    setView(next)
  }, [])

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (window.location.pathname === '/') return
    const normalized = ROUTES[viewFromPath(window.location.pathname)]
    if (window.location.pathname !== normalized) {
      window.history.replaceState({}, '', normalized)
    }
  }, [])

  useEffect(() => {
    if (!auth?.user || window.location.pathname !== '/') return
    navigate('agents', true)
  }, [auth?.user, navigate])

  useEffect(() => {
    if (view !== 'flow') setAgentFlowNav(null)
  }, [view])

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

  // Resolve the current session on load.
  useEffect(() => {
    void getAuth().then(setAuth).catch(() => setAuth({ user: null, devAuth: false, googleAuth: false }))
  }, [])

  // Bootstrap the studio only once signed in (scoped to the user's own agents).
  useEffect(() => {
    if (!auth?.user) return
    void (async () => {
      await refreshList()
      const existing = await listMiniapps().catch(() => [])
      if (existing.length > 0) {
        setActiveMiniapp(await getMiniapp(existing[0].id))
      } else {
        setActiveMiniapp(await createMiniapp())
      }
    })()
  }, [auth?.user, refreshList, setActiveMiniapp])

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
    navigate('flow')
  }, [navigate, setActiveMiniapp])

  const newAgent = useCallback(async () => {
    setActiveMiniapp(await createMiniapp())
    navigate('flow')
    void refreshList()
  }, [navigate, refreshList, setActiveMiniapp])

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

  // ── Auth gate ──
  if (!auth) {
    return <div className="dot-bg grid h-full w-full place-items-center text-sm text-muted-foreground">Loading…</div>
  }
  if (!auth.user) {
    return <LoginScreen />
  }

  // Top-level navigation (URL routes: /agent, /community, /runtime, /new; / redirects to /agent).
  const appNavbar = (
    <AppNavbar
      user={auth.user}
      view={view}
      onNavigate={navigate}
      centerSlot={view === 'flow' && agentFlowNav ? <AgentFlowNavbarStepper state={agentFlowNav} /> : null}
    />
  )
  if (view === 'agents') {
    return <>{appNavbar}<AgentPage agents={list} onOpen={openAgent} onNew={newAgent} onRemove={handleDelete} onNavigate={navigate} /></>
  }
  if (view === 'runtime') return <>{appNavbar}<RuntimePage agents={list} onNavigate={navigate} /></>
  if (view === 'community') return <>{appNavbar}<CommunityAgentsPage onNavigate={navigate} /></>
  if (miniapp) {
    return (
      <>
        {appNavbar}
        <AgentFlowPage
          miniapp={miniapp}
          onUpdateFlow={updateFlow}
          onNavigate={navigate}
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
          onNavStateChange={setAgentFlowNav}
        />
      </>
    )
  }
  // Legacy full-screen studio kept for reference (app canvas edit/preview now lives
  // in the Surface · Mini App panel inside the flow).
  void CreationWizard

  return <div className="dot-bg grid h-full w-full place-items-center text-sm text-muted-foreground">Loading…</div>

}

const loginFaqs = [
  {
    question: '什么是 Cirrus？',
    answer: 'Cirrus 是一个创建、分享以及运行 Agent 的环境。',
  },
  {
    question: '为什么要用 Cirrus？',
    answer:
      '我们的 Agent 可能散落在不同的项目中，Cirrus 希望帮你更好地管理你的 Agent，同时可以发现社区优秀的 Agent 并直接使用。',
  },
  {
    question: 'Agent 跑在哪里？',
    answer:
      'Cirrus 提供方便的云端沙箱环境让你一键跑 Agent，你可以直接在网页上和 Agent 对话，或者通过 Chatbot/API 来使用 Agent。',
  },
  {
    question: '在 Cirrus 上 Agent 可以长久运行么？',
    answer:
      'Cirrus 会自动暂停空闲的 Agent 来减少资源消耗，但只要你开始对话或有任务触发，Agent 会自动恢复，所有记忆/环境会持久保存。',
  },
  {
    question: '什么是 miniapp？',
    answer:
      '通过 Cirrus 创建的 Agent 还可以提供创建 miniapp 的能力，miniapp 可以是一个完整的 webapp。你可以开发任何想要的 web 功能，可以是针对 Agent 的看板，也可以是一个独立的网站，这时候 Agent 会成为集成在你产品中的智能助理。',
  },
]

function LoginScreen() {
  return (
    <div className="relative min-h-full w-full overflow-y-auto bg-white px-5 py-8 sm:px-8 sm:py-12">
      <div className="absolute inset-0 opacity-70">
        <DotGrid />
      </div>
      <main className="relative z-[1] mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col justify-center">
        <h1 className="mb-9 text-center text-[44px] font-semibold leading-none tracking-normal text-ink sm:text-[60px]">
          Meet{' '}
          <SquigglyText className="text-primary" scale={[3, 5]} stepDuration={90}>
            Cirrus
          </SquigglyText>
        </h1>
        <MotionAccordion items={loginFaqs} className="mx-auto w-full max-w-2xl" />

        <InteractiveHoverButton
          href={googleLoginUrl}
          className="mx-auto mt-7 h-10 border-border/70 bg-white px-5 text-[14px] text-ink shadow-xs transition focus:outline-none focus:ring-2 focus:ring-primary/30 focus:ring-offset-2 focus:ring-offset-white"
        >
          使用 Google 登录
        </InteractiveHoverButton>
      </main>
    </div>
  )
}

function AppNavbar({
  user,
  view,
  onNavigate,
  centerSlot,
}: {
  user: AuthUser
  view: NavView
  onNavigate: (view: NavView) => void
  centerSlot?: ReactNode
}) {
  const items = useMemo<CardNavItem[]>(
    () => [
      {
        label: 'Agent',
        bgColor: '#f3f0ff',
        textColor: '#29215d',
        links: [
          { label: 'My Agents', ariaLabel: 'Open My Agents', active: view === 'agents', onClick: () => onNavigate('agents') },
          { label: 'Community', ariaLabel: 'Open Community Agents', active: view === 'community', onClick: () => onNavigate('community') },
        ],
      },
      {
        label: 'Runtime',
        bgColor: '#edfdf7',
        textColor: '#123b2f',
        links: [
          { label: 'My Runtimes', ariaLabel: 'Open My Runtimes', active: view === 'runtime', onClick: () => onNavigate('runtime') },
        ],
      },
      {
        label: 'Setting',
        bgColor: '#f6f6f2',
        textColor: '#2f302b',
        links: [
          { label: 'Profile', ariaLabel: 'Open Profile' },
          { label: 'Settings', ariaLabel: 'Open Settings' },
        ],
      },
    ],
    [onNavigate, view],
  )

  return (
    <CardNav
      centerSlot={centerSlot}
      items={items}
      rightSlot={<NavbarUserMenu user={user} />}
      baseColor="rgba(255,255,255,0.92)"
      menuColor="#25251f"
    />
  )
}

function AgentFlowNavbarStepper({ state }: { state: AgentFlowNavState }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
      {state.steps.map((step, i) => {
        const engaged = i <= state.reached
        const focused = i === state.focus
        return (
          <div key={step.key} className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => engaged && state.onStep(i)}
              className="flex min-w-0 items-center gap-1.5"
              style={{ cursor: engaged ? 'pointer' : 'default' }}
              aria-current={focused ? 'step' : undefined}
            >
              <span
                className={`flex size-[19px] items-center justify-center rounded-full border text-[10px] font-mono transition ${
                  engaged ? 'border-transparent bg-primary text-primary-foreground' : 'border-border-strong bg-surface-muted text-ink-tertiary'
                } ${focused ? 'ring-2 ring-primary/25 ring-offset-1 ring-offset-surface' : ''}`}
              >
                {i + 1}
              </span>
              <span className={`hidden text-[12px] sm:inline ${focused ? 'font-semibold text-ink' : engaged ? 'font-semibold text-ink-secondary' : 'font-medium text-ink-tertiary'}`}>
                {step.label}
              </span>
            </button>
            {i < state.steps.length - 1 && <span className="h-px w-4 shrink-0 bg-border-strong sm:w-7" />}
          </div>
        )
      })}
    </div>
  )
}

function NavbarUserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const label = user.name || user.email
  const menuRect = open ? buttonRef.current?.getBoundingClientRect() : null
  const menuStyle = menuRect
    ? {
        top: menuRect.bottom + 8,
        right: Math.max(12, window.innerWidth - menuRect.right),
      }
    : { top: 72, right: 12 }

  return (
    <div className="relative h-full min-w-0">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="grid h-full w-11 place-items-center rounded-[12px] bg-transparent hover:bg-surface-muted"
        aria-label="Open user menu"
        aria-expanded={open}
      >
        {user.picture
          ? <img src={user.picture} alt="" className="size-7 rounded-full" />
          : <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{label.slice(0, 1).toUpperCase()}</span>}
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            className="fixed inset-0 z-[270] cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close user menu"
          />
          <div
            className="fixed z-[280] w-52 overflow-hidden rounded-[12px] border border-border bg-surface p-1 shadow-[0_18px_46px_-18px_rgba(25,25,23,0.35)]"
            style={menuStyle}
          >
            <div className="flex items-center gap-2 px-2.5 py-2">
              <UserCircle className="size-[15px] text-ink-tertiary" />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-ink">{label}</div>
                <div className="truncate text-[11px] text-ink-tertiary">{user.email}</div>
              </div>
            </div>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-ink-secondary hover:bg-surface-muted"
            >
              <Settings className="size-[14px]" /> Settings
            </button>
            <button
              onClick={async () => { await logout(); window.location.reload() }}
              className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-destructive hover:bg-destructive/10"
            >
              <LogOut className="size-[14px]" /> Sign out
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
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
