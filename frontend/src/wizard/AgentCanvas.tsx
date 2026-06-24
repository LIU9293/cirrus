import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence, type Variants } from 'motion/react'
import {
  ArrowUp,
  ArrowRight,
  Trash2,
  AlertCircle,
  MoreHorizontal,
  PencilLine,
  Sparkles,
  Check,
  Plus,
  Loader2,
  Mail,
  Database,
  Newspaper,
  Clock,
  Maximize2,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  AppWindow,
  Bot,
  Braces,
  Minus,
  Play,
  Minimize2,
  LayoutGrid,
  Server,
  MousePointer2,
  X,
  Search,
  Globe,
  Bell,
  Github,
  KeyRound,
  CalendarClock,
  Pause,
  Power,
  Copy,
  Upload,
  Settings,
  Globe2,
  Lock,
} from 'lucide-react'
import type {
  BotPlatform,
  CanvasElementSelection,
  CreationPhase,
  CronJob,
  MiniappDraft,
  MiniappRecord,
  MiniappSkill,
  PlatformSkill,
  RuntimeAgentRef,
  RuntimeAgentModelConfig,
  RuntimeRecord,
  RuntimeStatus,
  SkillToolCall,
} from '@shared/protocol'
import {
  clarifyConcept,
  planSkills as apiPlanSkills,
  listSkillLibrary,
  getAgentFile,
  putAgentFile,
  saveSkillCredentials,
  testSkillTool,
  listDatastoreTables,
  queryDatastore,
  chatAboutSkill,
  chatAboutSurface,
  listRuntimes,
  createRuntime as apiCreateRuntime,
  getRuntime,
  deleteRuntime as apiDeleteRuntime,
  updateRuntimeName,
  streamRuntimeChat,
  listRuntimeCron,
  createRuntimeCron,
  updateRuntimeCron,
  deleteRuntimeCron,
  streamRuntimeCronChat,
  connectRuntimeBot,
  disconnectRuntimeBot,
  addRuntimeAgent,
  removeRuntimeAgent,
  updateRuntimeAgentModelConfig,
  getRuntimeAgentSkills,
  saveRuntimeAgentSkillSettings,
  getCommunityUsage,
  getMiniapp,
  agentImportDataset,
  updateMiniappSettings,
  listPublishedAgents,
  type PublishedAgent,
  type AgentEvent,
  type ChatTurn,
  type DatastoreTableInfo,
  type RuntimeAgentSkillSettings,
} from '@/lib/api'
import { MiniappCanvas, type MiniappCanvasHandle } from '@/canvas/MiniappCanvas'
import { MessageResponse } from '@/components/ai-elements/message'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { UiMessage } from '@/chat/ChatPanel'
import { cn } from '@/lib/utils'

// The agent-creation free canvas: a dot-grid surface with a floating step navbar
// and a horizontal "step scroller" of columns. Each step adds a column; the active
// column is centered while finished steps recede to the left and fade at the edge.

export interface CanvasFlowUpdate {
  creationPhase?: CreationPhase
  draft?: Partial<MiniappDraft>
  skills?: MiniappSkill[]
  defineMessages?: MiniappRecord['defineMessages']
}

export type NavView = 'flow' | 'agents' | 'runtime' | 'community'

export interface AgentFlowNavState {
  steps: { key: CreationPhase; label: string }[]
  focus: number
  reached: number
  onStep: (index: number) => void
}

const PAGE_CONTAINER_CLASS =
  'relative z-10 mx-auto w-full max-w-[1080px] px-4 pb-16 pt-[92px] sm:px-6 sm:pb-20 sm:pt-[112px] lg:px-10 lg:pt-[116px]'
const PAGE_HEADER_CLASS = 'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'
const PAGE_GRID_CLASS = 'mt-6 grid grid-cols-1 gap-4 sm:mt-7 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3'

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [query])
  return matches
}

interface Props {
  miniapp: MiniappRecord
  onUpdateFlow: (partial: CanvasFlowUpdate) => void
  onNavigate: (view: NavView) => void
  onNavStateChange?: (state: AgentFlowNavState | null) => void
  // Build/edit wiring for the Surface · Mini App panel.
  onBuild?: (text: string, agentContent?: string) => void
  buildMessages?: UiMessage[]
  building?: boolean
  canvasRef?: React.Ref<MiniappCanvasHandle>
  onState?: (state: Record<string, unknown>, version: number) => void
  onLiveSend?: (text: string) => void
  liveMessages?: UiMessage[]
  liveStreaming?: boolean
  // Element selection (Edit mode)
  selectingElement?: boolean
  selectedElement?: CanvasElementSelection | null
  onToggleElementSelect?: () => void
  onElementSelected?: (sel: CanvasElementSelection) => void
  onClearSelection?: () => void
}

const PHASES: { key: CreationPhase; label: string }[] = [
  { key: 'define', label: 'Define' },
  { key: 'skills', label: 'Skill' },
  { key: 'surface', label: 'Surface' },
]

export function AgentCanvas({ miniapp, onUpdateFlow, onNavigate, onNavStateChange, onBuild, buildMessages, building, canvasRef, onState, onLiveSend, liveMessages, liveStreaming, selectingElement, selectedElement, onToggleElementSelect, onElementSelected, onClearSelection }: Props) {
  // A finished ('done') agent — and legacy 'publish' records — land on the last
  // column (Surface) with the full track visible.
  const raw = miniapp.creationPhase ?? 'define'
  const phase = (raw === 'done' || raw === 'publish' ? 'surface' : raw) as CreationPhase
  // `reached` = furthest step (from creationPhase). Columns exist up to it and
  // never disappear. `focus` = which column the camera centers on; navigating
  // back via the navbar only pans the canvas, it doesn't change progress.
  const reached = Math.max(0, PHASES.findIndex((p) => p.key === phase))
  const reachedKey = PHASES[reached].key

  const containerRef = useRef<HTMLDivElement>(null)
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const [animate, setAnimate] = useState(true)
  const [grabbing, setGrabbing] = useState(false)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const [focus, setFocus] = useState(reached)
  // Multiple Edit-Skill panels can be open at once; last in the array renders on top.
  type PanelTarget = MiniappSkill | 'requirements' | 'soul' | 'miniapp'
  type OpenPanel = { target: PanelTarget; origin: DOMRect | null }
  const [panels, setPanels] = useState<OpenPanel[]>([])
  const keyOf = (t: PanelTarget) => (typeof t === 'string' ? t : t.id)
  const openPanel = (t: PanelTarget, origin: DOMRect | null) =>
    setPanels((ps) => [...ps.filter((p) => keyOf(p.target) !== keyOf(t)), { target: t, origin }])
  const closePanel = (k: string) => setPanels((ps) => ps.filter((p) => keyOf(p.target) !== k))
  const frontPanel = (k: string) =>
    setPanels((ps) => {
      const it = ps.find((p) => keyOf(p.target) === k)
      return it ? [...ps.filter((p) => keyOf(p.target) !== k), it] : ps
    })

  // The conversational Define entry is only the first-run guide. If the agent
  // already has a concept (returning / seeded), skip it and show the canvas.
  const skippedDefine = useRef(false)
  useEffect(() => {
    if (skippedDefine.current) return
    const hasConcept = !!(miniapp.draft?.name && miniapp.draft?.goal) || !!miniapp.manifest?.description
    if (phase === 'define' && hasConcept) {
      skippedDefine.current = true
      onUpdateFlow({ creationPhase: 'skills' })
    }
  }, [phase, miniapp.draft?.name, miniapp.draft?.goal, miniapp.manifest?.description, onUpdateFlow])

  // When progress advances, glide the camera to the newest column.
  useEffect(() => setFocus(reached), [reached])

  const focusIndex = Math.min(focus, reached)
  const focusKey = PHASES[focusIndex].key

  useEffect(() => {
    onNavStateChange?.({
      steps: PHASES,
      focus: focusIndex,
      reached,
      onStep: (index) => {
        if (index <= reached) setFocus(index)
      },
    })
    return () => onNavStateChange?.(null)
  }, [focusIndex, reached, onNavStateChange])

  useLayoutEffect(() => {
    const recenter = () => {
      const container = containerRef.current
      const col = colRefs.current[focusKey]
      if (!container || !col) return
      const cw = container.clientWidth
      const center = col.offsetLeft + col.offsetWidth / 2
      // Steps align to a fixed top (below the navbar) so switching doesn't move
      // them vertically — except the very first entry (the Define chat guide),
      // which sits vertically centered for a welcoming blank-canvas feel.
      const desiredTop =
        reached === 0 ? Math.max(120, Math.round((container.clientHeight - col.offsetHeight) / 2)) : 120
      setAnimate(true)
      setOffset({ x: Math.round(cw / 2 - center), y: Math.round(desiredTop - col.offsetTop) })
    }
    recenter()
    window.addEventListener('resize', recenter)
    // On the initial Define entry, keep the chat block vertically centered as it
    // grows by re-centering whenever the column's height changes.
    let ro: ResizeObserver | null = null
    if (reached === 0 && 'ResizeObserver' in window) {
      const col = colRefs.current[focusKey]
      if (col) {
        ro = new ResizeObserver(() => recenter())
        ro.observe(col)
      }
    }
    return () => {
      window.removeEventListener('resize', recenter)
      ro?.disconnect()
    }
  }, [focusKey, reached, miniapp.skills?.length])

  // The initial Define guide is fixed (centered) — panning is disabled until the
  // first step is done and the multi-column track exists.
  const canPan = reached > 0
  const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canPan) return
    if ((e.target as HTMLElement).closest('button, input, textarea, a, [data-no-pan]')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offset?.x ?? 0, oy: offset?.y ?? 0 }
    setAnimate(false)
    setGrabbing(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
  }
  const onPanEnd = () => {
    dragRef.current = null
    setGrabbing(false)
  }

  const advance = (partial?: CanvasFlowUpdate) => {
    const next = PHASES[Math.min(PHASES.length - 1, reached + 1)].key
    onUpdateFlow({ ...partial, creationPhase: next })
  }
  const goTo = (key: CreationPhase) => onUpdateFlow({ creationPhase: key })

  const columns: CreationPhase[] = PHASES.slice(0, reached + 1).map((p) => p.key)

  return (
    <div
      ref={containerRef}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
      className={cn('dot-bg relative h-full w-full overflow-hidden', !canPan ? 'cursor-default' : grabbing ? 'cursor-grabbing select-none' : 'cursor-grab')}
    >
      {/* Left-edge fade for the receding columns */}
      {reached > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[240px]"
          style={{ background: 'linear-gradient(to right, var(--background), transparent)' }}
        />
      )}

      {/* Horizontal column track */}
      <div
        className="absolute left-0 top-0 z-10 flex items-start gap-[60px] px-[60px]"
        style={{
          transform: `translate(${offset?.x ?? 0}px, ${offset?.y ?? 0}px)`,
          transition: animate ? 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
          visibility: offset === null ? 'hidden' : 'visible',
        }}
      >
        {columns.map((key) => (
          <div
            key={key}
            ref={(el) => {
              colRefs.current[key] = el
            }}
            className="cirrus-col-in"
          >
            {key === 'define' &&
              (reached === 0 ? (
                <DefineChatColumn
                  miniapp={miniapp}
                  onClarify={(record) => onUpdateFlow({ draft: record.draft, defineMessages: record.defineMessages })}
                  onCreate={(draft) => advance({ draft })}
                />
              ) : (
                <RequirementsColumn miniapp={miniapp} onView={(r) => openPanel('requirements', r)} />
              ))}
            {key === 'skills' && (
              <CapabilitiesColumn
                miniapp={miniapp}
                active={key === reachedKey}
                onSkills={(skills) => onUpdateFlow({ skills })}
                onContinue={() => advance()}
                onView={(t, r) => openPanel(t, r)}
              />
            )}
            {key === 'surface' && (
              <SurfacesColumn
                active={key === reachedKey}
                miniapp={miniapp}
                hasMiniApp={!!miniapp.html}
                onFinish={() => {
                  goTo('done')
                  onNavigate('agents')
                }}
                onViewMiniApp={(r) => openPanel('miniapp', r)}
              />
            )}
          </div>
        ))}
      </div>

      {panels.map((p, i) => (
        <SkillPanel
          key={keyOf(p.target)}
          index={i}
          appId={miniapp.id}
          miniapp={miniapp}
          target={p.target}
          origin={p.origin}
          onClose={() => closePanel(keyOf(p.target))}
          onFront={() => frontPanel(keyOf(p.target))}
          onBuild={onBuild}
          buildMessages={buildMessages}
          building={building}
          canvasRef={canvasRef}
          onState={onState}
          onUpdateFlow={onUpdateFlow}
          onLiveSend={onLiveSend}
          liveMessages={liveMessages}
          liveStreaming={liveStreaming}
          selectingElement={selectingElement}
          selectedElement={selectedElement}
          onToggleElementSelect={onToggleElementSelect}
          onElementSelected={onElementSelected}
          onClearSelection={onClearSelection}
        />
      ))}
    </div>
  )
}

/* ──────────────────── Define · chat entry ──────────────────── */

const SUGGESTIONS = [
  { icon: <Mail className="size-[15px]" />, label: 'Email agent' },
  { icon: <Newspaper className="size-[15px]" />, label: 'Daily digest' },
  { icon: <Database className="size-[15px]" />, label: 'Data tracker' },
]

function DefineChatColumn({
  miniapp,
  onClarify,
  onCreate,
}: {
  miniapp: MiniappRecord
  onClarify: (record: MiniappRecord & { hasHtml?: boolean }) => void
  onCreate: (d: MiniappDraft) => void
}) {
  const seededGoal = miniapp.draft?.goal ?? miniapp.manifest?.description ?? ''
  const seededName = miniapp.draft?.name ?? miniapp.manifest?.name ?? ''
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [concept, setConcept] = useState<{ name: string; goal: string } | null>(
    seededGoal ? { name: seededName, goal: seededGoal } : null,
  )

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || busy) return
    const history: ChatTurn[] = [...thread, { role: 'user', content: text }]
    setThread(history)
    setInput('')
    setBusy(true)
    try {
      const r = await clarifyConcept(miniapp.id, history)
      if (r.miniapp) onClarify(r.miniapp)
      if (r.ready) {
        setConcept({ name: r.name ?? '', goal: r.goal ?? '' })
        setThread((t) => [...t, { role: 'assistant', content: `Got it — ${r.name}.` }])
      } else {
        setThread((t) => [...t, { role: 'assistant', content: r.question ?? 'Tell me a bit more?' }])
      }
    } catch {
      setThread((t) => [...t, { role: 'assistant', content: 'Something went wrong — try again?' }])
    } finally {
      setBusy(false)
    }
  }

  // Keep the conversation pinned to the bottom and detect when it overflows the
  // cap (so the top can fade out).
  const scrollRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [thread, busy, concept])

  return (
    <div className="flex w-[600px] flex-col gap-[18px]">
      {/* conversation — capped height; older messages fade out at the top */}
      <div
        ref={scrollRef}
        className="flex flex-col gap-[18px] overflow-y-auto"
        style={{
          maxHeight: 452,
          ...(overflowing
            ? {
                maskImage: 'linear-gradient(to bottom, transparent 0, #000 44px)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 44px)',
              }
            : {}),
        }}
      >
        {/* opening agent message */}
        <div className="flex items-end gap-2.5">
          <Avatar />
          <div className="rounded-[18px] rounded-bl-[5px] bg-surface-muted px-[15px] py-[11px] text-[15px] text-ink">
            What would you like to create?
          </div>
        </div>

        {thread.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="rounded-[16px] rounded-br-[5px] bg-primary px-[14px] py-[10px] text-[14.5px] text-primary-foreground">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex items-end gap-2.5">
              <Avatar sm />
              <div className="rounded-[16px] rounded-bl-[5px] bg-surface-muted px-[14px] py-[10px] text-[14.5px] text-ink">
                {m.content}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 pl-1 text-xs text-ink-tertiary">
            <Loader2 className="size-3.5 animate-spin" /> working...
          </div>
        )}

        {concept && (
          <div className="cirrus-pop rounded-[16px] border border-border bg-surface p-4 shadow-[0_8px_24px_-6px_rgba(25,25,23,0.07)]">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary" />
              <span className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">CONCEPT READY</span>
            </div>
            <input
              value={concept.name}
              onChange={(e) => setConcept({ ...concept, name: e.target.value })}
              className="mt-1.5 w-full bg-transparent text-[17px] font-bold tracking-tight text-ink outline-none"
            />
            <textarea
              value={concept.goal}
              onChange={(e) => setConcept({ ...concept, goal: e.target.value })}
              rows={2}
              className="mt-1 w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink-secondary outline-none"
            />
            <button
              onClick={() => onCreate({ name: concept.name.trim(), goal: concept.goal.trim() })}
              disabled={!concept.name.trim() || !concept.goal.trim()}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-3.5 py-2 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Create this agent <ArrowRight className="size-[15px]" />
            </button>
          </div>
        )}
      </div>

      {/* input */}
      <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-surface py-2 pl-[18px] pr-2 shadow-[0_6px_20px_-8px_rgba(25,25,23,0.06)]">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Describe the agent you want to build…"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-tertiary"
        />
        <button
          onClick={() => send()}
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUp className="size-[18px]" />
        </button>
      </div>

      {/* suggestions */}
      <div className="flex flex-wrap gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => send(`Help me build a ${s.label.toLowerCase()}`)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-secondary hover:bg-surface-muted"
          >
            <span className="text-ink-secondary">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Avatar({ sm }: { sm?: boolean }) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-ink font-bold text-primary-foreground',
        sm ? 'size-[26px] text-[11.5px]' : 'size-[30px] text-[13px]',
      )}
    >
      T
    </div>
  )
}

/* ───────── Column header (matches "Define Requirements" / "Agent capabilities") ───────── */

function ColHeader({ children }: { children: React.ReactNode }) {
  return <div className="px-1 pb-0.5 text-[13px] font-semibold text-ink-secondary">{children}</div>
}

function ViewButton({ onClick }: { onClick?: (rect: DOMRect) => void }) {
  return (
    <button
      onClick={(e) => onClick?.(e.currentTarget.getBoundingClientRect())}
      className="inline-flex items-center gap-1.5 rounded-[9px] border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-muted"
    >
      View <Maximize2 className="size-[13px] text-ink-secondary" />
    </button>
  )
}

/* ──────────────── Define Requirements (compact summary) ──────────────── */

function RequirementsColumn({ miniapp, onView }: { miniapp: MiniappRecord; onView: (rect: DOMRect) => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [override, setOverride] = useState<{ name?: string }>({})
  const name = override.name ?? miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Agent'
  const goal = miniapp.draft?.goal ?? miniapp.manifest?.description ?? ''
  return (
    <div className="flex w-[340px] flex-col gap-3">
      <ColHeader>Define Requirements</ColHeader>
      <div className="rounded-[16px] border border-border bg-surface shadow-[0_8px_24px_-6px_rgba(25,25,23,0.07)]">
        <div className="flex flex-col gap-1 p-4 pb-3">
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-primary" />
            <span className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">AGENT</span>
          </div>
          <div className="text-[17px] font-bold tracking-tight text-ink">{name}</div>
          <div className="text-[13px] leading-relaxed text-ink-secondary">{goal}</div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Agent settings"
            className="flex size-[30px] items-center justify-center rounded-[9px] border border-border-strong bg-surface text-ink-secondary transition hover:bg-surface-muted"
          >
            <Settings className="size-[15px]" />
          </button>
          <ViewButton onClick={onView} />
        </div>
      </div>
      {settingsOpen && (
        <AgentSettingsDialog
          miniapp={miniapp}
          currentName={name}
          onClose={() => setSettingsOpen(false)}
          onSaved={(patch) => { if (patch.name) setOverride({ name: patch.name }); setSettingsOpen(false) }}
        />
      )}
    </div>
  )
}

function AgentSettingsDialog({
  miniapp,
  currentName,
  onClose,
  onSaved,
}: {
  miniapp: MiniappRecord
  currentName: string
  onClose: () => void
  onSaved: (patch: { name?: string; visibility?: 'private' | 'public' }) => void
}) {
  const [name, setName] = useState(currentName)
  const [visibility, setVisibility] = useState<'private' | 'public'>(miniapp.visibility ?? 'private')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setError(null)
    const patch = { name: name.trim() || undefined, visibility }
    try {
      await updateMiniappSettings(miniapp.id, patch)
      onSaved(patch)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
      setSaving(false)
    }
  }
  const opt = (value: 'private' | 'public', icon: React.ReactNode, label: string, desc: string) => (
    <button
      type="button"
      onClick={() => setVisibility(value)}
      className={cn(
        'flex items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition',
        visibility === value ? 'border-primary bg-accent-soft' : 'border-border hover:bg-surface-muted',
      )}
    >
      <span className={cn('mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[8px]', visibility === value ? 'bg-primary/10 text-accent-ink' : 'bg-surface-muted text-ink-tertiary')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-ink">{label}</span>
        <span className="block text-[11.5px] leading-relaxed text-ink-tertiary">{desc}</span>
      </span>
    </button>
  )
  return createPortal(
    <div className="fixed inset-0 z-[220] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-6" onMouseDown={onClose}>
      <div className="cirrus-pop w-full max-w-[440px] rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4 text-[14px] font-semibold text-ink">Agent settings</div>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-[10px] border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">Visibility</label>
            <div className="flex flex-col gap-2">
              {opt('private', <Lock className="size-[14px]" />, 'Private', 'Only you can see and use this agent.')}
              {opt('public', <Globe2 className="size-[14px]" />, 'Public', 'Listed on the Community page for anyone to discover.')}
            </div>
          </div>
          {error && <div className="text-[12px] text-destructive">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="rounded-[9px] border border-border px-3.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-surface-muted">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
            {saving && <Loader2 className="size-3.5 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ──────────────── Agent capabilities ──────────────── */

const CAT_ICON: Record<string, React.ReactNode> = {
  connector: <Mail className="size-[17px]" />,
  data: <Database className="size-[17px]" />,
  trigger: <Clock className="size-[17px]" />,
  tool: <Newspaper className="size-[17px]" />,
  ai: <Sparkles className="size-[17px]" />,
}

function CapabilitiesColumn({
  miniapp,
  active,
  onSkills,
  onContinue,
  onView,
}: {
  miniapp: MiniappRecord
  active: boolean
  onSkills: (skills: MiniappSkill[]) => void
  onContinue: () => void
  onView: (target: MiniappSkill | 'soul', rect: DOMRect) => void
}) {
  const [skills, setSkills] = useState<MiniappSkill[]>(miniapp.skills ?? [])
  const [planning, setPlanning] = useState(false)
  const [soul, setSoul] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const addSkill = (s: MiniappSkill) => {
    const next = [...skills, s]
    setSkills(next)
    onSkills(next)
  }

  useEffect(() => {
    if (!skills.length && (miniapp.draft?.goal || miniapp.manifest?.description)) {
      setPlanning(true)
      apiPlanSkills(miniapp.id)
        .then((r) => {
          setSkills(r.skills)
          onSkills(r.skills)
        })
        .finally(() => setPlanning(false))
    }
    void getAgentFile(miniapp.id, 'soul.md').then(setSoul).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex w-[432px] flex-col gap-3">
      <div className="flex items-center gap-2 px-1 pb-0.5">
        <span className="text-[13px] font-semibold text-ink-secondary">Agent capabilities</span>
        <span className="rounded-full bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-tertiary">
          {planning ? '…' : skills.length + 1}
        </span>
      </div>

      {/* Soul card */}
      <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-[30px] items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
            <Sparkles className="size-4" />
          </div>
          <div className="flex-1">
            <div className="text-[14.5px] font-semibold text-ink">Soul</div>
            <div className="text-[12px] text-ink-tertiary">What the agent is &amp; does</div>
          </div>
          <span className="font-mono text-[10.5px] text-ink-tertiary">soul.md</span>
        </div>
        <pre className="max-h-24 overflow-hidden whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink-secondary">
          {(soul || `# ${miniapp.draft?.name ?? 'Agent'}\n\n${miniapp.draft?.goal ?? ''}`).slice(0, 220)}
        </pre>
        <div className="flex justify-end">
          <ViewButton onClick={(r) => onView('soul', r)} />
        </div>
      </div>

      {planning && (
        <>
          <div className="flex items-center gap-2 px-1 pt-0.5 text-[12.5px] font-semibold text-ink-secondary">
            <Sparkles className="size-4 text-primary cirrus-float" />
            <span>Dreaming up capabilities</span>
            <span className="flex gap-0.5">
              <span className="cirrus-dot size-1 rounded-full bg-primary" style={{ animationDelay: '0s' }} />
              <span className="cirrus-dot size-1 rounded-full bg-primary" style={{ animationDelay: '0.2s' }} />
              <span className="cirrus-dot size-1 rounded-full bg-primary" style={{ animationDelay: '0.4s' }} />
            </span>
          </div>
          {[0, 1, 2].map((i) => (
            <SkillSkeleton key={i} index={i} />
          ))}
        </>
      )}

      {skills.map((s) => (
        <SkillCard key={s.id} skill={s} onView={(r) => onView(s, r)} />
      ))}

      <div className="flex gap-2.5 pt-1">
        <button
          onClick={() => setAddOpen(true)}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-border-strong bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink hover:bg-surface-muted"
        >
          <Plus className="size-[15px] text-ink-secondary" /> Add Skill
        </button>
        {active && (
          <button
            onClick={onContinue}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
          >
            Complete and Next <ArrowRight className="size-[15px]" />
          </button>
        )}
      </div>

      {addOpen &&
        createPortal(
          <AddSkillsDialog
            existingPlatformIds={new Set(skills.map((s) => s.platformSkillId).filter(Boolean) as string[])}
            onAddSkill={(s) => addSkill(s)}
            onAddCustom={(d) => {
              addSkill(customSkill(d))
              setAddOpen(false)
            }}
            onClose={() => setAddOpen(false)}
          />,
          document.body,
        )}
    </div>
  )
}

function SkillSkeleton({ index }: { index: number }) {
  // widths vary per card so the shimmer feels organic rather than uniform
  const titleW = ['44%', '36%', '52%'][index % 3]
  const descW = ['78%', '64%', '70%'][index % 3]
  return (
    <div
      className="cirrus-fade-up flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-3.5"
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <div className="flex items-center gap-2.5">
        <div className="cirrus-shimmer size-[30px] shrink-0 rounded-lg" />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="cirrus-shimmer h-3 rounded-full" style={{ width: titleW }} />
          <div className="cirrus-shimmer h-2.5 rounded-full" style={{ width: descW }} />
        </div>
        <div className="cirrus-shimmer h-5 w-14 shrink-0 rounded-full" />
      </div>
      <div className="flex justify-end">
        <div className="cirrus-shimmer h-7 w-16 rounded-[9px]" />
      </div>
    </div>
  )
}

function SkillCard({ skill, onView }: { skill: MiniappSkill; onView: (rect: DOMRect) => void }) {
  const builtin = skill.kind === 'builtin' || skill.source === 'library'
  // Credentials are bound per-runtime (not at build time), so they don't gate
  // readiness here — a skill is ready once its contract is active.
  const ready = skill.status === 'active'
  return (
    <div
      className="flex flex-col gap-3 rounded-[14px] border bg-surface p-3.5"
      style={{ borderColor: builtin ? 'var(--border)' : '#E8CE97' }}
    >
      <div className="flex items-center gap-3">
        <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-surface-muted text-ink">
          {CAT_ICON[skill.category] ?? <Newspaper className="size-[17px]" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold text-ink">{skill.name}</div>
          {skill.description && <div className="truncate text-[12px] text-ink-secondary">{skill.description}</div>}
        </div>
        <span
          className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={
            builtin
              ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' }
              : { background: '#FBF0D6', color: '#9A6B12' }
          }
        >
          {builtin ? 'Built-in' : 'custom'}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={ready ? { background: 'var(--live-soft)', color: 'var(--live)' } : { background: 'var(--surface-muted)', color: 'var(--ink-secondary)' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: ready ? 'var(--live)' : 'var(--ink-tertiary)' }} />
          {ready ? 'Ready' : 'Not Ready'}
        </span>
        <ViewButton onClick={onView} />
      </div>
    </div>
  )
}

function skillNeedsCredentials(skill: MiniappSkill): boolean {
  const fields = skill.credentials ?? []
  if (!fields.length) return false
  const filled = new Set(skill.credentialsFilled ?? [])
  return !fields.filter((f) => f.required !== false).every((f) => filled.has(f.key))
}

function SkillCredentialsPanel({
  appId,
  skill,
  onUpdate,
}: {
  appId: string
  skill: MiniappSkill
  onUpdate: (partial: Partial<MiniappSkill>) => void
}) {
  const fields = skill.credentials ?? []
  const filledKeys = skill.credentialsFilled ?? []
  const requiredFields = fields.filter((f) => f.required !== false)
  const allFilled = requiredFields.length > 0 && requiredFields.every((f) => filledKeys.includes(f.key))
  const [values, setValues] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(!allFilled)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await saveSkillCredentials(appId, skill.id, values)
      onUpdate({ credentialsFilled: result.credentialsFilled })
      setValues({})
      setEditing(false)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  if (!fields.length) return null

  if (allFilled && !editing) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-live/25 bg-live-soft/60 px-3 py-2.5 text-[12px] text-live">
        <Check className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">Credentials configured: {filledKeys.join(', ')}</span>
        <button type="button" onClick={() => setEditing(true)} className="font-semibold text-live hover:opacity-75">
          Update
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11.5px] text-ink-tertiary">Required before this built-in skill can run.</div>
      {fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-secondary">
            {field.label}
            {field.required === false && <span className="text-ink-tertiary">optional</span>}
            {filledKeys.includes(field.key) && <span className="text-live">set</span>}
          </span>
          {field.type === 'select' ? (
            <select
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              className="h-9 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[13px] text-ink outline-none focus:border-primary"
            >
              <option value="">{field.placeholder ?? 'Select...'}</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : field.type === 'textarea' ? (
            <textarea
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              placeholder={field.placeholder ?? (filledKeys.includes(field.key) ? 'Leave blank to keep current value' : '')}
              className="min-h-[84px] resize-y rounded-[9px] border border-border-strong bg-white/80 px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
            />
          ) : (
            <input
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              type={field.secret || field.type === 'password' ? 'password' : 'text'}
              placeholder={field.placeholder ?? (filledKeys.includes(field.key) ? 'Leave blank to keep current value' : '')}
              className="h-9 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[13px] text-ink outline-none focus:border-primary"
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !fields.some((field) => (values[field.key] ?? '').trim())}
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Save credentials
        </button>
        {allFilled && (
          <button type="button" onClick={() => setEditing(false)} className="text-[12px] font-semibold text-ink-tertiary hover:text-ink">
            Cancel
          </button>
        )}
        {error && <span className="text-[11.5px] text-red-600">{error}</span>}
      </div>
    </div>
  )
}

function GmailSkillDiagnostics({ appId, skill }: { appId: string; skill: MiniappSkill }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; result?: any; error?: string } | null>(null)

  const check = async () => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus(await testSkillTool(appId, skill.id, 'gmail_connection_status'))
    } catch (err) {
      setStatus({ ok: false, error: String((err as Error)?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }

  const result = status?.result as any
  const connected = !!result?.ok

  return (
    <div className="shrink-0 rounded-[12px] border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Mail className="size-4 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">Gmail connection</div>
          <div className="mt-0.5 text-[11.5px] text-ink-tertiary">Checks IMAP reachability and credential authentication.</div>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[12px] font-semibold text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Check
        </button>
      </div>
      {status && (
        <div
          className={cn(
            'mt-3 rounded-[10px] border px-3 py-2 text-[12px] leading-relaxed',
            connected ? 'border-live/30 bg-live-soft/50 text-live' : 'border-amber-300/60 bg-amber-50 text-ink-secondary',
          )}
        >
          {connected ? (
            <div>Connected. Sample messages visible: {Number(result?.sampleCount ?? 0)}</div>
          ) : (
            <div>{String(result?.error ?? status.error ?? 'Connection check failed.')}</div>
          )}
        </div>
      )}
    </div>
  )
}

function DatabaseSkillDiagnostics({ appId, embedded = false }: { appId: string; embedded?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [tables, setTables] = useState<DatastoreTableInfo[]>([])
  const [samples, setSamples] = useState<Record<string, Record<string, unknown>[]>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await listDatastoreTables(appId)
      setTables(next)
      const entries = await Promise.all(
        next.slice(0, 4).map(async (table) => {
          const res = await queryDatastore(appId, { table: table.table, limit: 2 })
          return [table.table, res.rows ?? []] as const
        }),
      )
      setSamples(Object.fromEntries(entries))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [appId])

  const body = (
    <div className={embedded ? 'flex flex-col gap-3' : 'shrink-0 rounded-[12px] border border-border bg-surface p-3'}>
      <div className="flex items-center gap-2">
        <Database className="size-4 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          {!embedded && <div className="text-[13px] font-semibold text-ink">Database tables</div>}
          <div className="mt-0.5 text-[11.5px] text-ink-tertiary">Shows persisted schemas, analysis rows, and operation logs.</div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[12px] font-semibold text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          Refresh
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {error && <div className="rounded-[10px] border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12px] text-ink-secondary">{error}</div>}
        {!error && !busy && tables.length === 0 && (
          <div className="rounded-[10px] border border-dashed border-border px-3 py-2 text-[12px] text-ink-tertiary">
            No tables yet. Run a tool such as inbox_triage or write_rows to persist data.
          </div>
        )}
        {tables.map((table) => (
          <div key={table.table} className="rounded-[10px] border border-black/5 bg-white/65 p-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-semibold text-ink">{table.table}</span>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10.5px] text-ink-tertiary">{table.rowCount} rows</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {table.columns.map((column) => (
                <span key={column.name} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
                  {column.name}:{column.type}
                </span>
              ))}
            </div>
            {!!samples[table.table]?.length && (
              <pre className="mt-2 max-h-24 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-[10.5px] leading-relaxed text-ink-secondary">
                {JSON.stringify(samples[table.table], null, 2).slice(0, 1000)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  )
  return body
}

function DatasetSkillLoader({
  appId,
  skill,
  onUpdate,
}: {
  appId: string
  skill: MiniappSkill
  onUpdate: (partial: Partial<MiniappSkill>) => void
}) {
  const [sourceMode, setSourceMode] = useState<'url' | 'paste'>('url')
  const [mode, setMode] = useState<'replace' | 'append'>('replace')
  const [sourceUrl, setSourceUrl] = useState('')
  const [text, setText] = useState('')
  const [table, setTable] = useState((skill.config?.table as string | undefined) ?? '')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadedTable = skill.config?.table as string | undefined
  const loadedRows = skill.config?.rowCount as number | undefined
  const schema = (skill.config?.schema as { name: string; type: string }[] | undefined) ?? []

  const importDataset = async () => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const trimmedUrl = sourceUrl.trim()
      const inputText = text.trim()
      if (sourceMode === 'url' && !trimmedUrl) throw new Error('Source URL is required.')
      if (sourceMode === 'paste' && !inputText) throw new Error('Dataset input is empty.')
      const result = await agentImportDataset(appId, {
        skillId: skill.id,
        mode,
        table: table.trim() || undefined,
        instruction: instruction.trim() || undefined,
        ...(sourceMode === 'url' ? { url: trimmedUrl } : { text }),
      })
      if (!result.ok) throw new Error(result.message)
      onUpdate({
        status: 'active',
        source: 'library',
        config: { ...skill.config, table: result.table, rowCount: result.rowCount, schema: result.columns },
      })
      setTable(result.table ?? table)
      if (sourceMode === 'paste') setText('')
      setMessage(result.message)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Database className="size-4 text-ink-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] leading-relaxed text-ink-tertiary">Give the agent a source and goal; it writes and runs the importer script.</div>
        </div>
      </div>
      {loadedTable && (
        <div className="rounded-[10px] border border-black/5 bg-white/65 p-2.5">
          <div className="font-mono text-[12px] font-semibold text-ink">{loadedTable} · {loadedRows ?? 0} rows</div>
          {!!schema.length && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {schema.map((column) => (
                <span key={column.name} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
                  {column.name}:{column.type}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md bg-surface-muted p-0.5">
            {(['url', 'paste'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSourceMode(mode)}
                className={cn('rounded px-2.5 py-1 text-[11.5px] font-medium capitalize', sourceMode === mode ? 'bg-white shadow-sm text-ink' : 'text-ink-tertiary')}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-md bg-surface-muted p-0.5">
            {(['replace', 'append'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={cn('rounded px-2.5 py-1 text-[11.5px] font-medium capitalize', mode === option ? 'bg-white shadow-sm text-ink' : 'text-ink-tertiary')}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10.5px] text-ink-tertiary">table name</span>
          <input
            value={table}
            onChange={(event) => setTable(event.target.value)}
            placeholder={loadedTable || skill.name || 'dataset'}
            className="rounded-md border border-border bg-white/80 px-2.5 py-2 font-mono text-[11px] text-ink outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </label>
        {sourceMode === 'url' ? (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] text-ink-tertiary">source URL</span>
            <input
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://example.com/dataset.txt"
              className="rounded-md border border-border bg-white/80 px-2.5 py-2 font-mono text-[11px] text-ink outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] text-ink-tertiary">dataset text</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste the raw dataset here."
              rows={5}
              className="resize-none rounded-md border border-border bg-white/80 px-2.5 py-2 font-mono text-[11px] text-ink outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
            />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10.5px] text-ink-tertiary">import instruction</span>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Describe what this dataset contains and the row shape you want."
            rows={4}
            className="resize-none rounded-md border border-border bg-white/80 px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void importDataset()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Ask agent to import
        </button>
        {message && <span className="text-[12px] text-live">{message}</span>}
        {error && <span className="text-[12px] text-amber-700">{error}</span>}
      </div>
    </div>
  )
}

/* ──────────────── Surfaces ──────────────── */

function SurfacesColumn({
  active,
  miniapp,
  hasMiniApp,
  onFinish,
  onViewMiniApp,
}: {
  active: boolean
  miniapp: MiniappRecord
  hasMiniApp: boolean
  onFinish: () => void
  onViewMiniApp: (rect: DOMRect) => void
}) {
  const hasCreated = miniapp.creationPhase === 'done'
  const [open, setOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)
  const OPTS: { icon: React.ReactNode; name: string; sub: string; disabled: boolean; onSelect?: (r: DOMRect) => void }[] = [
    { icon: <AppWindow className="size-[15px]" />, name: 'Mini App', sub: 'Visual canvas UI', disabled: hasMiniApp, onSelect: onViewMiniApp },
    { icon: <Braces className="size-[15px]" />, name: 'API', sub: 'Call it like an endpoint', disabled: false },
  ]

  // Close the dropdown when clicking anywhere outside it (incl. the canvas).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <div className="flex w-[360px] flex-col gap-3">
      <ColHeader>Surfaces</ColHeader>
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-surface p-3.5">
        <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-surface-muted text-ink">
          <MessageSquare className="size-[17px]" />
        </div>
        <div className="flex-1">
          <div className="text-[14.5px] font-semibold text-ink">Chat</div>
          <div className="text-[12px] text-ink-secondary">You can chat with the agent</div>
        </div>
        <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">Default</span>
      </div>

      {hasMiniApp && (
        <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-3.5">
          <div className="flex items-center gap-3">
            <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
              <AppWindow className="size-[17px]" />
            </div>
            <div className="flex-1">
              <div className="text-[14.5px] font-semibold text-ink">Mini App</div>
              <div className="text-[12px] text-ink-secondary">Visual canvas UI</div>
            </div>
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
              style={{ background: 'var(--live-soft)', color: 'var(--live)' }}
            >
              <span className="size-1.5 rounded-full" style={{ background: 'var(--live)' }} />
              Live
            </span>
          </div>
          <div className="flex justify-end">
            <ViewButton onClick={(r) => onViewMiniApp(r)} />
          </div>
        </div>
      )}

      <div ref={addRef} data-no-pan className="relative flex flex-col gap-2">
          <div className="flex gap-2.5">
            <button
              onClick={() => setOpen((v) => !v)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[11px] border border-border-strong bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink hover:bg-surface-muted"
            >
              <Plus className="size-[15px] text-ink-secondary" /> Add Surface{' '}
              <ChevronDown className={cn('size-3.5 text-ink-tertiary transition', open && 'rotate-180')} />
            </button>
            {active && (
              <button
                onClick={onFinish}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
              >
                {hasCreated ? 'Save & Update' : 'Create agent'} <ArrowRight className="size-[15px]" />
              </button>
            )}
          </div>
          {open && (
            <div className="cirrus-pop absolute top-full left-0 z-10 mt-2 w-[210px] rounded-[12px] border border-border bg-surface p-1.5 shadow-[0_10px_28px_-8px_rgba(25,25,23,0.15)]">
              {OPTS.map((o) => (
                <button
                  key={o.name}
                  disabled={o.disabled}
                  onClick={(e) => {
                    o.onSelect?.(e.currentTarget.getBoundingClientRect())
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                    o.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-muted',
                  )}
                >
                  <span className="flex size-7 items-center justify-center rounded-md bg-surface-muted text-ink">{o.icon}</span>
                  <span className="flex flex-1 flex-col">
                    <span className="text-[13px] font-semibold text-ink">{o.name}</span>
                    <span className="text-[11px] text-ink-tertiary">{o.sub}</span>
                  </span>
                  {o.disabled && <span className="text-[10px] font-medium text-ink-tertiary">Added</span>}
                </button>
              ))}
            </div>
          )}
        </div>
    </div>
  )
}

function RequirementsPanelContent({
  miniapp,
  onUpdateFlow,
}: {
  miniapp: MiniappRecord
  onUpdateFlow: (partial: CanvasFlowUpdate) => void
}) {
  const name = miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Untitled agent'
  const goal = miniapp.draft?.goal ?? miniapp.manifest?.description ?? ''
  const skills = miniapp.skills ?? []
  const actions = miniapp.manifest?.actions ?? []
  const stateFields = miniapp.manifest?.stateModel?.fields ?? []
  const messages = miniapp.defineMessages?.length ? miniapp.defineMessages : miniapp.messages ?? []
  const [pendingMessages, setPendingMessages] = useState<NonNullable<MiniappRecord['defineMessages']>>([])
  const visibleMessages = [...messages, ...pendingMessages]
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requirementsContext = [
    `Current requirements summary for the draft agent:`,
    `Name: ${name}`,
    goal ? `Goal: ${goal}` : '',
    skills.length
      ? `Capabilities required:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`
      : 'Capabilities required: none planned yet.',
    stateFields.length ? `State model fields: ${stateFields.map((field) => field.name).join(', ')}` : '',
    actions.length ? `Agent actions:\n${actions.map((action) => `- ${action.id}: ${action.description}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visibleMessages.length, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    const stamp = Date.now()
    const userMessage = { id: `requirements-pending-${stamp}-user`, role: 'user' as const, content: text }
    const history: ChatTurn[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ]
    setInput('')
    setPendingMessages((pending) => [...pending, userMessage])
    setBusy(true)
    try {
      const result = await clarifyConcept(miniapp.id, history, requirementsContext)
      if (result.miniapp) {
        setPendingMessages([])
        onUpdateFlow({ draft: result.miniapp.draft, defineMessages: result.miniapp.defineMessages })
      } else {
        const assistantText = result.ready ? `Got it — ${result.name ?? 'agent'}.` : result.question ?? 'Tell me a bit more?'
        setPendingMessages([])
        onUpdateFlow({
          draft: result.ready ? { name: result.name, goal: result.goal } : undefined,
          defineMessages: [
            ...history.map((m, i) => ({ id: `requirements-${stamp}-${i}-${m.role}`, role: m.role, content: m.content })),
            { id: `requirements-${stamp}-${history.length}-assistant`, role: 'assistant', content: assistantText },
          ],
        })
      }
    } catch {
      setPendingMessages([])
      onUpdateFlow({
        defineMessages: [
          ...history.map((m, i) => ({ id: `requirements-${stamp}-${i}-${m.role}`, role: m.role, content: m.content })),
          {
            id: `requirements-${stamp}-${history.length}-assistant`,
            role: 'assistant',
            content: 'Something went wrong — try again?',
          },
        ],
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(280px,340px)] gap-0">
      <div className="min-h-0 overflow-y-auto border-r border-black/5 p-5">
        <div className="space-y-3">
          <div className="rounded-[14px] border border-border bg-white/70 p-4">
            <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">AGENT</div>
            <div className="mt-1 text-[18px] font-bold tracking-tight text-ink">{name}</div>
            {goal && <div className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{goal}</div>}
          </div>

          <div className="rounded-[14px] border border-border bg-white/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-ink">Capabilities required</div>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10.5px] text-ink-tertiary">{skills.length}</span>
            </div>
            {skills.length ? (
              <div className="space-y-2">
                {skills.map((skill) => (
                  <div key={skill.id} className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
                      {CAT_ICON[skill.category] ?? <Newspaper className="size-3.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-semibold text-ink">{skill.name}</span>
                      <span className="line-clamp-2 text-[12px] leading-relaxed text-ink-tertiary">{skill.description}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12.5px] text-ink-tertiary">No capabilities planned yet.</div>
            )}
          </div>

          {(stateFields.length > 0 || actions.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[14px] border border-border bg-white/70 p-4">
                <div className="text-[13px] font-semibold text-ink">State model</div>
                <div className="mt-1 text-[12.5px] text-ink-secondary">{stateFields.length} fields</div>
              </div>
              <div className="rounded-[14px] border border-border bg-white/70 p-4">
                <div className="text-[13px] font-semibold text-ink">Agent actions</div>
                <div className="mt-1 text-[12.5px] text-ink-secondary">{actions.length} actions</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-col bg-white/35">
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {visibleMessages.length ? (
            visibleMessages.map((m) =>
              m.role === 'assistant' ? (
                <div key={m.id} className="flex items-start gap-2">
                  <Avatar sm />
                  <div className="max-w-[92%] rounded-[14px] rounded-bl-[4px] bg-surface-muted px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[92%] rounded-[14px] rounded-br-[4px] bg-primary px-3 py-2 text-[12.5px] leading-relaxed text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ),
            )
          ) : (
            <div className="rounded-[14px] border border-dashed border-border bg-white/60 p-4 text-[12.5px] leading-relaxed text-ink-tertiary">
              No onboarding chat has been saved for this draft.
            </div>
          )}
          {busy && (
            <div className="flex items-center gap-2 pl-1 text-xs text-ink-tertiary">
              <Loader2 className="size-3.5 animate-spin" /> updating…
            </div>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          className="flex items-center gap-2 border-t border-black/5 bg-white/55 px-4 py-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder="Adjust the requirements…"
            className="min-w-0 flex-1 rounded-full border border-border bg-surface px-3.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </form>
      </div>
    </div>
  )
}

/* ──────────────── Edit Skill · floating frosted panel ──────────────── */

function SkillPanel({
  appId,
  miniapp,
  target,
  index,
  origin,
  onClose,
  onFront,
  onBuild,
  buildMessages,
  building,
  canvasRef,
  onState,
  onUpdateFlow,
  onLiveSend,
  liveMessages,
  liveStreaming,
  selectingElement,
  selectedElement,
  onToggleElementSelect,
  onElementSelected,
  onClearSelection,
}: {
  appId: string
  miniapp: MiniappRecord
  target: MiniappSkill | 'requirements' | 'soul' | 'miniapp'
  index: number
  origin: DOMRect | null
  onClose: () => void
  onFront: () => void
  onBuild?: (text: string, agentContent?: string) => void
  buildMessages?: UiMessage[]
  building?: boolean
  canvasRef?: React.Ref<MiniappCanvasHandle>
  onState?: (state: Record<string, unknown>, version: number) => void
  onUpdateFlow: (partial: CanvasFlowUpdate) => void
  onLiveSend?: (text: string) => void
  liveMessages?: UiMessage[]
  liveStreaming?: boolean
  selectingElement?: boolean
  selectedElement?: CanvasElementSelection | null
  onToggleElementSelect?: () => void
  onElementSelected?: (sel: CanvasElementSelection) => void
  onClearSelection?: () => void
}) {
  const isRequirements = target === 'requirements'
  const isSoul = target === 'soul'
  const isMiniApp = target === 'miniapp'
  const skill = isRequirements || isSoul || isMiniApp ? null : (target as MiniappSkill)
  // Start in Edit (build chat) when there's nothing built yet.
  const [appMode, setAppMode] = useState<'preview' | 'edit'>(isMiniApp && !miniapp.html ? 'edit' : 'preview')
  const tools = skill?.tools ?? []
  const hasCredentialsSection = !!skill && (!!skill.credentials?.length || skill.platformSkillId === 'gmail')
  const builtin = !!skill && (skill.kind === 'builtin' || skill.source === 'library')
  const stagger = index * 26 // cascade multiple open panels
  const rootRef = useRef<HTMLDivElement>(null)
  const [max, setMax] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Drag the whole header (windowed mode only; ignores clicks on buttons).
  const [d, setD] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const onHeaderDown = (e: React.PointerEvent) => {
    if (max || (e.target as HTMLElement).closest('button')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: d.x, oy: d.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onHeaderMove = (e: React.PointerEvent) => {
    const g = dragRef.current
    if (!g) return
    setD({ x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) })
  }
  const onHeaderUp = () => {
    dragRef.current = null
  }

  // Resizable via the bottom-right corner.
  const [size, setSize] = useState({ w: 800, h: 560 })
  const sizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    sizeRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = sizeRef.current
    if (!r) return
    setSize({ w: Math.max(460, r.sw + (e.clientX - r.sx)), h: Math.max(320, r.sh + (e.clientY - r.sy)) })
  }
  const onResizeUp = () => {
    sizeRef.current = null
  }

  // Draggable divider between the two columns.
  const [rightW, setRightW] = useState(330)
  const splitRef = useRef<{ sx: number; sw: number } | null>(null)
  const onSplitDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    splitRef.current = { sx: e.clientX, sw: rightW }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onSplitMove = (e: React.PointerEvent) => {
    const s = splitRef.current
    if (!s) return
    setRightW(Math.max(240, Math.min(560, s.sw - (e.clientX - s.sx))))
  }
  const onSplitUp = () => {
    splitRef.current = null
  }

  // Minimize with a shrink-to-card animation (macOS-genie-ish).
  const closeWithAnim = () => {
    const el = rootRef.current
    if (!el || !origin) {
      onClose()
      return
    }
    const r = el.getBoundingClientRect()
    const s = Math.max(0.06, origin.width / r.width)
    const tx = origin.left + origin.width / 2 - (r.left + r.width / 2)
    const ty = origin.top + origin.height / 2 - (r.top + r.height / 2)
    el.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 1, 1), opacity 0.3s ease'
    el.style.transformOrigin = 'center center'
    el.style.transform = `${el.style.transform} translate(${tx}px, ${ty}px) scale(${s})`
    el.style.opacity = '0'
    window.setTimeout(onClose, 285)
  }

  // README content (soul.md for the soul; description for a skill).
  const [readme, setReadme] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (isSoul) getAgentFile(appId, 'soul.md').then(setReadme).catch(() => setReadme(''))
    else if (skill) {
      const slug = skill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'
      getAgentFile(appId, `skills/${slug}/skill.md`)
        .then((content) => setReadme(content || `# ${skill.name}\n\n${skill.description ?? ''}`))
        .catch(() => setReadme(`# ${skill.name}\n\n${skill.description ?? ''}`))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [section, setSection] = useState<string>('readme')
  const scopedIntro = isMiniApp ? 'We can work on this surface here.' : 'We can work on this skill here.'
  const [chat, setChat] = useState<{ role: 'ai' | 'user'; text: string }[]>([
    { role: 'ai', text: scopedIntro },
  ])
  const [input, setInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const sendScopedChat = async (text: string) => {
    const t = text.trim()
    if (!t || chatBusy || (!skill && !isMiniApp)) return
    const next = [...chat, { role: 'user' as const, text: t }]
    setChat(next)
    setInput('')
    setChatBusy(true)
    try {
      const history: ChatTurn[] = next
        .filter((m) => m.text !== scopedIntro)
        .map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }))
      let reply = ''
      if (skill) {
        const out = await chatAboutSkill(appId, skill.id, history)
        if (out.skill) {
          onUpdateFlow({
            skills: (miniapp.skills ?? []).map((s) => (s.id === out.skill!.id ? out.skill! : s)),
          })
        }
        reply = out.reply
      } else {
        const out = await chatAboutSurface(appId, 'miniapp', history)
        reply = out.reply
      }
      setChat((c) => [...c, { role: 'ai', text: reply }])
    } catch (e) {
      setChat((c) => [...c, { role: 'ai', text: `Sorry — ${String((e as Error)?.message ?? e)}` }])
    } finally {
      setChatBusy(false)
    }
  }
  const sendChat = async () => {
    await sendScopedChat(input)
  }
  const scopedChatMessages: UiMessage[] = chat.map((m, i) => ({
    id: `scoped-${i}`,
    role: m.role === 'ai' ? 'assistant' : 'user',
    content: m.text,
  }))
  const surfaceAgentContent = (request: string) =>
    [
      'You are working on the current Mini App surface for this agent. Stay scoped to this surface.',
      '',
      `Agent name: ${miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Untitled agent'}`,
      `Agent purpose: ${miniapp.draft?.goal ?? miniapp.manifest?.description ?? '(unspecified)'}`,
      '',
      'All skills:',
      ...(miniapp.skills?.length
        ? miniapp.skills.map((s) => {
            const toolsList = s.tools?.map((t) => t.name).join(', ') || 'none'
            const credentials = s.credentials?.map((c) => `${c.label}${s.credentialsFilled?.includes(c.key) ? ' configured' : ' missing'}`).join(', ') || 'none'
            return `- ${s.name}: ${s.description ?? '(no description)'}; platform=${s.platformSkillId ?? s.source}; status=${s.status}; tools=${toolsList}; credentials=${credentials}`
          })
        : ['- none']),
      '',
      'All surfaces:',
      '- Chat: default runtime conversation surface.',
      `- Mini App [current]: ${miniapp.html ? 'already built; adjust it if requested' : 'blank/not built yet; build the dashboard surface now'}.`,
      miniapp.manifest ? `Current manifest: ${JSON.stringify(miniapp.manifest).slice(0, 1800)}` : '',
      '',
      'User request for this Mini App surface:',
      request,
    ]
      .filter(Boolean)
      .join('\n')

  const ready = !!skill && skill.status === 'active'
  const deleteSkill = () => {
    if (!skill) return
    onUpdateFlow({
      skills: (miniapp.skills ?? []).filter((s) => s.id !== skill.id),
    })
    setDeleteOpen(false)
    onClose()
  }

  return (
    <div
      ref={rootRef}
      data-no-pan
      onPointerDown={(e) => {
        e.stopPropagation()
        onFront()
      }}
      className={cn('absolute z-50 cursor-default select-text', max ? 'inset-x-6 top-[100px] bottom-6' : 'left-1/2 top-1/2')}
      style={max ? undefined : { width: size.w, transform: `translate(calc(-50% + ${d.x + stagger}px), calc(-50% + ${d.y + stagger}px))` }}
    >
      <div
        className={cn(
          'relative flex flex-col overflow-hidden rounded-[20px] border border-white/70 shadow-[0_26px_64px_-14px_rgba(25,25,23,0.36)]',
          max && 'h-full',
        )}
        style={{ ...(max ? {} : { height: size.h }), background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)' }}
      >
        {/* Title bar (drag anywhere in windowed mode) */}
        <div
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          className={cn('flex select-none items-center gap-3 border-b border-black/5 px-4 py-3', !max && 'cursor-grab active:cursor-grabbing')}
        >
          <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-surface-muted text-ink">
            {isMiniApp ? (
              <AppWindow className="size-[17px]" />
            ) : isRequirements ? (
              <Sparkles className="size-[17px]" />
            ) : isSoul ? (
              <Sparkles className="size-[17px]" />
            ) : (
              CAT_ICON[skill!.category] ?? <Newspaper className="size-[17px]" />
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15.5px] font-bold tracking-tight text-ink">
                {isMiniApp ? miniapp.manifest?.name ?? 'Mini App' : isRequirements ? 'Define Requirements' : isSoul ? 'Soul' : skill!.name}
              </span>
              {skill && (
                <span
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={builtin ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' } : { background: '#FBF0D6', color: '#9A6B12' }}
                >
                  {builtin ? 'Built-in' : 'custom'}
                </span>
              )}
              {skill && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={ready ? { background: 'var(--live-soft)', color: 'var(--live)' } : { background: 'var(--surface-muted)', color: 'var(--ink-secondary)' }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: ready ? 'var(--live)' : 'var(--ink-tertiary)' }} />
                  {ready ? 'Ready' : 'Not Ready'}
                </span>
              )}
              {isMiniApp && (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ background: 'var(--live-soft)', color: 'var(--live)' }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: 'var(--live)' }} />
                  Live
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-ink-tertiary">
              {isMiniApp ? 'channels/canvas' : isRequirements ? 'requirements / onboarding' : isSoul ? 'soul.md' : `skills/${skill!.name}`}
            </div>
          </div>
          {/* Element-select (Edit mode), left of the toggle */}
          {isMiniApp && appMode === 'edit' && onToggleElementSelect && (
            <button
              onClick={onToggleElementSelect}
              aria-label="Select element"
              className={cn(
                'flex size-[30px] items-center justify-center rounded-lg border',
                selectingElement ? 'border-transparent bg-primary text-primary-foreground' : 'border-border text-ink-secondary hover:bg-surface-muted',
              )}
            >
              <MousePointer2 className="size-4" />
            </button>
          )}
          {/* Preview / Edit toggle (mini app only) */}
          {isMiniApp && onBuild && (
            <div className="mr-1 inline-flex items-center rounded-lg border border-border bg-surface-muted p-0.5">
              {(['preview', 'edit'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setAppMode(m)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] font-semibold capitalize',
                    appMode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary hover:text-ink',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          {/* maximize / restore */}
          <button
            onClick={() => setMax((m) => !m)}
            className="flex size-[30px] items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
            aria-label={max ? 'Restore' : 'Maximize'}
          >
            {max ? <Minimize2 className="size-4 text-ink-secondary" /> : <Maximize2 className="size-4 text-ink-secondary" />}
          </button>
          {/* minimize */}
          <button
            onClick={closeWithAnim}
            className="flex size-[30px] items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
            aria-label="Minimize"
          >
            <Minus className="size-4 text-ink-secondary" />
          </button>
        </div>

        {/* Body: the app canvas + a chat sidebar — usage chat in Preview, build chat in Edit */}
        {isMiniApp ? (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-hidden bg-surface-muted">
              <MiniappCanvas
                ref={canvasRef}
                miniapp={miniapp}
                onState={onState}
                chrome={false}
                canSelectElements={appMode === 'edit'}
                selectingElement={appMode === 'edit' && !!selectingElement}
                selectedElement={appMode === 'edit' ? selectedElement ?? null : null}
                onToggleElementSelect={onToggleElementSelect ?? (() => {})}
                onElementSelected={onElementSelected ?? (() => {})}
              />
            </div>
            <div
              onPointerDown={onSplitDown}
              onPointerMove={onSplitMove}
              onPointerUp={onSplitUp}
              className="w-1.5 shrink-0 cursor-col-resize bg-black/5 transition-colors hover:bg-primary/40"
            />
            <div className="flex min-h-0 shrink-0 flex-col" style={{ width: rightW }}>
              <BuildChat
                title=""
                placeholder={miniapp.html ? 'Describe a surface change…' : 'Describe the mini app surface…'}
                empty={
                  miniapp.html
                    ? 'Discuss or adjust how this mini app surface supports the agent purpose, skills, and user workflow.'
                    : 'Describe the dashboard surface to build for this agent.'
                }
                messages={onBuild ? buildMessages ?? [] : scopedChatMessages}
                building={onBuild ? !!building : chatBusy}
                busyLabel="working..."
                onSend={(text) => (onBuild ? onBuild(text, surfaceAgentContent(text)) : void sendScopedChat(text))}
                attachmentLabel={onBuild && appMode === 'edit' ? selectedElement?.label : undefined}
                onClearAttachment={onBuild && appMode === 'edit' ? onClearSelection : undefined}
              />
            </div>
          </div>
        ) : isRequirements ? (
          <RequirementsPanelContent miniapp={miniapp} onUpdateFlow={onUpdateFlow} />
        ) : (
          <div className="flex min-h-0 flex-1">
          {/* Left: collapsible README + tool calls */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]">
            <Collapsible
              title="README"
              meta={isSoul ? 'soul.md' : 'skill.md'}
              open={section === 'readme'}
              onToggle={() => setSection((s) => (s === 'readme' ? '' : 'readme'))}
            >
              <textarea
                value={readme}
                onChange={(e) => {
                  setReadme(e.target.value)
                  setSaved(false)
                }}
                rows={5}
                className="min-h-[120px] w-full resize-y rounded-[9px] border border-border-strong bg-surface p-3 font-mono text-[12px] leading-relaxed text-ink-secondary outline-none focus:border-primary"
              />
              {(isSoul || skill) && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      const path = isSoul
                        ? 'soul.md'
                        : `skills/${skill!.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'}/skill.md`
                      putAgentFile(appId, path, readme).then(() => setSaved(true)).catch(() => {})
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90"
                  >
                    <Check className="size-3.5" /> Save
                  </button>
                  {saved && <span className="text-[11px] text-live">Saved to {isSoul ? 'soul.md' : 'skill.md'}</span>}
                </div>
              )}
            </Collapsible>

            {!isSoul && (
              <>
                <div className="px-1 font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">TOOL CALLS · {tools.length}</div>
                {tools.length === 0 && (
                  <div className="rounded-[12px] border border-dashed border-border p-3 text-[12px] text-ink-tertiary">
                    No tool calls yet — this skill is still being built.
                  </div>
                )}
                {tools.map((t) => (
                  <ToolCallCard
                    key={t.name}
                    appId={appId}
                    skillId={skill!.id}
                    tool={t}
                    open={section === t.name}
                    onToggle={() => setSection((s) => (s === t.name ? '' : t.name))}
                  />
                ))}
                {hasCredentialsSection && (
                  <>
                    <div className="pt-1 px-1 font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">
                      CREDENTIALS
                    </div>
                    <div className="px-1 pb-1 text-[11px] leading-relaxed text-ink-tertiary">
                      Saved as a default for your own testing. When this agent is shared or run by someone else, these are ignored — each runtime supplies its own credentials.
                    </div>
                    <Collapsible
                      title="Auth"
                      meta={skillNeedsCredentials(skill) ? 'default' : 'set'}
                      open={section === 'credentials'}
                      onToggle={() => setSection((s) => (s === 'credentials' ? '' : 'credentials'))}
                    >
                      <div className="flex flex-col gap-3">
                        {!!skill.credentials?.length && (
                          <SkillCredentialsPanel
                            appId={appId}
                            skill={skill}
                            onUpdate={(partial) =>
                              onUpdateFlow({
                                skills: (miniapp.skills ?? []).map((s) => (s.id === skill.id ? { ...s, ...partial } : s)),
                              })
                            }
                          />
                        )}
                        {skill.platformSkillId === 'gmail' && <GmailSkillDiagnostics appId={appId} skill={skill} />}
                      </div>
                    </Collapsible>
                  </>
                )}
                {skill?.platformSkillId === 'dataset_library' && (
                  <>
                    <div className="pt-1 px-1 font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">
                      AGENT DATASET
                    </div>
                    <Collapsible
                      title="Importer"
                      meta={skill.config?.rowCount ? `${skill.config.rowCount} rows` : 'agent script'}
                      open={section === 'dataset-import'}
                      onToggle={() => setSection((s) => (s === 'dataset-import' ? '' : 'dataset-import'))}
                    >
                      <DatasetSkillLoader
                        appId={appId}
                        skill={skill}
                        onUpdate={(partial) =>
                          onUpdateFlow({
                            skills: (miniapp.skills ?? []).map((s) => (s.id === skill.id ? { ...s, ...partial } : s)),
                          })
                        }
                      />
                    </Collapsible>
                    <Collapsible
                      title="Viewer"
                      meta="tables"
                      open={section === 'dataset-viewer'}
                      onToggle={() => setSection((s) => (s === 'dataset-viewer' ? '' : 'dataset-viewer'))}
                    >
                      <DatabaseSkillDiagnostics appId={appId} embedded />
                    </Collapsible>
                  </>
                )}
                {skill?.platformSkillId === 'database' && <DatabaseSkillDiagnostics appId={appId} />}
                {skill && (
                  <div className="mt-auto pt-2">
                    <button
                      type="button"
                      onClick={() => setDeleteOpen(true)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-100"
                    >
                      <Trash2 className="size-3.5" />
                      Delete skill
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Draggable column divider */}
          <div
            onPointerDown={onSplitDown}
            onPointerMove={onSplitMove}
            onPointerUp={onSplitUp}
            className="w-1.5 shrink-0 cursor-col-resize bg-black/5 transition-colors hover:bg-primary/40"
          />

          {/* Right: AI chat */}
          <div className="flex min-h-0 min-w-0 shrink-0 flex-col" style={{ width: rightW, maxWidth: 'calc(100% - 120px)' }}>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              {chat.map((m, i) =>
                m.role === 'ai' ? (
                  <div key={i} className="flex items-start gap-2">
                    <Avatar sm />
                    <div className="min-w-0 max-w-[92%] rounded-[14px] rounded-bl-[4px] bg-surface-muted px-3 py-2 text-[13px] leading-snug text-ink">
                      <ErrorBoundary
                        resetKey={`skill-chat-${i}:${m.text}`}
                        fallback={(error) => (
                          <div className="space-y-2">
                            <div className="rounded-[10px] border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700">
                              Message markdown failed to render: {error.message}
                            </div>
                            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-snug text-ink">{m.text}</pre>
                          </div>
                        )}
                      >
                        <MessageResponse className="overflow-hidden break-words text-[13px] leading-snug">{m.text}</MessageResponse>
                      </ErrorBoundary>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-end">
                    <div className="min-w-0 max-w-[92%] whitespace-pre-wrap break-words rounded-[14px] rounded-br-[4px] bg-primary px-3 py-2 text-[13px] leading-snug text-primary-foreground">{m.text}</div>
                  </div>
                ),
              )}
              {chatBusy && (
                <div className="flex items-center gap-2">
                  <Avatar sm />
                  <div className="flex items-center gap-1 rounded-[14px] rounded-bl-[4px] bg-surface-muted px-3 py-2.5">
                    <span className="cirrus-dot size-1.5 rounded-full bg-ink-tertiary" style={{ animationDelay: '0s' }} />
                    <span className="cirrus-dot size-1.5 rounded-full bg-ink-tertiary" style={{ animationDelay: '0.2s' }} />
                    <span className="cirrus-dot size-1.5 rounded-full bg-ink-tertiary" style={{ animationDelay: '0.4s' }} />
                  </div>
                </div>
              )}
            </div>
            <div className="min-w-0 border-t border-black/5 p-3">
              <div className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-strong bg-white/80 py-1.5 pl-3.5 pr-1.5">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void sendChat() }}
                  placeholder="Ask or instruct…"
                  className="min-w-0 flex-1 overflow-hidden bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-tertiary"
                />
                <button
                  onClick={() => void sendChat()}
                  disabled={chatBusy || !input.trim()}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  aria-label="Send"
                >
                  <ArrowUp className="size-[15px]" />
                </button>
              </div>
            </div>
          </div>
          </div>
        )}

        {skill && (
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogContent className="max-w-[380px] rounded-[16px] border border-border bg-surface p-5 shadow-[0_24px_64px_-20px_rgba(25,25,23,0.45)]">
              <DialogHeader>
                <DialogTitle className="text-[16px] text-ink">Delete skill?</DialogTitle>
                <DialogDescription className="text-[13px] leading-relaxed text-ink-secondary">
                  This removes "{skill.name}" from this agent. This cannot be undone from the editor history.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:justify-end">
                <DialogClose asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-[9px] border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:bg-surface-muted"
                  >
                    Cancel
                  </button>
                </DialogClose>
                <button
                  type="button"
                  onClick={deleteSkill}
                  className="inline-flex items-center justify-center gap-1.5 rounded-[9px] bg-red-600 px-3 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-red-700"
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Corner resize handle */}
        <div
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          className="absolute bottom-0.5 right-0.5 flex size-4 cursor-nwse-resize items-center justify-center text-ink-tertiary"
          aria-label="Resize"
        >
          <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
            <path d="M9 2 L2 9 M9 6 L6 9" />
          </svg>
        </div>
      </div>
    </div>
  )
}

function Collapsible({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string
  meta?: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="shrink-0 overflow-hidden rounded-[12px] border border-black/5 bg-white/60">
      <button onClick={onToggle} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <ChevronRight className={cn('size-4 shrink-0 text-ink-tertiary transition-transform', open && 'rotate-90')} />
        <span className="text-[13px] font-semibold text-ink">{title}</span>
        <span className="flex-1" />
        {meta && <span className="font-mono text-[10.5px] text-ink-tertiary">{meta}</span>}
      </button>
      {open && <div className="px-3.5 pb-3.5">{children}</div>}
    </div>
  )
}

function ToolCallCard({
  appId,
  skillId,
  tool,
  open,
  onToggle,
}: {
  appId: string
  skillId: string
  tool: SkillToolCall
  open: boolean
  onToggle: () => void
}) {
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState<{ ok: boolean; result?: unknown; error?: string } | null>(null)
  const [inputText, setInputText] = useState('{}')
  const params = ((tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}
  const canTest = !!(tool.builtin || tool.entry)
  const run = async () => {
    setRunning(true)
    setOut(null)
    try {
      const input = inputText.trim() ? JSON.parse(inputText) : {}
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.')
      setOut(await testSkillTool(appId, skillId, tool.name, input as Record<string, unknown>))
    } catch (e) {
      setOut({ ok: false, error: String((e as Error)?.message ?? e) })
    } finally {
      setRunning(false)
    }
  }
  return (
    <div className="shrink-0 overflow-hidden rounded-[12px] border border-black/5 bg-white/60">
      <button onClick={onToggle} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <ChevronRight className={cn('size-4 shrink-0 text-ink-tertiary transition-transform', open && 'rotate-90')} />
        <span className="font-mono text-[13px] font-semibold text-ink">{tool.name}</span>
        <span className="flex-1" />
        {canTest && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              if (!open) onToggle()
              void run()
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:bg-surface-muted"
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} Test
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3.5 pb-3.5">
          {tool.description && <div className="text-[12px] text-ink-secondary">{tool.description}</div>}
          {!!Object.keys(params).length && (
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(params).map((k) => (
                <span key={k} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
                  {k}
                </span>
              ))}
            </div>
          )}
          {canTest && (
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              spellCheck={false}
              className="min-h-20 resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              placeholder='{"path": "/health"}'
            />
          )}
          {out && (
            <pre
              className={cn(
                'max-h-60 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed',
                out.ok ? 'border-live/40 bg-live-soft/50 text-ink' : 'border-amber-300/60 bg-amber-50 text-ink',
              )}
            >
              {(out.ok ? JSON.stringify(out.result, null, 2) : out.error || 'failed')?.slice(0, 1200)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ───────── My Agents ───────── */

export function MyAgentsPage({
  agents,
  onOpen,
  onNew,
  onRemove,
  onNavigate,
}: {
  agents: MiniappRecord[]
  onOpen: (id: string) => void
  onNew: () => void
  onRemove: (id: string) => void
  onNavigate: (v: NavView) => void
}) {
  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className={PAGE_CONTAINER_CLASS}>
        <div className={PAGE_HEADER_CLASS}>
          <h1 className="text-[28px] font-bold tracking-tight text-ink">My Agents</h1>
          <button
            onClick={onNew}
            className="inline-flex w-fit items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
          >
            <Plus className="size-[15px]" /> New agent
          </button>
        </div>
        {agents.length === 0 ? (
          <EmptyAgents onNew={onNew} onBrowseCommunity={() => onNavigate('community')} />
        ) : (
          <div className={PAGE_GRID_CLASS}>
            {agents.map((a) => (
              <AgentCard key={a.id} agent={a} onClick={() => onOpen(a.id)} onRemove={() => onRemove(a.id)} />
            ))}
            <button
              onClick={onNew}
              className="flex min-h-[152px] flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-white text-ink-tertiary hover:bg-surface-muted"
            >
              <Plus className="size-6" />
              <span className="text-[13px] font-medium">Create a new agent</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyAgents({ onNew, onBrowseCommunity }: { onNew: () => void; onBrowseCommunity: () => void }) {
  return (
    <div className="mt-7 flex flex-col items-center justify-center gap-5 rounded-[20px] border border-dashed border-border-strong bg-white/40 px-4 py-14 text-center sm:py-20">
      <div className="relative">
        <div className="cirrus-float flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#837DFF] text-primary-foreground shadow-[0_14px_34px_-10px_rgba(91,87,242,0.55)]">
          <Sparkles className="size-7" />
        </div>
        <div className="cirrus-float-rev absolute -right-5 -top-3 size-3 rounded-full bg-primary/25" />
        <div className="cirrus-float-slow absolute -left-6 bottom-0 size-2.5 rounded-full bg-primary/20" />
      </div>
      <div>
        <div className="text-[17px] font-bold tracking-tight text-ink">No agents yet — a blank canvas awaits</div>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-secondary">
          An agent can chat, run skills, and even show its own little app. Describe what you want and watch it come to life.
        </p>
      </div>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
      >
        <Plus className="size-[15px]" /> Create your first agent
      </button>
      <button
        onClick={onBrowseCommunity}
        className="group inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-secondary hover:text-ink"
      >
        <Globe className="size-[14px]" /> Or browse community agents
        <ArrowRight className="size-[13px] transition-transform group-hover:translate-x-0.5" />
      </button>
    </div>
  )
}

function AgentCard({ agent, onClick, onRemove }: { agent: MiniappRecord; onClick: () => void; onRemove: () => void }) {
  const name = agent.draft?.name ?? agent.manifest?.name ?? 'Untitled agent'
  const goal = agent.draft?.goal ?? agent.manifest?.description ?? 'No description yet.'
  const ready = (agent.creationPhase ?? 'define') === 'done'
  const skills = (agent.skills ?? []).length
  const [menuOpen, setMenuOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const agentRef: RuntimeAgentRef = { key: 'own:' + agent.id, name, source: 'own', miniappId: agent.id }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick() }}
      className="group relative flex min-h-[152px] cursor-pointer flex-col gap-3 rounded-[16px] border border-border bg-white p-5 text-left shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)] transition-shadow hover:shadow-[0_12px_30px_-12px_rgba(25,25,23,0.18)]"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
          <Sparkles className="size-[17px]" />
        </div>
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{name}</div>
      </div>
      <div className="line-clamp-2 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">{goal}</div>
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={ready ? { background: 'var(--live-soft)', color: 'var(--live)' } : { background: 'var(--surface-muted)', color: 'var(--ink-secondary)' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: ready ? 'var(--live)' : 'var(--ink-tertiary)' }} />
          {ready ? 'Ready' : 'Draft'}
        </span>
        {skills > 0 && <span className="text-[11px] text-ink-tertiary">{skills} skills</span>}

        {/* hover actions — share the badge row so they're vertically centered with it */}
        <div className="ml-auto flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); setAddOpen(false) }}
              className="flex size-7 items-center justify-center rounded-[8px] border border-border bg-surface text-ink-secondary shadow-sm hover:bg-surface-muted"
              aria-label="More"
            >
              <MoreHorizontal className="size-[15px]" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenuOpen(false) }} />
                <div className="absolute bottom-9 right-0 z-50 w-36 overflow-hidden rounded-[10px] border border-border bg-surface p-1 shadow-[0_14px_34px_-12px_rgba(25,25,23,0.28)]">
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onRemove() }}
                    className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-[14px]" /> Remove
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            disabled={!ready}
            onClick={(e) => { e.stopPropagation(); setAddOpen(true); setMenuOpen(false) }}
            className="flex size-7 items-center justify-center rounded-[8px] border border-border bg-surface text-ink-secondary shadow-sm hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Add to runtime"
            title={ready ? 'Add to runtime' : 'Finish creating this agent before adding to runtime'}
          >
            <Plus className="size-[15px]" />
          </button>
        </div>
      </div>

      {addOpen &&
        createPortal(
          <AddToRuntimeDialog agentRef={agentRef} agentName={name} onClose={() => setAddOpen(false)} />,
          document.body,
        )}
    </div>
  )
}

function AddToRuntimeDialog({
  agentRef,
  agentName,
  onClose,
  onNavigateRuntime,
}: {
  agentRef: RuntimeAgentRef
  agentName: string
  onClose: () => void
  onNavigateRuntime?: () => void
}) {
  const [runtimes, setRuntimes] = useState<RuntimeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    void listRuntimes().then(setRuntimes).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const finish = (msg: string) => {
    setDone(msg)
    // Navigating to the Runtimes page unmounts this dialog; fall back to closing.
    setTimeout(() => (onNavigateRuntime ? onNavigateRuntime() : onClose()), 700)
  }

  const addTo = async (rt: RuntimeRecord) => {
    setBusy(true)
    try {
      await addRuntimeAgent(rt.id, agentRef)
      finish(`Added to ${rt.name}.`)
    } finally {
      setBusy(false)
    }
  }

  const runNew = async () => {
    setBusy(true)
    try {
      await apiCreateRuntime(`${agentName} runtime`, [agentRef])
      finish('New runtime created.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-4 sm:p-6" onMouseDown={onClose}>
      <div
        className="cirrus-pop flex max-h-[80vh] w-full max-w-[460px] flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-[16px] font-bold tracking-tight text-ink">Run “{agentName}”</div>
            <div className="text-[12.5px] text-ink-secondary">Add it to a runtime, or spin up a new one.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-muted">
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <button
            onClick={runNew}
            disabled={busy}
            className="flex items-center gap-3 rounded-[12px] border border-primary bg-accent-soft px-3.5 py-3 text-left transition hover:opacity-90 disabled:opacity-50"
          >
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
              <Plus className="size-[17px]" />
            </span>
            <span>
              <span className="block text-[13.5px] font-semibold text-ink">Run in a new runtime</span>
              <span className="block text-[12px] text-ink-secondary">Provision a fresh sandbox just for this agent.</span>
            </span>
          </button>

          <div className="flex flex-col gap-2">
            <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">ADD TO A RUNTIME</div>
            {loading ? (
              <div className="flex justify-center py-4 text-ink-tertiary"><Loader2 className="size-5 animate-spin" /></div>
            ) : runtimes.length === 0 ? (
              <div className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[12.5px] text-ink-tertiary">
                No runtimes yet — create one above.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {runtimes.map((rt) => {
                  const already = rt.agents.some((a) => a.key === agentRef.key)
                  return (
                    <button
                      key={rt.id}
                      onClick={() => !already && addTo(rt)}
                      disabled={busy || already}
                      className="flex items-center gap-2.5 rounded-[11px] border border-border bg-surface px-3 py-2.5 text-left transition hover:bg-surface-muted disabled:opacity-60"
                    >
                      <span className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink">
                        <Server className="size-[14px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-ink">{rt.name}</span>
                        <span className="block text-[11px] text-ink-tertiary">
                          {rt.agents.length} agent{rt.agents.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      {already ? (
                        <span className="text-[11px] font-semibold text-ink-tertiary">Added</span>
                      ) : (
                        <Plus className="size-4 text-ink-secondary" />
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {done && <div className="text-center text-[12.5px] font-semibold text-live">{done}</div>}
        </div>
      </div>
    </div>
  )
}

/* ───────── Community ───────── */

type CommunityAgent = {
  name: string
  desc: string
  tag: string
  logoSrc: string
  logoAlt: string
  color: string
}

const COMMUNITY: CommunityAgent[] = [
  {
    name: 'Hermes',
    desc: 'Multi-agent orchestration framework for complex, long-running workflows.',
    tag: 'Framework',
    logoSrc: '/community-agents/hermes.png',
    logoAlt: 'Hermes Agent logo',
    color: '#0000F2',
  },
  {
    name: 'OpenClaw',
    desc: 'Open web-browsing automation agent that drives real sites.',
    tag: 'Browser',
    logoSrc: '/community-agents/openclaw.svg',
    logoAlt: 'OpenClaw logo',
    color: '#EF4444',
  },
  {
    name: 'Pi Agent',
    desc: 'Lightweight, framework-agnostic tool-calling agent core.',
    tag: 'Core',
    logoSrc: '/community-agents/pi-agent.svg',
    logoAlt: 'Pi Agent logo',
    color: '#191917',
  },
  {
    name: 'Claude Code',
    desc: "Anthropic's agentic coding assistant for the terminal & IDE.",
    tag: 'Coding',
    logoSrc: '/community-agents/claude.svg',
    logoAlt: 'Claude logo',
    color: '#D97757',
  },
  {
    name: 'Codex',
    desc: "OpenAI's autonomous software-engineering agent.",
    tag: 'Coding',
    logoSrc: '/community-agents/codex.svg',
    logoAlt: 'Codex logo',
    color: '#111827',
  },
  {
    name: 'OpenCode',
    desc: 'Open-source AI coding agent you can run anywhere.',
    tag: 'Coding',
    logoSrc: '/community-agents/opencode.png',
    logoAlt: 'OpenCode logo',
    color: '#475569',
  },
]

function communityAgentRef(agent: CommunityAgent): RuntimeAgentRef {
  return { key: `community:${agent.name}`, name: agent.name, source: 'community' }
}

// Staggered reveal for the expandable card's hidden content (cult-ui style:
// each row springs/fades in).
const EXPAND_ITEM: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', bounce: 0.3, duration: 0.4 } },
}

type CommunityItem = { kind: 'hardcoded'; agent: CommunityAgent } | { kind: 'published'; agent: PublishedAgent }

export function CommunityPage({ onNavigate }: { onNavigate: (v: NavView) => void }) {
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [published, setPublished] = useState<PublishedAgent[]>([])
  useEffect(() => {
    void getCommunityUsage().then(setUsage)
    void listPublishedAgents().then(setPublished)
  }, [])
  // The 6 hardcoded framework agents come first; user-published agents follow.
  const items: CommunityItem[] = [
    ...COMMUNITY.map((agent) => ({ kind: 'hardcoded' as const, agent })),
    ...published.map((agent) => ({ kind: 'published' as const, agent })),
  ]
  // Masonry columns: each column is an independent flex stack, so expanding one
  // card only grows its own column — other columns are untouched.
  const lg = useMediaQuery('(min-width: 1024px)')
  const sm = useMediaQuery('(min-width: 640px)')
  const cols = lg ? 3 : sm ? 2 : 1
  const columns = Array.from({ length: cols }, (_, c) => items.filter((_, i) => i % cols === c))
  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className={PAGE_CONTAINER_CLASS}>
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-ink">Community Agents</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-secondary">Agents shared by the community — open one to explore or fork.</p>
        </div>
        <div className="mt-6 flex items-start gap-4 sm:mt-7">
          {columns.map((colItems, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-4">
              {colItems.map((it) =>
                it.kind === 'hardcoded' ? (
                  <CommunityAgentCard key={'h-' + it.agent.name} agent={it.agent} usedIn={usage[`community:${it.agent.name}`] ?? 0} onNavigate={onNavigate} />
                ) : (
                  <PublishedAgentCard key={'p-' + it.agent.id} agent={it.agent} onNavigate={onNavigate} />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PublishedAgentCard({ agent, onNavigate }: { agent: PublishedAgent; onNavigate: (v: NavView) => void }) {
  const [addOpen, setAddOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const agentRef: RuntimeAgentRef = { key: `own:${agent.id}`, name: agent.name, source: 'own', miniappId: agent.id }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      aria-expanded={expanded}
      className="flex min-h-[152px] cursor-pointer flex-col gap-3 rounded-[16px] border border-border bg-white p-5 text-left shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)] transition-shadow hover:shadow-[0_12px_30px_-12px_rgba(25,25,23,0.18)]"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
          <Sparkles className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{agent.name}</div>
        <ChevronDown className={cn('size-4 shrink-0 text-ink-tertiary transition-transform duration-200', expanded && 'rotate-180')} />
      </div>
      <div className={cn('flex-1 text-[12.5px] leading-relaxed text-ink-secondary', !expanded && 'line-clamp-2')}>
        {agent.description || 'A community-published agent.'}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">Community</span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="more"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: 'spring', bounce: 0.3, duration: 0.5 }, opacity: { duration: 0.15 } }}
            style={{ overflow: 'hidden' }}
          >
            <motion.div
              className="mt-1 flex flex-col gap-3 border-t border-border pt-3"
              variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } }, hidden: {} }}
              initial="hidden"
              animate="show"
            >
              <motion.div variants={EXPAND_ITEM} className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-[9px] font-bold text-accent-ink">C</span>
                Published by <span className="font-semibold text-ink">Cirrus user</span>
              </motion.div>
              <motion.div variants={EXPAND_ITEM} className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Server className="size-4 text-ink-tertiary" />
                Runs as a shared Mini App agent
              </motion.div>
              <motion.button
                variants={EXPAND_ITEM}
                onClick={(e) => { e.stopPropagation(); setAddOpen(true) }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
              >
                Use this agent <ArrowRight className="size-[15px]" />
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {addOpen &&
        createPortal(
          <AddToRuntimeDialog agentRef={agentRef} agentName={agent.name} onClose={() => setAddOpen(false)} onNavigateRuntime={() => onNavigate('runtime')} />,
          document.body,
        )}
    </div>
  )
}

function CommunityAgentCard({ agent, usedIn, onNavigate }: { agent: CommunityAgent; usedIn: number; onNavigate: (v: NavView) => void }) {
  const [addOpen, setAddOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const agentRef = communityAgentRef(agent)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      aria-expanded={expanded}
      className="flex min-h-[152px] cursor-pointer flex-col gap-3 rounded-[16px] border border-border bg-white p-5 text-left shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)] transition-shadow hover:shadow-[0_12px_30px_-12px_rgba(25,25,23,0.18)]"
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] border border-black/[0.04]"
          style={{ background: `${agent.color}14` }}
        >
          <img src={agent.logoSrc} alt={agent.logoAlt} className="size-[22px] object-contain" draggable={false} />
        </div>
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{agent.name}</div>
        <ChevronDown className={cn('size-4 shrink-0 text-ink-tertiary transition-transform duration-200', expanded && 'rotate-180')} />
      </div>
      <div className={cn('flex-1 text-[12.5px] leading-relaxed text-ink-secondary', !expanded && 'line-clamp-2')}>{agent.desc}</div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">{agent.tag}</span>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="more"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: { type: 'spring', bounce: 0.3, duration: 0.5 }, opacity: { duration: 0.15 } }}
            style={{ overflow: 'hidden' }}
          >
            <motion.div
              className="mt-1 flex flex-col gap-3 border-t border-border pt-3"
              variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.08 } }, hidden: {} }}
              initial="hidden"
              animate="show"
            >
              <motion.div variants={EXPAND_ITEM} className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <span className="grid size-5 place-items-center rounded-full bg-accent-soft text-[9px] font-bold text-accent-ink">C</span>
                Created by <span className="font-semibold text-ink">Cirrus</span>
              </motion.div>
              <motion.div variants={EXPAND_ITEM} className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Server className="size-4 text-ink-tertiary" />
                Used in <span className="font-semibold text-ink">{usedIn}</span> runtime{usedIn === 1 ? '' : 's'}
              </motion.div>
              <motion.button
                variants={EXPAND_ITEM}
                onClick={(e) => { e.stopPropagation(); setAddOpen(true) }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
              >
                Use this agent <ArrowRight className="size-[15px]" />
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {addOpen &&
        createPortal(
          <AddToRuntimeDialog agentRef={agentRef} agentName={agent.name} onClose={() => setAddOpen(false)} onNavigateRuntime={() => onNavigate('runtime')} />,
          document.body,
        )}
    </div>
  )
}

export function ComingSoon({ title, onNavigate }: { title: string; onNavigate: (v: NavView) => void }) {
  return (
    <div className="dot-bg relative grid h-full w-full place-items-center">
      <div className="relative z-10 text-center">
        <div className="text-[22px] font-bold tracking-tight text-ink">{title}</div>
        <div className="mt-1.5 text-[14px] text-ink-secondary">Coming soon.</div>
      </div>
    </div>
  )
}

/* ───────── Runtimes ───────── */

const agentName = (a: MiniappRecord) => a.draft?.name ?? a.manifest?.name ?? 'Untitled agent'

export function RuntimesPage({
  agents,
  onNavigate,
}: {
  agents: MiniappRecord[]
  onNavigate: (v: NavView) => void
}) {
  const [runtimes, setRuntimes] = useState<RuntimeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  // Open runtimes are floating windows (like the agent-canvas skill panels);
  // last in the array renders on top.
  const [panels, setPanels] = useState<{ id: string; origin: DOMRect | null }[]>([])
  const openPanel = (id: string, origin: DOMRect | null) =>
    setPanels((ps) => [...ps.filter((p) => p.id !== id), { id, origin }])
  const closePanel = (id: string) => setPanels((ps) => ps.filter((p) => p.id !== id))
  const frontPanel = (id: string) =>
    setPanels((ps) => {
      const it = ps.find((p) => p.id === id)
      return it ? [...ps.filter((p) => p.id !== id), it] : ps
    })

  const refresh = async () => {
    try {
      setRuntimes(await listRuntimes())
    } catch {
      /* backend offline — keep what we have */
    }
  }

  useEffect(() => {
    void refresh().finally(() => setLoading(false))
  }, [])

  // Poll active E2B runtimes so badges reflect the real sandbox state.
  const provisioning = runtimes.some((r) => r.status === 'provisioning')
  const hasE2BRuntime = runtimes.some((r) => r.sandboxKind === 'e2b' && !!r.sandboxId)
  useEffect(() => {
    if (!provisioning && !hasE2BRuntime) return
    const t = setInterval(() => void refresh(), provisioning ? 1500 : 10000)
    return () => clearInterval(t)
  }, [hasE2BRuntime, provisioning])

  const create = async (name: string, picked: RuntimeAgentRef[]) => {
    setCreating(false)
    try {
      const rt = await apiCreateRuntime(name, picked)
      setRuntimes((prev) => [rt, ...prev])
    } catch {
      /* ignore — surfaced by the empty list */
    }
  }

  const remove = async (id: string) => {
    setRuntimes((prev) => prev.filter((r) => r.id !== id))
    closePanel(id)
    await apiDeleteRuntime(id).catch(() => {})
  }

  const rename = async (id: string, name: string) => {
    const nextName = name.trim()
    if (!nextName) return
    setRuntimes((prev) => prev.map((r) => (r.id === id ? { ...r, name: nextName } : r)))
    try {
      const updated = await updateRuntimeName(id, nextName)
      setRuntimes((prev) => prev.map((r) => (r.id === id ? updated : r)))
    } catch {
      void refresh()
    }
  }

  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className={PAGE_CONTAINER_CLASS}>
        <div className={PAGE_HEADER_CLASS}>
          <div>
            <h1 className="text-[28px] font-bold tracking-tight text-ink">Runtimes</h1>
            <p className="mt-1.5 text-[13.5px] text-ink-secondary">A runtime hosts one or more agents in a live sandbox.</p>
          </div>
          {runtimes.length > 0 && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex w-fit items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
            >
              <Plus className="size-[15px]" /> Create New
            </button>
          )}
        </div>

        {loading ? (
          <div className="mt-20 flex justify-center text-ink-tertiary">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : runtimes.length === 0 ? (
          <EmptyRuntimes onCreate={() => setCreating(true)} />
        ) : (
          <div className={PAGE_GRID_CLASS}>
            {runtimes.map((rt) => (
              <RuntimeCard
                key={rt.id}
                runtime={rt}
                onOpen={(origin) => openPanel(rt.id, origin)}
                onRename={(name) => rename(rt.id, name)}
                onDelete={() => remove(rt.id)}
              />
            ))}
            <button
              onClick={() => setCreating(true)}
              className="flex min-h-[152px] flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-white text-ink-tertiary hover:bg-surface-muted"
            >
              <Plus className="size-6" />
              <span className="text-[13px] font-medium">Create New</span>
            </button>
          </div>
        )}
      </div>

      {/* Floating runtime windows (draggable / resizable / maximizable) */}
      {panels.map((p, i) => (
        <ErrorBoundary
          key={p.id}
          resetKey={p.id}
          fallback={(error, errorInfo) => (
            <RuntimeWindowErrorFallback
              error={error}
              errorInfo={errorInfo?.componentStack ?? undefined}
              onClose={() => { closePanel(p.id); void refresh() }}
            />
          )}
        >
          <RuntimeWindow
            id={p.id}
            index={i}
            origin={p.origin}
            agents={agents}
            onClose={() => { closePanel(p.id); void refresh() }}
            onFront={() => frontPanel(p.id)}
            onChanged={() => void refresh()}
          />
        </ErrorBoundary>
      ))}

      {creating &&
        createPortal(
          <CreateRuntimeDialog agents={agents} onClose={() => setCreating(false)} onCreate={create} />,
          document.body,
        )}
    </div>
  )
}

function StatusBadge({ status }: { status: RuntimeStatus }) {
  if (status === 'running')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-live-soft px-2.5 py-1 text-[11px] font-semibold text-live">
        <span className="size-1.5 rounded-full bg-live" /> Running
      </span>
    )
  if (status === 'provisioning')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-ink">
        <Loader2 className="size-3 animate-spin" /> Provisioning
      </span>
    )
  if (status === 'paused')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">
        <span className="size-1.5 rounded-full bg-ink-tertiary" /> Paused
      </span>
    )
  if (status === 'local')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">
        <span className="size-1.5 rounded-full bg-ink-tertiary" /> Local
      </span>
    )
  if (status === 'error')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive">
        <span className="size-1.5 rounded-full bg-destructive" /> Error
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">
      Stopped
    </span>
  )
}

function EmptyRuntimes({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-7 flex flex-col items-center justify-center gap-5 rounded-[20px] border border-dashed border-border-strong bg-white/40 px-4 py-14 text-center sm:py-20">
      <div className="relative">
        <div className="cirrus-float flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#837DFF] text-primary-foreground shadow-[0_14px_34px_-10px_rgba(91,87,242,0.55)]">
          <Server className="size-7" />
        </div>
        <div className="cirrus-float-rev absolute -right-5 -top-3 size-3 rounded-full bg-primary/25" />
        <div className="cirrus-float-slow absolute -left-6 bottom-0 size-2.5 rounded-full bg-primary/20" />
      </div>
      <div>
        <div className="text-[17px] font-bold tracking-tight text-ink">No runtimes yet</div>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-secondary">
          A runtime is a home for your agents. Spin one up and pick the agents it should run.
        </p>
      </div>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
      >
        <Plus className="size-[15px]" /> Create New
      </button>
    </div>
  )
}

function RuntimeWindowErrorFallback({
  error,
  errorInfo,
  onClose,
}: {
  error: Error
  errorInfo?: string
  onClose: () => void
}) {
  return (
    <div className="fixed left-1/2 top-1/2 z-[140] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[20px] border border-destructive/20 bg-surface shadow-[0_26px_64px_-14px_rgba(25,25,23,0.36)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-destructive/10 text-destructive">
            <AlertCircle className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-bold tracking-tight text-ink">Runtime panel crashed</div>
            <div className="text-[11.5px] text-ink-tertiary">The error is shown here instead of a blank panel.</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex size-[30px] items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
          aria-label="Close"
        >
          <X className="size-4 text-ink-secondary" />
        </button>
      </div>
      <div className="max-h-[58vh] overflow-auto p-4">
        <div className="rounded-[12px] border border-destructive/20 bg-destructive/5 p-3">
          <div className="text-[12px] font-semibold text-destructive">{error.name || 'Error'}</div>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink">
            {error.stack || error.message}
          </pre>
        </div>
        {errorInfo && (
          <div className="mt-3 rounded-[12px] border border-border bg-surface-muted/60 p-3">
            <div className="text-[12px] font-semibold text-ink-secondary">React component stack</div>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-tertiary">
              {errorInfo}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function startedAgo(value: string): string {
  const started = new Date(value).getTime()
  if (!Number.isFinite(started)) return 'Started recently'
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return 'Started just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Started ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Started ${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `Started ${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  return `Started ${months} month${months === 1 ? '' : 's'} ago`
}

function RuntimeCard({
  runtime,
  onOpen,
  onRename,
  onDelete,
}: {
  runtime: RuntimeRecord
  onOpen: (origin: DOMRect) => void
  onRename: (name: string) => void | Promise<void>
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const openCard = (el: HTMLElement) => onOpen(el.getBoundingClientRect())
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-runtime-card-action]')) return
        openCard(e.currentTarget)
      }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-runtime-card-action]')) return
        if (e.key === 'Enter') openCard(e.currentTarget)
      }}
      className="group relative flex min-h-[152px] cursor-pointer flex-col gap-3 rounded-[16px] border border-border bg-white p-5 text-left shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)] transition-shadow hover:shadow-[0_12px_30px_-12px_rgba(25,25,23,0.18)]"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
          <Server className="size-[17px]" />
        </div>
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{runtime.name}</div>
        <StatusBadge status={runtime.status} />
      </div>
      <div className="flex flex-1 flex-wrap content-start gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-[11.5px] font-medium text-ink-secondary">
          <Sparkles className="size-3 text-accent-ink" />
          {runtime.agents.length} Agent{runtime.agents.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] text-ink-tertiary">
          {startedAgo(runtime.createdAt)}
          {runtime.bots.length > 0 && ` · ${runtime.bots.length} bot${runtime.bots.length === 1 ? '' : 's'}`}
        </span>
        <div className="relative">
          <button
            type="button"
            data-runtime-card-action
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            className="flex size-7 items-center justify-center rounded-md text-ink-tertiary opacity-100 transition hover:bg-surface-muted hover:text-ink-secondary sm:opacity-0 sm:group-hover:opacity-100 data-[open=true]:opacity-100"
            data-open={menuOpen}
            aria-label="Runtime options"
          >
            <MoreHorizontal className="size-[16px]" />
          </button>
          {menuOpen && (
            <>
              <div
                data-runtime-card-action
                className="fixed inset-0 z-40"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                }}
              />
              <div
                data-runtime-card-action
                className="absolute bottom-8 right-0 z-50 w-40 overflow-hidden rounded-[10px] border border-border bg-surface p-1 shadow-[0_14px_34px_-12px_rgba(25,25,23,0.28)]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    setRenameOpen(true)
                  }}
                  className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-ink hover:bg-surface-muted"
                >
                  <PencilLine className="size-[14px]" /> Rename
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen(false)
                    onDelete()
                  }}
                  className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-[14px]" /> Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {renameOpen &&
        createPortal(
          <RenameRuntimeDialog
            initialName={runtime.name}
            onClose={() => setRenameOpen(false)}
            onRename={async (name) => {
              await onRename(name)
              setRenameOpen(false)
            }}
          />,
          document.body,
        )}
    </div>
  )
}

function RenameRuntimeDialog({
  initialName,
  onClose,
  onRename,
}: {
  initialName: string
  onClose: () => void
  onRename: (name: string) => void | Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-6"
      onMouseDown={onClose}
      onClick={(e) => e.stopPropagation()}
    >
      <form
        className="cirrus-pop w-full max-w-[380px] rounded-[16px] border border-border bg-surface p-5 shadow-[0_26px_70px_-18px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!trimmed || busy) return
          setBusy(true)
          await onRename(trimmed)
          setBusy(false)
        }}
      >
        <div className="text-[16px] font-bold tracking-tight text-ink">Rename runtime</div>
        <div className="mt-1 text-[12.5px] text-ink-secondary">Give this runtime a clearer name.</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-4 h-10 w-full rounded-[10px] border border-border-strong bg-white px-3 text-[14px] text-ink outline-none focus:border-primary"
          placeholder="Runtime name"
        />
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed || busy}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </form>
    </div>
  )
}

function CreateRuntimeDialog({
  agents,
  onClose,
  onCreate,
}: {
  agents: MiniappRecord[]
  onClose: () => void
  onCreate: (name: string, picked: RuntimeAgentRef[]) => void
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Record<string, RuntimeAgentRef>>({})

  const own: RuntimeAgentRef[] = agents.map((a) => ({ key: 'own:' + a.id, name: agentName(a), source: 'own', miniappId: a.id }))
  const community: RuntimeAgentRef[] = COMMUNITY.map(communityAgentRef)

  const toggle = (ref: RuntimeAgentRef) =>
    setSelected((prev) => {
      const next = { ...prev }
      if (next[ref.key]) delete next[ref.key]
      else next[ref.key] = ref
      return next
    })

  const picked = Object.values(selected)
  const canCreate = picked.length > 0

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-4 sm:p-6" onMouseDown={onClose}>
      <div
        className="cirrus-pop flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <div className="text-[16px] font-bold tracking-tight text-ink">New Runtime</div>
            <div className="text-[12.5px] text-ink-secondary">Pick at least one agent for this runtime to run.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-muted">
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-ink">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My runtime"
              className="rounded-[10px] border border-border bg-surface px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
            />
          </label>

          <AgentPickGroup title="Your agents" empty="You haven't created any agents yet." items={own} selected={selected} onToggle={toggle} />
          <AgentPickGroup title="Community agents" items={community} selected={selected} onToggle={toggle} />
        </div>

        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[12.5px] text-ink-secondary">
            {picked.length} agent{picked.length === 1 ? '' : 's'} selected
          </div>
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <button onClick={onClose} className="rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
              Cancel
            </button>
            <button
              disabled={!canCreate}
              onClick={() => onCreate(name, picked)}
              className="rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Create Runtime
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentPickGroup({
  title,
  empty,
  items,
  selected,
  onToggle,
}: {
  title: string
  empty?: string
  items: RuntimeAgentRef[]
  selected: Record<string, RuntimeAgentRef>
  onToggle: (ref: RuntimeAgentRef) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">{title.toUpperCase()}</div>
      {items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border px-3 py-3 text-[12.5px] text-ink-tertiary">{empty}</div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {items.map((ref) => {
            const on = !!selected[ref.key]
            return (
              <button
                key={ref.key}
                onClick={() => onToggle(ref)}
                className={cn(
                  'flex items-center gap-2.5 rounded-[11px] border px-3 py-2.5 text-left transition',
                  on ? 'border-primary bg-accent-soft' : 'border-border bg-surface hover:bg-surface-muted',
                )}
              >
                <span className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink">
                  <Sparkles className="size-[14px]" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{ref.name}</span>
                <span
                  className={cn(
                    'flex size-[18px] shrink-0 items-center justify-center rounded-full border',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong text-transparent',
                  )}
                >
                  <Check className="size-3" />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ───────── Runtime detail (chat · mini app · bots) ───────── */

const BOT_OPTIONS: { platform: BotPlatform; label: string; icon: React.ReactNode; color: string; tokenLabel: string; tokenHint: string }[] = [
  { platform: 'slack', label: 'Slack', icon: <MessageSquare className="size-[15px]" />, color: '#4A154B', tokenLabel: 'Bot User OAuth Token', tokenHint: 'xoxb-…' },
  { platform: 'telegram', label: 'Telegram', icon: <Bot className="size-[15px]" />, color: '#229ED9', tokenLabel: 'Bot Token', tokenHint: '123456:ABC-DEF… from @BotFather' },
  { platform: 'lark', label: 'Lark', icon: <Bell className="size-[15px]" />, color: '#00D6B9', tokenLabel: 'App Secret', tokenHint: 'your Lark app secret' },
]

function RuntimeWindow({
  id,
  index,
  origin,
  agents,
  onClose,
  onFront,
  onChanged,
}: {
  id: string
  index: number
  origin: DOMRect | null
  agents: MiniappRecord[]
  onClose: () => void
  onFront: () => void
  onChanged?: () => void
}) {
  const [runtime, setRuntime] = useState<RuntimeRecord | null>(null)
  const [miniapp, setMiniapp] = useState<MiniappRecord | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [tab, setTab] = useState<'chat' | 'bots' | 'details' | 'config' | 'cron'>('chat')
  const [showMiniapp, setShowMiniapp] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [sending, setSending] = useState(false)
  const [loadingRuntime, setLoadingRuntime] = useState(true)
  const runtimeMiniappId = runtime?.agents.find((a) => a.source === 'own' && a.miniappId)?.miniappId ?? null
  const hasRuntimeMiniapp = !!miniapp?.html

  // Load the runtime and (if it hosts a built own-agent) that agent's miniapp.
  useEffect(() => {
    let alive = true
    setRuntimeError(null)
    setLoadingRuntime(true)
    void getRuntime(id)
      .then((rt) => {
        if (!alive) return
        setRuntime(rt)
        setMessages(rt.messages)
      })
      .catch((err) => {
        if (!alive) return
        setRuntimeError(String((err as Error)?.message ?? err))
      })
      .finally(() => {
        if (alive) setLoadingRuntime(false)
      })
    return () => { alive = false }
  }, [id])

  useEffect(() => {
    let alive = true
    if (!runtimeMiniappId) {
      setMiniapp(null)
      setShowMiniapp(false)
      return () => { alive = false }
    }
    void getMiniapp(runtimeMiniappId).then((app) => {
      if (!alive) return
      if (app.html) setMiniapp(app)
      else {
        setMiniapp(null)
        setShowMiniapp(false)
      }
    }).catch(() => {
      if (alive) {
        setMiniapp(null)
        setShowMiniapp(false)
      }
    })
    return () => { alive = false }
  }, [runtimeMiniappId])

  // Poll active E2B runtimes so the sandbox badge reflects the real state.
  useEffect(() => {
    const provisioning = runtime?.status === 'provisioning'
    const hasE2BSandbox = runtime?.sandboxKind === 'e2b' && !!runtime.sandboxId
    if (!provisioning && !hasE2BSandbox) return
    const t = setInterval(() => void getRuntime(id).then(setRuntime).catch(() => {}), provisioning ? 1500 : 10000)
    return () => clearInterval(t)
  }, [runtime?.sandboxId, runtime?.sandboxKind, runtime?.status, id])

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    const userMsg: UiMessage = { id: 'u-' + Date.now().toString(36), role: 'user', content: text }
    const history: ChatTurn[] = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    const assistantId = 'a-' + Date.now().toString(36)
    const assistantMsg: UiMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      activities: [{ kind: 'status', text: 'Thinking with runtime agent…' }],
    }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    try {
      for await (const ev of streamRuntimeChat(id, history)) {
        setMessages((prev) => applyBuildChatEvent(prev, assistantId, ev))
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: String((err as Error)?.message ?? err),
                activities: [{ kind: 'error', text: 'Runtime chat failed', ok: false }],
              }
            : m,
        ),
      )
    } finally {
      setSending(false)
    }
  }

  const connect = async (platform: BotPlatform, token?: string) => {
    const rt = await connectRuntimeBot(id, platform, token).catch(() => null)
    if (rt) setRuntime(rt)
  }
  const disconnect = async (botId: string) => {
    const rt = await disconnectRuntimeBot(id, botId).catch(() => null)
    if (rt) setRuntime(rt)
  }
  const addAgent = async (ref: RuntimeAgentRef): Promise<void> => {
    const rt = await addRuntimeAgent(id, ref).catch(() => null)
    if (rt) {
      setRuntime(rt)
      onChanged?.()
    }
  }
  const removeAgent = async (key: string): Promise<void> => {
    const rt = await removeRuntimeAgent(id, key).catch(() => null)
    if (rt) {
      setRuntime(rt)
      onChanged?.()
    }
  }
  const updateAgentModel = async (key: string, modelConfig: RuntimeAgentModelConfig & { customApiKey?: string }): Promise<void> => {
    const rt = await updateRuntimeAgentModelConfig(id, key, modelConfig).catch(() => null)
    if (rt) setRuntime(rt)
  }

  const tabs: { key: 'chat' | 'bots' | 'details' | 'config' | 'cron'; label: string; icon: React.ReactNode; show: boolean }[] = [
    { key: 'chat', label: 'Chat', icon: <MessageSquare className="size-[15px]" />, show: true },
    { key: 'bots', label: 'Bots', icon: <Bot className="size-[15px]" />, show: true },
    { key: 'config', label: 'Configuration', icon: <KeyRound className="size-[15px]" />, show: true },
    { key: 'cron', label: 'Cron', icon: <CalendarClock className="size-[15px]" />, show: true },
    { key: 'details', label: 'Details', icon: <LayoutGrid className="size-[15px]" />, show: true },
  ]
  const activeTab = tab

  // ── Window chrome (mirrors the agent-canvas skill panels) ──
  const stagger = index * 26
  const rootRef = useRef<HTMLDivElement>(null)
  const [max, setMax] = useState(false)
  const compactWindow = useMediaQuery('(max-width: 767px)')

  const [d, setD] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const onHeaderDown = (e: React.PointerEvent) => {
    if (compactWindow || max || (e.target as HTMLElement).closest('button')) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: d.x, oy: d.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onHeaderMove = (e: React.PointerEvent) => {
    const g = dragRef.current
    if (!g) return
    setD({ x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) })
  }
  const onHeaderUp = () => { dragRef.current = null }

  const [size, setSize] = useState({ w: 900, h: 560 })
  const sizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null)
  const onResizeDown = (e: React.PointerEvent) => {
    if (compactWindow) return
    e.stopPropagation()
    sizeRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = sizeRef.current
    if (!r) return
    setSize({ w: Math.max(showMiniapp ? 760 : 480, r.sw + (e.clientX - r.sx)), h: Math.max(360, r.sh + (e.clientY - r.sy)) })
  }
  const onResizeUp = () => { sizeRef.current = null }

  const [runtimeSplitW, setRuntimeSplitW] = useState(420)
  const runtimeSplitRef = useRef<{ sx: number; sw: number } | null>(null)
  const onRuntimeSplitDown = (e: React.PointerEvent) => {
    if (compactWindow) return
    e.stopPropagation()
    runtimeSplitRef.current = { sx: e.clientX, sw: runtimeSplitW }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onRuntimeSplitMove = (e: React.PointerEvent) => {
    const s = runtimeSplitRef.current
    if (!s) return
    const total = rootRef.current?.getBoundingClientRect().width ?? size.w
    const maxRight = Math.max(320, total - 320)
    setRuntimeSplitW(Math.max(300, Math.min(maxRight, s.sw - (e.clientX - s.sx))))
  }
  const onRuntimeSplitUp = () => {
    runtimeSplitRef.current = null
  }

  // Close with a shrink-to-card animation toward the originating card.
  const closeWithAnim = () => {
    const el = rootRef.current
    if (!el || !origin) { onClose(); return }
    const r = el.getBoundingClientRect()
    const s = Math.max(0.06, origin.width / r.width)
    const tx = origin.left + origin.width / 2 - (r.left + r.width / 2)
    const ty = origin.top + origin.height / 2 - (r.top + r.height / 2)
    el.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 1, 1), opacity 0.3s ease'
    el.style.transformOrigin = 'center center'
    el.style.transform = `${el.style.transform} translate(${tx}px, ${ty}px) scale(${s})`
    el.style.opacity = '0'
    window.setTimeout(onClose, 285)
  }

  return (
    <>
      {max && !compactWindow && (
        <div
          className="cirrus-overlay fixed inset-0 z-[270] bg-ink/55 backdrop-blur-sm"
          onPointerDown={(e) => { e.stopPropagation(); setMax(false) }}
        />
      )}
    <div
      ref={rootRef}
      onPointerDown={(e) => { e.stopPropagation(); onFront() }}
      className={cn(
        'fixed cursor-default select-text',
        compactWindow
          ? 'z-[120] inset-x-2 bottom-2 top-2'
          : max
            ? 'z-[280] inset-5'
            : 'z-[120] left-1/2 top-1/2',
      )}
      style={compactWindow || max ? undefined : { width: size.w, transform: `translate(calc(-50% + ${d.x + stagger}px), calc(-50% + ${d.y + stagger}px))` }}
    >
      <div
        className={cn('relative flex flex-col overflow-hidden rounded-[20px] border border-white/70 shadow-[0_26px_64px_-14px_rgba(25,25,23,0.36)]', (max || compactWindow) && 'h-full')}
        style={{
          ...(max || compactWindow ? {} : { height: size.h }),
          // When maximized the dim overlay sits behind the window, so keep it
          // fully opaque to stop the dark bleeding through and graying the UI.
          ...(max
            ? { background: 'var(--surface)' }
            : { background: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)' }),
        }}
      >
        {/* Title bar — drag anywhere (windowed mode) */}
        <div
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          className={cn('flex select-none items-center gap-3 border-b border-black/5 px-3 py-3 sm:px-4', !compactWindow && !max && 'cursor-grab active:cursor-grabbing')}
        >
          <div className="flex size-[34px] items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
            <Server className="size-[17px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[15.5px] font-bold tracking-tight text-ink">{runtime?.name ?? 'Runtime'}</span>
              {runtime && <StatusBadge status={runtime.status} />}
            </div>
            <div className="truncate font-mono text-[11px] text-ink-tertiary">
              {runtime?.sandboxKind === 'e2b' && runtime.sandboxId
                ? `E2B · ${runtime.sandboxId}`
                : runtime?.status === 'provisioning'
                  ? 'provisioning sandbox…'
                  : 'local sandbox'}
            </div>
          </div>
          <button
            onClick={() => setMax((m) => !m)}
            className="flex size-[30px] items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
            aria-label={max ? 'Restore' : 'Maximize'}
          >
            {max ? <Minimize2 className="size-4 text-ink-secondary" /> : <Maximize2 className="size-4 text-ink-secondary" />}
          </button>
          <button
            onClick={closeWithAnim}
            className="flex size-[30px] items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
            aria-label="Close"
          >
            <X className="size-4 text-ink-secondary" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-black/5 px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {tabs.filter((t) => t.show).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[12.5px] font-semibold transition',
                  activeTab === t.key ? 'bg-accent-soft text-accent-ink' : 'text-ink-secondary hover:bg-surface-muted',
                )}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          {hasRuntimeMiniapp && (
            <button
              type="button"
              onClick={() => {
                setTab('chat')
                setShowMiniapp((v) => {
                  if (!v && !max) setSize((s) => ({ ...s, w: Math.max(s.w, 900) }))
                  return !v
                })
              }}
              className={cn(
                'inline-flex items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-[12.5px] font-semibold transition',
                showMiniapp ? 'bg-accent-soft text-accent-ink' : 'text-ink-secondary hover:bg-surface-muted',
              )}
              aria-pressed={showMiniapp}
            >
              <AppWindow className="size-[15px]" />
              Mini App
              <span
                className={cn(
                  'relative h-4 w-7 rounded-full transition',
                  showMiniapp ? 'bg-primary' : 'bg-border-strong',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition',
                    showMiniapp ? 'left-3.5' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          )}
        </div>

        {/* Tab content */}
        <div className="flex min-h-0 flex-1 flex-col">
          {runtimeError ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <div className="max-w-lg rounded-[14px] border border-destructive/20 bg-destructive/5 p-4 text-left">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
                  <AlertCircle className="size-4" />
                  Failed to load runtime
                </div>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink">
                  {runtimeError}
                </pre>
              </div>
            </div>
          ) : activeTab === 'chat' && (
            <div className={cn('flex min-h-0 flex-1', showMiniapp && hasRuntimeMiniapp && 'flex-col md:flex-row')}>
              <div className={cn('flex min-h-0 min-w-0 flex-1', showMiniapp && hasRuntimeMiniapp && 'max-md:min-h-[240px]')}>
                <BuildChat
                  title=""
                  placeholder="Message this runtime…"
                  empty="Say hello — this runtime's agents will respond."
                  messages={messages}
                  building={sending}
                  loading={loadingRuntime}
                  onSend={send}
                  mentionAgents={runtime?.agents ?? []}
                />
              </div>
              {showMiniapp && hasRuntimeMiniapp && (
                <>
                  <div
                    onPointerDown={onRuntimeSplitDown}
                    onPointerMove={onRuntimeSplitMove}
                    onPointerUp={onRuntimeSplitUp}
                    className="hidden w-1.5 shrink-0 cursor-col-resize bg-black/5 transition-colors hover:bg-primary/40 md:block"
                    aria-label="Resize runtime mini app split"
                  />
                  <div
                    className="flex min-h-[280px] min-w-0 flex-1 flex-col border-t border-black/5 bg-white/50 md:min-h-0 md:min-w-[300px] md:shrink-0 md:flex-none md:border-l md:border-t-0"
                    style={compactWindow ? undefined : { width: runtimeSplitW }}
                  >
                    <div className="min-h-0 flex-1">
                      {miniapp ? (
                        <MiniappCanvas
                          miniapp={miniapp}
                          runtimeId={id}
                          onState={(state, version) =>
                            setMiniapp((prev) => (prev ? { ...prev, state, stateVersion: version } : prev))
                          }
                          chrome={false}
                          canSelectElements={false}
                          selectingElement={false}
                          selectedElement={null}
                          onToggleElementSelect={() => {}}
                          onElementSelected={() => {}}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-ink-tertiary">
                          <Loader2 className="size-4 animate-spin" /> Loading mini app…
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {activeTab === 'bots' && <BotsPanel bots={runtime?.bots ?? []} onConnect={connect} onDisconnect={disconnect} />}
          {activeTab === 'details' && <DetailsPanel runtime={runtime} agents={agents} onAddAgent={addAgent} onRemoveAgent={removeAgent} onUpdateAgentModel={updateAgentModel} />}
          {activeTab === 'config' && <ConfigurationPanel runtimeId={id} runtime={runtime} />}
          {activeTab === 'cron' && <CronPanel runtimeId={id} runtime={runtime} compact={compactWindow} />}
        </div>

        {/* Corner resize handle */}
        <div
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          className="absolute bottom-0.5 right-0.5 hidden size-4 cursor-nwse-resize items-center justify-center text-ink-tertiary sm:flex"
          aria-label="Resize"
        >
          <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
            <path d="M9 2 L2 9 M9 6 L6 9" />
          </svg>
        </div>
      </div>
    </div>
    </>
  )
}

function ShareRuntimeSection({ runtimeId }: { runtimeId: string }) {
  const url = `${window.location.origin}/r/${runtimeId}`
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the link is still selectable */
    }
  }
  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">SHARE</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-tertiary">
        A use-only chat link. Anyone who opens it can chat with this runtime — no login, and they can’t change its setup.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2">
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-[12px] text-accent-ink hover:underline">
          {url}
        </a>
        <button
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-ink-secondary transition hover:bg-surface-muted"
        >
          {copied ? <><Check className="size-3.5 text-live" /> Copied</> : <><Copy className="size-3.5" /> Copy</>}
        </button>
      </div>
    </div>
  )
}

function DetailsPanel({
  runtime,
  agents,
  onAddAgent,
  onRemoveAgent,
  onUpdateAgentModel,
}: {
  runtime: RuntimeRecord | null
  agents: MiniappRecord[]
  onAddAgent: (ref: RuntimeAgentRef) => Promise<void>
  onRemoveAgent: (key: string) => Promise<void>
  onUpdateAgentModel: (key: string, modelConfig: RuntimeAgentModelConfig & { customApiKey?: string }) => Promise<void>
}) {
  const [pickOpen, setPickOpen] = useState(false)
  const existingKeys = new Set((runtime?.agents ?? []).map((a) => a.key))

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-6">
      <div>
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">AGENTS</div>
          <button
            onClick={() => setPickOpen(true)}
            className="flex size-6 items-center justify-center rounded-[7px] border border-border bg-surface text-ink-secondary hover:bg-surface-muted"
            aria-label="Add agent"
          >
            <Plus className="size-[14px]" />
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {(runtime?.agents ?? []).map((a) => (
            <AgentRow key={a.key} agent={a} onRemove={() => onRemoveAgent(a.key)} onUpdateModel={(cfg) => onUpdateAgentModel(a.key, cfg)} />
          ))}
        </div>
      </div>

      {runtime && <ShareRuntimeSection runtimeId={runtime.id} />}

      <div>
        <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">SANDBOX</div>
        <div className="mt-2 rounded-[10px] border border-border bg-surface px-3.5 py-3 text-[12.5px] text-ink-secondary">
          <div className="flex items-center justify-between">
            <span>Backend</span>
            <span className="font-semibold text-ink">{runtime?.sandboxKind === 'e2b' ? 'E2B' : 'Local'}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span>Status</span>
            {runtime && <StatusBadge status={runtime.status} />}
          </div>
          {runtime?.sandboxId && (
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="shrink-0 text-ink-tertiary">Sandbox ID</span>
              <span className="min-w-0 break-all text-right font-mono text-[11px] text-ink">{runtime.sandboxId}</span>
            </div>
          )}
          {runtime?.sandboxError && <div className="mt-2 text-[11.5px] text-ink-tertiary">{runtime.sandboxError}</div>}
        </div>
      </div>

      {pickOpen &&
        createPortal(
          <AddAgentsDialog
            agents={agents}
            existingKeys={existingKeys}
            onClose={() => setPickOpen(false)}
            onAdd={async (refs) => {
              for (const r of refs) await onAddAgent(r)
              setPickOpen(false)
            }}
          />,
          document.body,
        )}
    </div>
  )
}

function AgentRow({
  agent,
  onRemove,
  onUpdateModel,
}: {
  agent: RuntimeAgentRef
  onRemove: () => void
  onUpdateModel: (modelConfig: RuntimeAgentModelConfig & { customApiKey?: string }) => Promise<void>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const install = agent.installation
  const model = agent.modelConfig
  const installTone =
    install?.status === 'ready'
      ? 'bg-live/10 text-live'
      : install?.status === 'failed' || install?.status === 'not_supported'
        ? 'bg-destructive/10 text-destructive'
        : install?.status === 'installing'
          ? 'bg-amber-500/10 text-amber-700'
          : 'bg-surface-muted text-ink-tertiary'
  return (
    <div className="group flex items-start gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2.5">
      <span className="mt-0.5 flex size-[28px] shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink">
        <Sparkles className="size-[14px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{agent.name}</span>
          <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-ink-tertiary">
            {agent.source}
          </span>
          {install && (
            <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide', installTone)}>
              {install.status.replace('_', ' ')}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-ink-tertiary">
          {install?.adapter && <span>{install.adapter}</span>}
          {model?.mode && <span>model: {model.mode.replace(/_/g, ' ')}</span>}
          {model?.platformModel && <span>{model.platformModel}</span>}
          {model?.subscriptionProvider && <span>auth: {model.subscriptionProvider}</span>}
          {install?.error && <span className="text-destructive">{install.error}</span>}
        </div>
      </div>
      <div className="relative ml-auto">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex size-7 items-center justify-center rounded-[7px] text-ink-tertiary opacity-0 transition hover:bg-surface-muted hover:text-ink-secondary group-hover:opacity-100 data-[open=true]:opacity-100"
          data-open={menuOpen}
          aria-label="Agent options"
        >
          <MoreHorizontal className="size-[15px]" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-8 z-50 w-44 overflow-hidden rounded-[10px] border border-border bg-surface p-1 shadow-[0_14px_34px_-12px_rgba(25,25,23,0.28)]">
              <button
                onClick={() => { setMenuOpen(false); setModelOpen(true) }}
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-ink hover:bg-surface-muted"
              >
                <Braces className="size-[14px]" /> Configure model
              </button>
              <button
                onClick={() => { setMenuOpen(false); onRemove() }}
                className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="size-[14px]" /> Remove from runtime
              </button>
            </div>
          </>
        )}
      </div>
      {modelOpen &&
        createPortal(
          <ModelConfigDialog agent={agent} onClose={() => setModelOpen(false)} onSave={async (cfg) => { await onUpdateModel(cfg); setModelOpen(false) }} />,
          document.body,
        )}
    </div>
  )
}

// The runtime's Configuration tab. Consolidates every own-agent's skill settings
// and credentials in one place. Values are bound per runtime×agent, so the same
// shared agent can carry different settings in each runtime. Fields are edited
// inline (prefilled when set) and saved on change/blur — no separate save card.
function ConfigurationPanel({ runtimeId, runtime }: { runtimeId: string; runtime: RuntimeRecord | null }) {
  const ownAgents = (runtime?.agents ?? []).filter((a) => a.source === 'own')
  return (
    <div className="flex h-full flex-col gap-7 overflow-auto p-6">
      <div>
        <div className="text-[13px] font-semibold text-ink">Configuration</div>
        <div className="mt-1 text-[12px] text-ink-tertiary">Credentials &amp; settings for each agent — applied to this runtime only.</div>
      </div>
      {ownAgents.length === 0 ? (
        <ConfigEmptyState />
      ) : (
        ownAgents.map((a) => <AgentConfigSection key={a.key} runtimeId={runtimeId} agent={a} />)
      )}
    </div>
  )
}

function ConfigEmptyState() {
  return (
    <div className="cirrus-fade-up flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
      <svg width="148" height="116" viewBox="0 0 148 116" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        {/* soft halo */}
        <ellipse cx="74" cy="60" rx="60" ry="44" fill="var(--accent-soft)" opacity="0.5" />
        {/* settings card */}
        <rect x="34" y="26" width="80" height="64" rx="11" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1.6" />
        {/* three sliders */}
        <line x1="47" y1="44" x2="101" y2="44" stroke="var(--border-strong)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="63" cy="44" r="6" fill="var(--accent-soft)" stroke="var(--primary)" strokeWidth="2.2" />
        <line x1="47" y1="58" x2="101" y2="58" stroke="var(--border-strong)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="86" cy="58" r="6" fill="var(--accent-soft)" stroke="var(--primary)" strokeWidth="2.2" />
        <line x1="47" y1="72" x2="101" y2="72" stroke="var(--border-strong)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="55" cy="72" r="6" fill="var(--accent-soft)" stroke="var(--primary)" strokeWidth="2.2" />
        {/* floating sparkle */}
        <g className="cirrus-float-slow">
          <path d="M115 30c.6-2.4.9-3.6 1.5-3.6s.9 1.2 1.5 3.6c.3 1.1.4 1.7.8 2.1s1 .5 2.1.8c2.4.6 3.6.9 3.6 1.5s-1.2.9-3.6 1.5c-1.1.3-1.7.4-2.1.8s-.5 1-.8 2.1c-.6 2.4-.9 3.6-1.5 3.6s-.9-1.2-1.5-3.6c-.3-1.1-.4-1.7-.8-2.1s-1-.5-2.1-.8c-2.4-.6-3.6-.9-3.6-1.5s1.2-.9 3.6-1.5c1.1-.3 1.7-.4 2.1-.8s.5-1 .8-2.1z" fill="var(--primary)" opacity="0.85" />
        </g>
      </svg>
      <div className="flex flex-col gap-1.5">
        <div className="text-[13.5px] font-semibold text-ink">Nothing to configure</div>
        <div className="mx-auto max-w-[260px] text-[12px] leading-relaxed text-ink-tertiary">
          None of this runtime&apos;s agents need credentials or settings. Add an agent with configurable skills and it&apos;ll show up here.
        </div>
      </div>
    </div>
  )
}

// ── Cron tab: scheduled tasks for a runtime ──

/** Best-effort human label for a 5-field cron expression; falls back to raw. */
function describeCron(expr: string): string {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hr, dom, mon, dow] = parts
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const at = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const isNum = (s: string) => /^\d+$/.test(s)
  if (expr === '* * * * *') return 'Every minute'
  if (/^\*\/\d+$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${min.slice(2)} minutes`
  if (min === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Hourly'
  if (isNum(min) && isNum(hr) && dom === '*' && mon === '*' && dow === '*') return `Daily at ${at(hr, min)}`
  if (isNum(min) && isNum(hr) && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${at(hr, min)}`
  if (isNum(min) && isNum(hr) && dom === '*' && mon === '*' && isNum(dow)) return `Every ${dows[Number(dow) % 7]} at ${at(hr, min)}`
  return expr
}

function formatRunTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function CronJobCard({
  job,
  agentName,
  onToggle,
  onDelete,
}: {
  job: CronJob
  agentName: string | null
  onToggle: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('rounded-[12px] border bg-surface transition', job.enabled ? 'border-border' : 'border-dashed border-border-strong opacity-75')}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left">
        <span className={cn('mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[8px]', job.enabled ? 'bg-accent-soft text-accent-ink' : 'bg-surface-muted text-ink-tertiary')}>
          <Clock className="size-[14px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-ink">{job.name || job.message.slice(0, 40) || 'Scheduled task'}</span>
            {!job.enabled && <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-tertiary">paused</span>}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-tertiary">
            <span className="font-medium text-ink-secondary">{describeCron(job.schedule)}</span>
            <span className="font-mono">{job.schedule}</span>
            {agentName && <span>→ {agentName}</span>}
          </span>
        </span>
        <ChevronDown className={cn('mt-1 size-3.5 shrink-0 text-ink-tertiary transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">Message</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">{job.message}</p>
          <div className="mt-2.5 grid grid-cols-2 gap-2 text-[11px] text-ink-tertiary">
            <div>Next run<div className="mt-0.5 font-medium text-ink-secondary">{job.enabled ? formatRunTime(job.nextRunAt) : 'paused'}</div></div>
            <div>Last run<div className="mt-0.5 font-medium text-ink-secondary">{formatRunTime(job.lastRunAt)}</div></div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={onToggle}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-ink-secondary hover:bg-surface-muted"
            >
              {job.enabled ? <><Pause className="size-3.5" /> Pause</> : <><Power className="size-3.5" /> Enable</>}
            </button>
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-border px-2.5 py-1.5 text-[11.5px] font-medium text-destructive hover:bg-destructive/5"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CronPanel({ runtimeId, runtime, compact }: { runtimeId: string; runtime: RuntimeRecord | null; compact: boolean }) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [sending, setSending] = useState(false)

  const refresh = () => listRuntimeCron(runtimeId).then(setJobs).catch((e) => setError(String((e as Error)?.message ?? e)))
  useEffect(() => { void refresh() }, [runtimeId])

  const agentName = (key?: string | null): string | null => {
    if (!key) return null
    return runtime?.agents.find((a) => a.key === key)?.name ?? key
  }

  const toggle = async (job: CronJob) => {
    await updateRuntimeCron(runtimeId, job.id, { enabled: !job.enabled }).catch(() => {})
    await refresh()
  }
  const remove = async (job: CronJob) => {
    await deleteRuntimeCron(runtimeId, job.id).catch(() => {})
    await refresh()
  }

  const send = async (text: string) => {
    if (!text.trim() || sending) return
    const userMsg: UiMessage = { id: 'u-' + Date.now().toString(36), role: 'user', content: text }
    const history: ChatTurn[] = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    const assistantId = 'a-' + Date.now().toString(36)
    const assistantMsg: UiMessage = { id: assistantId, role: 'assistant', content: '', activities: [{ kind: 'status', text: 'Scheduling assistant…' }] }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setSending(true)
    try {
      for await (const ev of streamRuntimeCronChat(runtimeId, history)) {
        setMessages((prev) => applyBuildChatEvent(prev, assistantId, ev))
      }
      await refresh()
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: String((err as Error)?.message ?? err), activities: [{ kind: 'error', text: 'Scheduling assistant failed', ok: false }] } : m)))
    } finally {
      setSending(false)
    }
  }

  // Draggable split between the jobs list (left, flexible) and the chat (right).
  // The chat defaults small; drag the divider to widen it.
  const containerRef = useRef<HTMLDivElement>(null)
  const [chatW, setChatW] = useState(330)
  const dragRef = useRef<{ sx: number; sw: number } | null>(null)
  const onSplitDown = (e: React.PointerEvent) => {
    if (compact) return
    e.stopPropagation()
    dragRef.current = { sx: e.clientX, sw: chatW }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onSplitMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const total = containerRef.current?.getBoundingClientRect().width ?? 800
    const maxChat = Math.max(280, total - 300)
    setChatW(Math.max(280, Math.min(maxChat, d.sw - (e.clientX - d.sx))))
  }
  const onSplitUp = () => { dragRef.current = null }

  return (
    <div ref={containerRef} className={cn('flex min-h-0 flex-1', compact ? 'flex-col' : 'flex-row')}>
      {/* Left: configured jobs */}
      <div className={cn('flex min-h-0 flex-col overflow-auto p-4', compact ? 'max-h-[45%] border-b border-black/5' : 'min-w-0 flex-1')}>
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">SCHEDULED TASKS</div>
          {jobs && jobs.length > 0 && <span className="text-[11px] text-ink-tertiary">{jobs.length}</span>}
        </div>
        {error && <div className="mt-2 text-[12px] text-destructive">{error}</div>}
        {!jobs && !error && (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-tertiary"><Loader2 className="size-3.5 animate-spin" /> Loading…</div>
        )}
        {jobs && jobs.length === 0 && (
          <div className="cirrus-fade-up mt-6 flex flex-col items-center gap-3 px-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent-ink"><CalendarClock className="size-6" /></span>
            <div className="text-[12.5px] font-semibold text-ink">No scheduled tasks yet</div>
            <div className="max-w-[230px] text-[11.5px] leading-relaxed text-ink-tertiary">Ask the assistant on the right to schedule a message to one of this runtime&apos;s agents.</div>
          </div>
        )}
        {jobs && jobs.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {jobs.map((job) => (
              <CronJobCard key={job.id} job={job} agentName={agentName(job.targetAgentKey)} onToggle={() => toggle(job)} onDelete={() => remove(job)} />
            ))}
          </div>
        )}
      </div>
      {!compact && (
        <div
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          className="w-1.5 shrink-0 cursor-col-resize bg-black/5 transition-colors hover:bg-primary/40"
          aria-label="Resize chat"
        />
      )}
      {/* Right: scheduling assistant chat */}
      <div
        className={cn('flex min-h-0 min-w-0', compact ? 'flex-1' : 'shrink-0')}
        style={compact ? undefined : { width: chatW }}
      >
        <BuildChat
          title=""
          placeholder="e.g. every weekday at 9am, ask for a news digest"
          empty="Tell me when and what to run — I'll set up the schedule."
          messages={messages}
          building={sending}
          busyLabel="scheduling…"
          onSend={send}
          mentionAgents={runtime?.agents ?? []}
        />
      </div>
    </div>
  )
}

function AgentConfigSection({ runtimeId, agent }: { runtimeId: string; agent: RuntimeAgentRef }) {
  const [skills, setSkills] = useState<RuntimeAgentSkillSettings[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = () => {
    getRuntimeAgentSkills(runtimeId, agent.key)
      .then(setSkills)
      .catch((err) => setError(String((err as Error)?.message ?? err)))
  }
  useEffect(reload, [runtimeId, agent.key])
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-accent-soft text-accent-ink">
          <Sparkles className="size-[12px]" />
        </span>
        <span className="text-[12.5px] font-semibold text-ink">{agent.name}</span>
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
      {!skills && !error && (
        <div className="flex items-center gap-2 text-[12px] text-ink-tertiary"><Loader2 className="size-3.5 animate-spin" /> Loading…</div>
      )}
      {skills && skills.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-border px-3 py-2.5 text-[12px] text-ink-tertiary">No skills need configuration.</div>
      )}
      <div className="flex flex-col gap-3">
        {(skills ?? []).map((skill) => (
          <SkillConfigFields key={skill.id} runtimeId={runtimeId} agentKey={agent.key} skill={skill} onSaved={reload} />
        ))}
      </div>
    </div>
  )
}

function SkillConfigFields({
  runtimeId,
  agentKey,
  skill,
  onSaved,
}: {
  runtimeId: string
  agentKey: string
  skill: RuntimeAgentSkillSettings
  onSaved: () => void
}) {
  // Local edits per key; cleared after a successful save so the reloaded value shows.
  const [values, setValues] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false) // collapsed by default
  const filledCount = skill.settings.filter((f) => f.filled).length

  const commit = async (key: string, raw: string) => {
    setSavingKey(key)
    setError(null)
    try {
      await saveRuntimeAgentSkillSettings(runtimeId, agentKey, skill.id, { [key]: raw })
      setValues((v) => { const n = { ...v }; delete n[key]; return n })
      setSavedKey(key)
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1600)
      onSaved()
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setSavingKey((k) => (k === key ? null : k))
    }
  }

  const fieldStatus = (key: string) => (savingKey === key ? 'saving' : savedKey === key ? 'saved' : null)

  const labelRow = (field: RuntimeAgentSkillSettings['settings'][number]) => {
    const status = fieldStatus(field.key)
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-secondary">
        {field.label}
        {field.required === false && <span className="font-normal text-ink-tertiary">optional</span>}
        {status === 'saving' && <Loader2 className="size-3 animate-spin text-ink-tertiary" />}
        {status === 'saved' && <Check className="size-3 text-live" />}
        {field.secret && field.filled && !status && <span className="font-normal text-ink-tertiary">saved</span>}
      </span>
    )
  }

  return (
    <div className="rounded-[12px] border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left"
        aria-expanded={open}
      >
        <ChevronRight className={cn('size-[14px] shrink-0 text-ink-tertiary transition-transform', open && 'rotate-90')} />
        <span className="text-[12px] font-semibold text-ink">{skill.name}</span>
        <span className="ml-auto text-[11px] text-ink-tertiary">
          {filledCount > 0 ? `${filledCount}/${skill.settings.length} set` : `${skill.settings.length} settings`}
        </span>
      </button>
      {open && (
      <div className="flex flex-col gap-3 px-3.5 pb-3.5">
        {skill.settings.map((field) => {
          const isSecret = field.secret || field.type === 'password'

          if (field.type === 'boolean') {
            const on = (values[field.key] ?? field.value) === 'true'
            return (
              <div key={field.key} className="flex items-center justify-between gap-3">
                {labelRow(field)}
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => commit(field.key, on ? 'false' : 'true')}
                  className={cn('relative h-5 w-9 shrink-0 rounded-full transition', on ? 'bg-primary' : 'bg-border-strong')}
                >
                  <span className={cn('absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition', on ? 'left-4' : 'left-0.5')} />
                </button>
              </div>
            )
          }

          if (field.type === 'select') {
            return (
              <label key={field.key} className="flex flex-col gap-1">
                {labelRow(field)}
                <select
                  value={values[field.key] ?? field.value ?? ''}
                  onChange={(e) => { setValues((v) => ({ ...v, [field.key]: e.target.value })); void commit(field.key, e.target.value) }}
                  className="h-9 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[13px] text-ink outline-none focus:border-primary"
                >
                  <option value="">{field.placeholder ?? 'Select…'}</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )
          }

          const value = values[field.key] ?? (isSecret ? '' : field.value ?? '')
          const placeholder = field.placeholder ?? (field.filled && isSecret ? 'Saved — type to replace' : '')
          const onBlur = (raw: string) => { if (values[field.key] !== undefined && raw.trim()) void commit(field.key, raw) }

          return (
            <label key={field.key} className="flex flex-col gap-1">
              {labelRow(field)}
              {field.type === 'textarea' ? (
                <textarea
                  value={value}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  onBlur={(e) => onBlur(e.target.value)}
                  placeholder={placeholder}
                  className="min-h-[76px] resize-y rounded-[9px] border border-border-strong bg-white/80 px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
                />
              ) : (
                <input
                  value={value}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  onBlur={(e) => onBlur(e.target.value)}
                  type={isSecret ? 'password' : 'text'}
                  placeholder={placeholder}
                  className="h-9 rounded-[9px] border border-border-strong bg-white/80 px-3 text-[13px] text-ink outline-none focus:border-primary"
                />
              )}
            </label>
          )
        })}
        {error && <span className="text-[11.5px] text-red-600">{error}</span>}
      </div>
      )}
    </div>
  )
}

function ModelConfigDialog({
  agent,
  onClose,
  onSave,
}: {
  agent: RuntimeAgentRef
  onClose: () => void
  onSave: (modelConfig: RuntimeAgentModelConfig & { customApiKey?: string }) => Promise<void>
}) {
  const initial = agent.modelConfig ?? { mode: 'platform' as const, platformModel: 'gpt-5.5', authStatus: 'authorized' as const }
  const [mode, setMode] = useState<RuntimeAgentModelConfig['mode']>(initial.mode)
  const [platformModel, setPlatformModel] = useState(initial.platformModel ?? 'gpt-5.5')
  const [customEndpoint, setCustomEndpoint] = useState(initial.customEndpoint ?? '')
  const [customApiKey, setCustomApiKey] = useState('')
  const [subscriptionProvider, setSubscriptionProvider] = useState(initial.subscriptionProvider ?? providerFromAgent(agent))
  const [authStatus, setAuthStatus] = useState<NonNullable<RuntimeAgentModelConfig['authStatus']>>(initial.authStatus ?? 'not_configured')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    const cfg: RuntimeAgentModelConfig & { customApiKey?: string } =
      mode === 'custom_llm_api'
        ? { mode, customEndpoint, customApiKey: customApiKey || undefined, customApiKeySet: initial.customApiKeySet || !!customApiKey, authStatus }
        : mode === 'subscription_auth'
          ? { mode, subscriptionProvider, authStatus }
          : { mode, platformModel, authStatus: 'authorized' }
    await onSave(cfg)
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-[220] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-6" onMouseDown={onClose}>
      <div
        className="cirrus-pop w-full max-w-[520px] rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-[16px] font-bold tracking-tight text-ink">Model config</div>
            <div className="text-[12.5px] text-ink-secondary">{agent.name}</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-muted">
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {[
              { key: 'platform', label: 'Platform model', sub: 'Implemented' },
              { key: 'custom_llm_api', label: 'Own API', sub: 'Stored only' },
              { key: 'subscription_auth', label: 'Subscription', sub: 'Skeleton' },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => setMode(item.key as RuntimeAgentModelConfig['mode'])}
                className={cn(
                  'rounded-[11px] border px-3 py-2.5 text-left',
                  mode === item.key ? 'border-primary bg-accent-soft' : 'border-border bg-surface hover:bg-surface-muted',
                )}
              >
                <div className="text-[12.5px] font-semibold text-ink">{item.label}</div>
                <div className="mt-0.5 text-[10.5px] text-ink-tertiary">{item.sub}</div>
              </button>
            ))}
          </div>

          {mode === 'platform' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink">Platform model</span>
              <input
                value={platformModel}
                onChange={(e) => setPlatformModel(e.target.value)}
                className="rounded-[10px] border border-border bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
                placeholder="gpt-5.5"
              />
              <span className="text-[11.5px] text-ink-tertiary">This mode is active today and uses Terr's configured relay/API key.</span>
            </label>
          )}

          {mode === 'custom_llm_api' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink">OpenAI-compatible endpoint</span>
                <input
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  className="rounded-[10px] border border-border bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink">API key</span>
                <input
                  value={customApiKey}
                  onChange={(e) => setCustomApiKey(e.target.value)}
                  type="password"
                  className="rounded-[10px] border border-border bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
                  placeholder={initial.customApiKeySet ? 'Configured - enter a new key to replace' : 'sk-...'}
                />
              </label>
              <div className="rounded-[10px] border border-dashed border-border px-3 py-2 text-[11.5px] text-ink-tertiary">
                Stored as runtime secret. Invocation still uses platform mode until custom API execution is enabled.
              </div>
            </div>
          )}

          {mode === 'subscription_auth' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink">Provider</span>
                <input
                  value={subscriptionProvider}
                  onChange={(e) => setSubscriptionProvider(e.target.value)}
                  className="rounded-[10px] border border-border bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
                  placeholder="codex / claude_code / opencode"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink">Auth status</span>
                <select
                  value={authStatus}
                  onChange={(e) => setAuthStatus(e.target.value as NonNullable<RuntimeAgentModelConfig['authStatus']>)}
                  className="rounded-[10px] border border-border bg-white px-3 py-2 text-[13.5px] text-ink outline-none focus:border-primary"
                >
                  <option value="not_configured">not configured</option>
                  <option value="pending">pending</option>
                  <option value="authorized">authorized</option>
                  <option value="error">error</option>
                </select>
              </label>
              <div className="rounded-[10px] border border-dashed border-border px-3 py-2 text-[11.5px] text-ink-tertiary">
                Native login/subscription authorization is not connected yet. This records the intended provider and status.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            Save config
          </button>
        </div>
      </div>
    </div>
  )
}

function providerFromAgent(agent: RuntimeAgentRef): string {
  const name = agent.name.toLowerCase()
  if (name.includes('claude')) return 'claude_code'
  if (name.includes('codex')) return 'codex'
  if (name.includes('opencode')) return 'opencode'
  return agent.modelConfig?.subscriptionProvider ?? ''
}

function AddAgentsDialog({
  agents,
  existingKeys,
  onClose,
  onAdd,
}: {
  agents: MiniappRecord[]
  existingKeys: Set<string>
  onClose: () => void
  onAdd: (refs: RuntimeAgentRef[]) => void | Promise<void>
}) {
  const [selected, setSelected] = useState<Record<string, RuntimeAgentRef>>({})
  const [busy, setBusy] = useState(false)

  const own: RuntimeAgentRef[] = agents
    .map((a) => ({ key: 'own:' + a.id, name: agentName(a), source: 'own' as const, miniappId: a.id }))
    .filter((r) => !existingKeys.has(r.key))
  const community: RuntimeAgentRef[] = COMMUNITY.map(communityAgentRef).filter((r) => !existingKeys.has(r.key))

  const toggle = (ref: RuntimeAgentRef) =>
    setSelected((prev) => {
      const next = { ...prev }
      if (next[ref.key]) delete next[ref.key]
      else next[ref.key] = ref
      return next
    })

  const picked = Object.values(selected)

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-4 sm:p-6" onMouseDown={onClose}>
      <div
        className="cirrus-pop flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-[16px] font-bold tracking-tight text-ink">Add agents</div>
            <div className="text-[12.5px] text-ink-secondary">Pick agents to add to this runtime.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-muted">
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <AgentPickGroup title="Your agents" empty="All your agents are already in this runtime." items={own} selected={selected} onToggle={toggle} />
          <AgentPickGroup title="Community agents" empty="All community agents are already added." items={community} selected={selected} onToggle={toggle} />
        </div>

        <div className="flex flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[12.5px] text-ink-secondary">
            {picked.length} agent{picked.length === 1 ? '' : 's'} selected
          </div>
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <button onClick={onClose} className="rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
              Cancel
            </button>
            <button
              disabled={picked.length === 0 || busy}
              onClick={async () => { setBusy(true); await onAdd(picked) }}
              className="rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              Add{picked.length ? ` ${picked.length}` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function BotsPanel({
  bots,
  onConnect,
  onDisconnect,
}: {
  bots: RuntimeRecord['bots']
  onConnect: (p: BotPlatform, token?: string) => void | Promise<void>
  onDisconnect: (id: string) => void
}) {
  const [connecting, setConnecting] = useState(false)

  return (
    <div className="relative flex h-full flex-col overflow-auto">
      {bots.length === 0 ? (
        <BotsEmptyState onConnect={() => setConnecting(true)} />
      ) : (
        <div className="flex flex-col gap-3 p-6">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">CONNECTED · {bots.length}</div>
            <button
              onClick={() => setConnecting(true)}
              className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"
            >
              <Plus className="size-[14px]" /> Connect a bot
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {bots.map((b) => {
              const opt = BOT_OPTIONS.find((o) => o.platform === b.platform)
              return (
                <div key={b.id} className="flex items-center gap-2.5 rounded-[11px] border border-border bg-surface px-3 py-2.5">
                  <span
                    className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px]"
                    style={{ background: `${opt?.color ?? '#5B57F2'}1A`, color: opt?.color ?? '#5B57F2' }}
                  >
                    {opt?.icon ?? <Bot className="size-[15px]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-ink">{b.label}</div>
                    <div className="text-[11px] text-ink-tertiary">{b.hasToken ? 'Connected · token saved' : 'Connected'}</div>
                  </div>
                  <button onClick={() => onDisconnect(b.id)} className="rounded-md p-1.5 text-ink-tertiary hover:bg-surface-muted hover:text-destructive">
                    <Trash2 className="size-[15px]" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {connecting &&
        createPortal(
          <ConnectBotDialog
            onClose={() => setConnecting(false)}
            onConnect={async (platform, token) => {
              await onConnect(platform, token)
              setConnecting(false)
            }}
          />,
          document.body,
        )}
    </div>
  )
}

function BotsEmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      {/* playful row of platform icons */}
      <div className="relative flex items-center justify-center">
        {BOT_OPTIONS.map((o, i) => (
          <div
            key={o.platform}
            className={cn('flex size-[52px] items-center justify-center rounded-[16px] border-2 border-white bg-white shadow-[0_12px_30px_-12px_rgba(25,25,23,0.3)]', i === 1 ? 'cirrus-float z-10 -mx-3 size-[60px]' : i === 0 ? 'cirrus-float-slow -rotate-12' : 'cirrus-float-rev rotate-12')}
            style={{ color: o.color }}
          >
            <span className="[&_svg]:size-6">{o.icon}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="text-[16px] font-bold tracking-tight text-ink">No bots connected</div>
        <p className="mx-auto mt-1.5 max-w-[300px] text-[13px] leading-relaxed text-ink-secondary">
          Connect Slack, Telegram, or Lark so people can talk to this runtime right from their chat app.
        </p>
      </div>
      <button
        onClick={onConnect}
        className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
      >
        <Plus className="size-[15px]" /> Connect a bot
      </button>
    </div>
  )
}

function ConnectBotDialog({
  onClose,
  onConnect,
}: {
  onClose: () => void
  onConnect: (platform: BotPlatform, token: string) => void | Promise<void>
}) {
  const [platform, setPlatform] = useState<BotPlatform>('slack')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const opt = BOT_OPTIONS.find((o) => o.platform === platform)!

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-ink/40 backdrop-blur-sm cirrus-overlay p-6" onMouseDown={onClose}>
      <div
        className="cirrus-pop flex w-full max-w-[440px] flex-col overflow-hidden rounded-[18px] border border-border bg-surface shadow-[0_30px_80px_-20px_rgba(25,25,23,0.35)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="text-[16px] font-bold tracking-tight text-ink">Connect a bot</div>
            <div className="text-[12.5px] text-ink-secondary">Choose a platform and paste its token.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-surface-muted">
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="grid grid-cols-3 gap-2.5">
            {BOT_OPTIONS.map((o) => {
              const on = platform === o.platform
              return (
                <button
                  key={o.platform}
                  onClick={() => setPlatform(o.platform)}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-[12px] border px-3 py-3 transition',
                    on ? 'border-primary bg-accent-soft' : 'border-border bg-surface hover:bg-surface-muted',
                  )}
                >
                  <span
                    className="flex size-[32px] items-center justify-center rounded-[9px]"
                    style={{ background: `${o.color}1A`, color: o.color }}
                  >
                    {o.icon}
                  </span>
                  <span className="text-[12.5px] font-semibold text-ink">{o.label}</span>
                </button>
              )
            })}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-ink">{opt.tokenLabel}</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={opt.tokenHint}
              autoComplete="off"
              className="rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-primary"
            />
            <span className="text-[11px] text-ink-tertiary">Stored securely on the runtime — never shown again after saving.</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={onClose} className="rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
            Cancel
          </button>
          <button
            disabled={!token.trim() || busy}
            onClick={async () => { setBusy(true); await onConnect(platform, token.trim()) }}
            className="rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            Connect {opt.label}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ───────── Mini App · build chat (Edit mode) ───────── */

export function applyBuildChatEvent(messages: UiMessage[], assistantId: string, ev: AgentEvent): UiMessage[] {
  return messages.map((m) => {
    if (m.id !== assistantId) return m
    const activities = m.activities ? [...m.activities] : []
    switch (ev.type) {
      case 'status':
        if (ev.text.startsWith('Still working…')) {
          const previous = activities.findIndex((activity) => activity.kind === 'status' && activity.text.startsWith('Still working…'))
          if (previous >= 0) activities[previous] = { kind: 'status', text: ev.text }
          else activities.push({ kind: 'status', text: ev.text })
        } else {
          activities.push({ kind: 'status', text: ev.text })
        }
        return { ...m, activities }
      case 'tool_call':
        activities.push({ kind: 'tool', text: ev.summary })
        return { ...m, activities }
      case 'tool_result':
        if (!ev.ok) activities.push({ kind: 'error', text: `${ev.name} failed${ev.detail ? `: ${ev.detail}` : ''}`, ok: false })
        return { ...m, activities }
      case 'build':
        activities.push({ kind: 'build', ok: ev.ok, text: ev.ok ? 'Build succeeded' : `Build failed: ${ev.error ?? 'unknown error'}` })
        return { ...m, activities }
      case 'assistant':
        return { ...m, content: `${m.content ?? ''}${ev.text}` }
      case 'image':
        return { ...m, images: [...(m.images ?? []), { url: ev.url, alt: ev.alt }] }
      case 'choices':
        return { ...m, choices: ev.choices, allowFreeText: ev.allowFreeText }
      case 'done':
        return { ...m, durationMs: ev.durationMs }
      case 'error':
        activities.push({ kind: 'error', text: ev.message, ok: false })
        return { ...m, activities }
      default:
        return m
    }
  })
}

function mentionHighlightSegments(text: string, agents: RuntimeAgentRef[]): { text: string; mention: boolean }[] {
  if (!text) return []
  const sortedAgents = [...agents].sort((a, b) => b.name.length - a.name.length)
  const segments: { text: string; mention: boolean }[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at < 0) {
      segments.push({ text: text.slice(index), mention: false })
      break
    }
    if (at > index) segments.push({ text: text.slice(index, at), mention: false })
    const rest = text.slice(at)
    const exact = sortedAgents.find((agent) => rest.toLowerCase().startsWith(`@${agent.name}`.toLowerCase()))
    if (exact) {
      const end = at + exact.name.length + 1
      segments.push({ text: text.slice(at, end), mention: true })
      index = end
      continue
    }
    const partial = rest.match(/^@[^\s@]*/)
    if (partial?.[0]) {
      segments.push({ text: partial[0], mention: true })
      index = at + partial[0].length
    } else {
      segments.push({ text: '@', mention: true })
      index = at + 1
    }
  }
  return segments
}

export function BuildChat({
  title,
  placeholder,
  empty,
  messages,
  building,
  busyLabel = 'working...',
  loading = false,
  onSend,
  attachmentLabel,
  onClearAttachment,
  mentionAgents = [],
}: {
  title: string
  placeholder: string
  empty: string
  messages: UiMessage[]
  building: boolean
  busyLabel?: string
  loading?: boolean
  onSend?: (text: string) => void
  attachmentLabel?: string
  onClearAttachment?: () => void
  mentionAgents?: RuntimeAgentRef[]
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [workingStartedAt, setWorkingStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const toBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    if (!building) {
      setWorkingStartedAt(null)
      return
    }
    setWorkingStartedAt((current) => current ?? Date.now())
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [building])
  // Stick to the latest message as new ones stream in.
  useEffect(() => {
    if (loading) return
    const raf = requestAnimationFrame(toBottom)
    return () => cancelAnimationFrame(raf)
  }, [messages, building, loading, toBottom])
  // After the initial load completes, force-scroll to the newest message. Retry
  // across a few frames so async markdown/layout reflow doesn't strand us mid-list.
  useEffect(() => {
    if (loading) return
    const timers = [0, 60, 160, 320].map((d) => window.setTimeout(toBottom, d))
    return () => timers.forEach(clearTimeout)
  }, [loading, toBottom])
  const send = () => {
    const t = input.trim()
    if (!t || building || !onSend) return
    onSend(t)
    setInput('')
  }
  const mentionMatch = input.match(/(^|\s)@([^\s@]*)$/)
  const mentionQuery = mentionMatch?.[2]?.toLowerCase() ?? ''
  const mentionOptions = mentionMatch
    ? mentionAgents
        .filter((agent) => {
          if (!mentionQuery) return true
          return agent.name.toLowerCase().includes(mentionQuery) || agent.key.toLowerCase().includes(mentionQuery)
        })
        .slice(0, 8)
    : []
  const insertMention = (agent: RuntimeAgentRef) => {
    if (!mentionMatch) return
    const start = input.slice(0, mentionMatch.index ?? 0)
    const prefix = mentionMatch[1] ?? ''
    const next = `${start}${prefix}@${agent.name} `
    setInput(next)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }
  const inputSegments = mentionHighlightSegments(input, mentionAgents)
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const activities = latestAssistant?.activities ?? []
  const heartbeatActivity = [...activities].reverse().find((activity) => activity.text.startsWith('Still working…'))
  const latestActivity = [...activities].reverse().find((activity) => !activity.text.startsWith('Still working…'))
  const elapsed = workingStartedAt ? formatWorkedDuration(now - workingStartedAt) : ''
  const workingText =
    heartbeatActivity?.text ??
    [elapsed ? `${busyLabel.replace(/\.+$/, '')} for ${elapsed}` : busyLabel, latestActivity?.text ? `Last step: ${latestActivity.text}` : 'Preparing the builder…']
      .filter(Boolean)
      .join(' · ')
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-white/40">
      {title && <div className="border-b border-black/5 px-4 py-2.5 text-[12px] font-semibold text-ink">{title}</div>}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12.5px] text-ink-tertiary">
            <Loader2 className="size-4 animate-spin" /> Loading chat…
          </div>
        ) : (
          messages.length === 0 && <div className="text-[12.5px] leading-relaxed text-ink-tertiary">{empty}</div>
        )}
        {!loading && messages.map((m, i) => (
          <BuildMsg
            key={m.id}
            m={m}
            working={building && i === messages.length - 1}
            isLast={i === messages.length - 1}
            onChoice={onSend}
          />
        ))}
        {building && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-ink-tertiary" title={workingText}>
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span className="truncate">{workingText}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="border-t border-black/5 p-3">
        {attachmentLabel && (
          <div className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-accent-ink">
            <MousePointer2 className="size-3" />
            <span className="truncate">{attachmentLabel}</span>
            <button onClick={onClearAttachment} aria-label="Clear selection" className="text-accent-ink/70 hover:text-accent-ink">
              <X className="size-3" />
            </button>
          </div>
        )}
        <div className="relative">
          {mentionOptions.length > 0 && (
            <div className="absolute bottom-full left-3 z-20 mb-2 w-[260px] overflow-hidden rounded-[12px] border border-border bg-surface p-1.5 shadow-[0_14px_34px_-12px_rgba(25,25,23,0.22)]">
              {mentionOptions.map((agent) => (
                <button
                  key={agent.key}
                  type="button"
                  onClick={() => insertMention(agent)}
                  className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-surface-muted"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink">
                    <Sparkles className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold text-ink">@{agent.name}</span>
                    <span className="block truncate text-[10.5px] text-ink-tertiary">{agent.source}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-full border border-border-strong bg-white/80 py-1.5 pl-3.5 pr-1.5">
            <div className="relative min-w-0 flex-1">
              {input && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-[13px] leading-none text-ink"
                >
                  {inputSegments.map((segment, i) => (
                    <span key={i} className={segment.mention ? 'font-medium text-primary' : undefined}>
                      {segment.text}
                    </span>
                  ))}
                </div>
              )}
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                disabled={building}
                placeholder={placeholder}
                className={cn(
                  'relative z-10 w-full bg-transparent text-[13px] outline-none caret-ink placeholder:text-ink-tertiary disabled:opacity-60',
                  input ? 'text-transparent' : 'text-ink',
                )}
              />
            </div>
            <button
              onClick={send}
              disabled={building || !input.trim()}
              className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowUp className="size-[15px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatWorkedDuration(ms?: number) {
  if (ms == null || !Number.isFinite(ms)) return ''
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function BuildMsg({ m, working = false, isLast = false, onChoice }: { m: UiMessage; working?: boolean; isLast?: boolean; onChoice?: (text: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-primary px-3 py-2 text-[13px] leading-snug text-primary-foreground">
          {m.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2">
      <Avatar sm />
      <div className="flex min-w-0 flex-col gap-1.5">
        {m.activities && m.activities.length > 0 && (
          <ActivityChain
            activities={m.activities}
            durationMs={m.durationMs}
            expanded={working || expanded}
            collapsible={!working && !!m.content}
            onToggle={() => setExpanded((v) => !v)}
          />
        )}
        {m.content && (
          <div className="rounded-[14px] rounded-bl-[4px] bg-surface-muted px-3 py-2 text-[13px] leading-snug text-ink">
            <ErrorBoundary
              resetKey={m.id + ':' + m.content}
              fallback={(error) => (
                <div className="space-y-2">
                  <div className="rounded-[10px] border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11.5px] text-amber-700">
                    Message markdown failed to render: {error.message}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-snug text-ink">{m.content}</pre>
                </div>
              )}
            >
              <MessageResponse>{m.content}</MessageResponse>
            </ErrorBoundary>
          </div>
        )}
        {/* send_image: image attachments */}
        {m.images && m.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {m.images.map((img, i) => (
              <a key={i} href={img.url} target="_blank" rel="noreferrer" className="block max-w-[240px] overflow-hidden rounded-[12px] border border-border">
                <img src={img.url} alt={img.alt ?? ''} className="block max-h-[240px] w-full object-cover" />
                {img.alt && <div className="px-2 py-1 text-[11px] text-ink-tertiary">{img.alt}</div>}
              </a>
            ))}
          </div>
        )}
        {/* ask_user: quick-reply buttons (only actionable on the latest message) */}
        {m.choices && m.choices.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {m.choices.map((c, i) => (
              <button
                key={i}
                type="button"
                disabled={!isLast || !onChoice}
                onClick={() => onChoice?.(c.value)}
                className="rounded-full border border-primary/30 bg-accent-soft px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:bg-primary hover:text-primary-foreground disabled:cursor-default disabled:opacity-55 disabled:hover:bg-accent-soft disabled:hover:text-accent-ink"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityChain({
  activities,
  durationMs,
  expanded,
  collapsible,
  onToggle,
}: {
  activities: NonNullable<UiMessage['activities']>
  durationMs?: number
  expanded: boolean
  collapsible: boolean
  onToggle: () => void
}) {
  if (collapsible) {
    const duration = formatWorkedDuration(durationMs)
    return (
      <div className="mb-0.5">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted/70 px-2.5 py-1 text-[11.5px] font-medium text-ink-tertiary hover:bg-surface-muted hover:text-ink-secondary"
        >
          <span>{duration ? `Worked for ${duration}` : 'Worked'}</span>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        {expanded && (
          <div className="mt-1.5 flex flex-col gap-1 border-l border-border pl-2.5">
            {activities.map((a, i) => (
              <ActivityLine key={i} activity={a} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {activities.map((a, i) => (
        <ActivityLine key={i} activity={a} />
      ))}
    </div>
  )
}

function ActivityLine({ activity }: { activity: NonNullable<UiMessage['activities']>[number] }) {
  return (
    <div className={cn('text-[11.5px] leading-snug', activity.ok === false ? 'text-amber-600' : 'text-ink-tertiary')}>
      {activity.text}
    </div>
  )
}

/* ───────── Add Skills dialog ───────── */

const newSkillId = () => 'sk-' + Math.random().toString(36).slice(2, 8)

function platformToSkill(p: PlatformSkill): MiniappSkill {
  return {
    id: newSkillId(),
    name: p.name,
    category: p.category,
    description: p.description,
    source: 'library',
    kind: 'builtin',
    status: 'active',
    platformSkillId: p.id,
    tools: p.tools ?? [],
    credentials: p.credentials ?? [],
    credentialsFilled: [],
    config: p.config ? { ...p.config } : undefined,
  }
}

function customSkill(desc: string): MiniappSkill {
  return {
    id: newSkillId(),
    name: desc.length > 36 ? desc.slice(0, 36) + '…' : desc || 'Custom skill',
    category: 'tool',
    description: desc,
    source: 'generated',
    kind: 'custom',
    status: 'needs_dev',
    tools: [],
    credentials: [],
    config: { suggestedMethods: ['generate', 'integrate'] },
  }
}

// The platform skills from the design. `pid` maps to a backend platform skill
// when one exists; otherwise we synthesize a built-in skill from the design entry.
const DESIGN_SKILLS: { pid: string; name: string; desc: string; cat: MiniappSkill['category']; icon: React.ReactNode }[] = [
  { pid: 'gmail', name: 'Gmail', desc: 'Read & triage email', cat: 'connector', icon: <Mail className="size-[16px]" /> },
  { pid: 'database', name: 'Database', desc: 'Store & query records', cat: 'data', icon: <Database className="size-[16px]" /> },
  { pid: 'github', name: 'GitHub', desc: 'Manage repos & issues', cat: 'connector', icon: <Github className="size-[16px]" /> },
  { pid: 'http_request', name: 'HTTP API', desc: 'Call external APIs', cat: 'connector', icon: <Globe className="size-[16px]" /> },
]

function AddSkillsDialog({
  existingPlatformIds,
  onAddSkill,
  onAddCustom,
  onClose,
}: {
  existingPlatformIds: Set<string>
  onAddSkill: (s: MiniappSkill) => void
  onAddCustom: (desc: string) => void
  onClose: () => void
}) {
  const [lib, setLib] = useState<PlatformSkill[]>([])
  const [desc, setDesc] = useState('')
  useEffect(() => {
    void listSkillLibrary().then(setLib).catch(() => {})
  }, [])

  const add = (d: (typeof DESIGN_SKILLS)[number]) => {
    const real = lib.find((p) => p.id === d.pid)
    if (real) {
      onAddSkill(platformToSkill(real))
    } else {
      onAddSkill({
        id: newSkillId(),
        name: d.name,
        category: d.cat,
        description: d.desc,
        source: 'library',
        kind: 'builtin',
        status: 'active',
        platformSkillId: d.pid,
        tools: [],
        credentials: [],
        credentialsFilled: [],
      })
    }
  }
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6" onPointerDown={onClose}>
      <div className="absolute inset-0 bg-[#1A1A17]/25 backdrop-blur-[3px]" />
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="relative flex max-h-[82vh] w-[660px] flex-col overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_30px_70px_-16px_rgba(25,25,23,0.4)]"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="flex-1">
            <div className="text-[18px] font-bold tracking-tight text-ink">Add Skills</div>
            <div className="text-[13px] text-ink-secondary">Extend your agent with a platform skill, or build your own.</div>
          </div>
          <button
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg border border-border hover:bg-surface-muted"
            aria-label="Close"
          >
            <X className="size-4 text-ink-secondary" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-5">
            <div className="font-mono text-[10.5px] tracking-[0.13em] text-ink-tertiary">PLATFORM SKILLS</div>
            <div className="grid grid-cols-4 gap-3">
              {DESIGN_SKILLS.map((d) => {
                const added = existingPlatformIds.has(d.pid)
                return (
                  <button
                    key={d.pid}
                    disabled={added}
                    onClick={() => add(d)}
                    className={cn(
                      'flex flex-col gap-2.5 rounded-[12px] border border-border p-3 text-left transition',
                      added ? 'opacity-50' : 'hover:border-border-strong hover:bg-surface-muted',
                    )}
                  >
                    <div className="flex items-center">
                      <div className="flex size-8 items-center justify-center rounded-[8px] bg-surface-muted text-ink">{d.icon}</div>
                      <span className="flex-1" />
                      {added ? (
                        <span className="text-[10px] font-medium text-ink-tertiary">Added</span>
                      ) : (
                        <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                          <Plus className="size-3" />
                        </span>
                      )}
                    </div>
                    <div className="text-[13px] font-semibold text-ink">{d.name}</div>
                    <div className="line-clamp-2 text-[11px] leading-snug text-ink-tertiary">{d.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-3 p-5">
            <div className="font-mono text-[10.5px] tracking-[0.13em] text-ink-tertiary">ADD YOUR OWN SKILL</div>
            <div className="flex items-center gap-2 rounded-full border border-border-strong bg-surface py-2 pl-4 pr-2">
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && desc.trim() && onAddCustom(desc.trim())}
                placeholder="Describe what skill you want to have"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-tertiary"
              />
              <button
                onClick={() => desc.trim() && onAddCustom(desc.trim())}
                disabled={!desc.trim()}
                className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
                aria-label="Add"
              >
                <ArrowUp className="size-[17px]" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
