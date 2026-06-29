import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronDown,
  Code2,
  FileCode2,
  FileText,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Save,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { SkillCategory, SkillSetting, SkillToolCall } from '@shared/protocol'
import type { AgentFlowNavState, NavView } from '@/wizard/AgentCanvas'
import {
  createSkill,
  draftStandaloneSkill,
  getSkill,
  listSkillTemplates,
  updateSkill,
  type DraftSkillResult,
} from '@/lib/api'
import { SkillScriptsPanel } from '@/components/skill/SkillScriptsPanel'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { cn } from '@/lib/utils'

type SkillCreationPhase = 'define' | 'tool' | 'configs'
type ToolImplementation = 'readme' | 'script'

interface SkillDefinition {
  name: string
  description: string
  readme: string
  category: SkillCategory
}

interface DraftTool {
  id: string
  name: string
  description: string
  implementation: ToolImplementation
  entry: string
  parametersText: string
}

interface DraftSetting extends SkillSetting {
  id: string
}

const PHASES: { key: SkillCreationPhase; label: string }[] = [
  { key: 'define', label: 'Define' },
  { key: 'tool', label: 'Tool call' },
  { key: 'configs', label: 'Configs' },
]

const DEFAULT_PARAMETERS = JSON.stringify(
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'User intent or lookup query.' },
    },
    required: ['query'],
  },
  null,
  2,
)

/** The skill-relative script path a tool implements (matches the backend). */
function toolScriptPath(entry: string): string {
  const e = entry.trim()
  if (!e) return ''
  return e.includes('/') ? e : `tools/${e}`
}

export function NewSkillPage({
  draftId,
  onNavigate,
  onNavStateChange,
}: {
  draftId?: string | null
  onNavigate: (view: NavView) => void
  onNavStateChange?: (state: AgentFlowNavState | null) => void
}) {
  const [skillId, setSkillId] = useState<string | null>(draftId ?? null)
  const [definition, setDefinition] = useState<SkillDefinition>(emptyDefinition())
  const [tools, setTools] = useState<DraftTool[]>([newTool()])
  const [settings, setSettings] = useState<DraftSetting[]>([])
  // Editing an existing skill (draftId) skips the guided Define intro and opens
  // the build canvas directly (compact Define card + Tool + Configs), the same way
  // returning to an agent skips its Define chat.
  const [reached, setReached] = useState(draftId ? PHASES.length - 1 : 0)
  const [focus, setFocus] = useState(draftId ? 1 : 0)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const [animate, setAnimate] = useState(true)
  const [grabbing, setGrabbing] = useState(false)
  const [scriptsFor, setScriptsFor] = useState<{ skillId: string; path: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const focusIndex = Math.min(focus, reached)
  const focusKey = PHASES[focusIndex].key
  const columns = PHASES.slice(0, reached + 1).map((phase) => phase.key)
  const canPan = reached > 0

  // Load an existing skill when editing (draftId is the backend skill id).
  useEffect(() => {
    if (!draftId) return
    let alive = true
    void getSkill(draftId)
      .then((skill) => {
        if (!alive) return
        setSkillId(skill.id)
        setDefinition({ name: skill.name, description: skill.description, readme: skill.readme, category: skill.category })
        setTools(skill.tools.length ? skill.tools.map(draftToolFromSkillTool) : [newTool()])
        setSettings(skill.credentials.map(draftSettingFromSkillSetting))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [draftId])

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
      const center = col.offsetLeft + col.offsetWidth / 2
      const desiredTop = reached === 0 ? Math.max(120, Math.round((container.clientHeight - col.offsetHeight) / 2)) : 120
      setAnimate(true)
      setOffset({ x: Math.round(container.clientWidth / 2 - center), y: Math.round(desiredTop - col.offsetTop) })
    }
    recenter()
    window.addEventListener('resize', recenter)
    let ro: ResizeObserver | null = null
    const focused = colRefs.current[focusKey]
    if (focused && 'ResizeObserver' in window) {
      ro = new ResizeObserver(() => recenter())
      ro.observe(focused)
    }
    return () => {
      window.removeEventListener('resize', recenter)
      ro?.disconnect()
    }
  }, [focusKey, reached, tools.length, settings.length])

  const contractInput = () => ({
    name: definition.name.trim() || 'Untitled skill',
    category: definition.category,
    description: definition.description.trim() || descriptionFromReadme(definition.readme, ''),
    readme: normalizedReadme(definition),
    tools: tools.map(toSkillTool),
    credentials: settings.map(({ id: _id, ...setting }) => setting),
  })

  // Create the skill server-side (or update it), returning its id. This is what
  // gives script tools a real home so "View Scripts" can edit/test them.
  const ensureSkill = async (): Promise<string | null> => {
    try {
      if (skillId) {
        await updateSkill(skillId, contractInput())
        return skillId
      }
      const created = await createSkill(contractInput())
      setSkillId(created.id)
      // Adopt the server-deduped name (e.g. "QQ Mailbox (2)") so a later save
      // doesn't overwrite it back to the colliding name.
      setDefinition((d) => (d.name === created.name ? d : { ...d, name: created.name, readme: syncReadmeTitle(d.readme, created.name) }))
      return created.id
    } catch {
      return null
    }
  }

  const advance = () => {
    void ensureSkill()
    const next = Math.min(PHASES.length - 1, reached + 1)
    setReached(next)
    setFocus(next)
  }
  const back = () => setFocus(Math.max(0, focusIndex - 1))

  const seedFromContract = (c: { name: string; description: string; readme: string; category: SkillCategory; tools: SkillToolCall[]; credentials: SkillSetting[] }) => {
    setDefinition({ name: c.name, description: c.description, readme: c.readme, category: c.category })
    setTools(c.tools.length ? c.tools.map(draftToolFromSkillTool) : [newTool()])
    setSettings(c.credentials.map(draftSettingFromSkillSetting))
  }

  const onViewScripts = async (tool: DraftTool) => {
    const id = await ensureSkill()
    if (!id) return
    setScriptsFor({ skillId: id, path: toolScriptPath(tool.entry) || null })
  }

  // Open skill.md in the panel so the agent can rewrite the README.
  const onViewReadme = async () => {
    const id = await ensureSkill()
    if (!id) return
    setScriptsFor({ skillId: id, path: 'skill.md' })
  }

  const onPanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canPan) return
    if ((event.target as HTMLElement).closest('button, input, textarea, select, [data-no-pan]')) return
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: offset?.x ?? 0, oy: offset?.y ?? 0 }
    setAnimate(false)
    setGrabbing(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset({ x: drag.ox + (event.clientX - drag.sx), y: drag.oy + (event.clientY - drag.sy) })
  }
  const onPanEnd = () => {
    dragRef.current = null
    setGrabbing(false)
  }

  const schemaError = useMemo(() => firstSchemaError(tools), [tools])
  const canContinueDefine = !!definition.name.trim() && !!definition.readme.trim()
  const canContinueTools = tools.length > 0 && tools.every((tool) => tool.name.trim() && tool.description.trim()) && !schemaError

  const saveSkill = async () => {
    if (!canContinueDefine || !canContinueTools || saving) return
    setSaving(true)
    const id = await ensureSkill()
    setSaving(false)
    if (id) onNavigate('dashSkills')
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
      className={cn('dot-bg relative h-full w-full overflow-hidden', !canPan ? 'cursor-default' : grabbing ? 'cursor-grabbing select-none' : 'cursor-grab')}
    >
      {reached > 0 && (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[240px]" style={{ background: 'linear-gradient(to right, var(--background), transparent)' }} />
      )}

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
            {key === 'define' && (
              <DefineSkillColumn definition={definition} compact={reached > 0} canContinue={canContinueDefine} onChange={setDefinition} onSeed={seedFromContract} onViewReadme={onViewReadme} onContinue={advance} />
            )}
            {key === 'tool' && (
              <ToolCallColumn tools={tools} schemaError={schemaError} canContinue={canContinueTools} onTools={setTools} onViewScripts={onViewScripts} onBack={back} onContinue={advance} />
            )}
            {key === 'configs' && (
              <ConfigsColumn definition={definition} tools={tools} settings={settings} saving={saving} canSave={canContinueDefine && canContinueTools} onEditSettings={() => setSettingsOpen(true)} onBack={back} onSave={saveSkill} />
            )}
          </div>
        ))}
      </div>

      {scriptsFor && (
        <SkillScriptsPanel
          skillId={scriptsFor.skillId}
          skillName={definition.name || 'Untitled skill'}
          tools={tools.map(toSkillTool)}
          initialPath={scriptsFor.path}
          onClose={() => setScriptsFor(null)}
          onReadmeChange={(readme) => setDefinition((d) => ({ ...d, readme, description: descriptionFromReadme(readme, d.description) }))}
        />
      )}

      {settingsOpen && <SettingsPanel settings={settings} onSettings={setSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function DefineSkillColumn({
  definition,
  compact,
  canContinue,
  onChange,
  onSeed,
  onViewReadme,
  onContinue,
}: {
  definition: SkillDefinition
  compact: boolean
  canContinue: boolean
  onChange: (definition: SkillDefinition) => void
  onSeed: (c: { name: string; description: string; readme: string; category: SkillCategory; tools: SkillToolCall[]; credentials: SkillSetting[] }) => void
  onViewReadme: () => void
  onContinue: () => void
}) {
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof listSkillTemplates>>>([])
  const hasDraft = !!definition.name.trim() && !!definition.readme.trim()

  useEffect(() => {
    void listSkillTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  const seedFromDraft = (draft: DraftSkillResult) => {
    onSeed({ name: draft.name, description: draft.description, readme: draft.readme, category: draft.category, tools: draft.tools, credentials: draft.credentials })
  }

  const generateDraft = async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || busy) return
    setThread((current) => [...current, { role: 'user', content: text }])
    setInput('')
    setBusy(true)
    try {
      const draft = await draftStandaloneSkill(text)
      seedFromDraft(draft)
      setThread((current) => [...current, { role: 'assistant', content: draft.summary || `Drafted ${draft.name}.` }])
    } catch {
      setThread((current) => [...current, { role: 'assistant', content: 'Something went wrong drafting that — try again?' }])
    } finally {
      setBusy(false)
    }
  }

  const useTemplate = (id: string) => {
    const tpl = templates.find((t) => t.id === id)
    if (!tpl) return
    onSeed({ name: tpl.name, description: tpl.description, readme: tpl.readme, category: tpl.category, tools: tpl.tools, credentials: tpl.credentials })
    setThread((current) => [...current, { role: 'assistant', content: `Started from the ${tpl.name} template.` }])
  }

  // Keep the skill.md H1 in sync with the title as the user edits it.
  const onTitleChange = (name: string) => {
    onChange({ ...definition, name, readme: syncReadmeTitle(definition.readme, name) })
  }

  if (compact) {
    return (
      <section className="w-[380px] rounded-[18px] border border-border bg-white/85 p-5 shadow-[0_14px_38px_-24px_rgba(25,25,23,0.28)] backdrop-blur">
        <ColumnEyebrow>DEFINE</ColumnEyebrow>
        <h2 className="truncate text-[18px] font-bold tracking-tight text-ink">{definition.name || 'Untitled skill'}</h2>
        <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-ink-secondary">{definition.description || 'No description yet.'}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-ink">skill.md</span>
            <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary capitalize">{definition.category}</span>
          </div>
          <button
            type="button"
            onClick={() => void onViewReadme()}
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-muted"
          >
            <FileText className="size-[13px] text-accent-ink" /> View
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="flex max-h-[calc(100vh-150px)] w-[600px] flex-col rounded-[22px] border border-border bg-white/90 p-6 shadow-[0_20px_60px_-34px_rgba(25,25,23,0.34)] backdrop-blur">
      <ColumnEyebrow>DEFINE</ColumnEyebrow>
      <h1 className="text-[26px] font-bold tracking-tight text-ink">Create a skill</h1>
      <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-ink-secondary">
        Describe the capability you want, or start from a template. Cirrus drafts the title, skill.md, tools and credentials.
      </p>

      <div className="mt-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="flex items-end gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </div>
          <div className="rounded-[18px] rounded-bl-[5px] bg-surface-muted px-[15px] py-[11px] text-[14.5px] text-ink">What should this skill help an agent do?</div>
        </div>

        {thread.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[78%] rounded-[16px] rounded-br-[5px] bg-primary px-[14px] py-[10px] text-[14px] text-primary-foreground">{message.content}</div>
            </div>
          ) : (
            <div key={index} className="flex items-end gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Sparkles className="size-4" />
              </div>
              <div className="rounded-[16px] rounded-bl-[5px] bg-surface-muted px-[14px] py-[10px] text-[14px] text-ink">{message.content}</div>
            </div>
          ),
        )}

        {busy && (
          <div className="flex items-center gap-2 pl-1 text-xs text-ink-tertiary">
            <Loader2 className="size-3.5 animate-spin" /> drafting skill…
          </div>
        )}

        {!hasDraft && (
          <>
            {templates.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[11.5px] font-semibold text-ink-tertiary">Start from a template</span>
                <div className="flex flex-wrap gap-2">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => useTemplate(tpl.id)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-muted"
                    >
                      <FileCode2 className="size-[13px] text-accent-ink" /> {tpl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {['Read my Gmail inbox and summarize urgent messages', 'Search a private API and return normalized records', 'Turn uploaded CSV rows into a queryable knowledge source'].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => generateDraft(suggestion)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:bg-surface-muted"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </>
        )}

        {hasDraft && (
          <div className="cirrus-pop rounded-[16px] border border-border bg-surface p-4 shadow-[0_8px_24px_-6px_rgba(25,25,23,0.07)]">
            <div className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-primary" />
              <span className="font-mono text-[10.5px] tracking-[0.12em] text-ink-tertiary">SKILL DRAFT READY</span>
            </div>
            <input
              value={definition.name}
              onChange={(event) => onTitleChange(event.target.value)}
              className="mt-2 w-full bg-transparent text-[18px] font-bold tracking-tight text-ink outline-none"
            />
            <textarea
              value={definition.description}
              onChange={(event) => onChange({ ...definition, description: event.target.value })}
              rows={2}
              className="mt-1 w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink-secondary outline-none"
            />
            <div className="mt-3 flex items-center gap-2">
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-ink">skill.md</span>
              <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary capitalize">{definition.category}</span>
              <button
                type="button"
                onClick={() => void onViewReadme()}
                className="ml-auto inline-flex items-center gap-1.5 rounded-[9px] border border-border-strong bg-white px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-muted"
              >
                <FileText className="size-[13px] text-accent-ink" /> View skill.md
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onContinue}
                disabled={!canContinue}
                className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                Create skill <ArrowRight className="size-[15px]" />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 shrink-0">
        <div className="flex items-center gap-2.5 rounded-full border border-border-strong bg-surface py-2 pl-[18px] pr-2 shadow-[0_6px_20px_-8px_rgba(25,25,23,0.06)]">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void generateDraft()
              }
            }}
            placeholder="Describe the skill you want to create..."
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-tertiary"
          />
          <button
            type="button"
            onClick={() => generateDraft()}
            disabled={busy || !input.trim()}
            className="inline-flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
            aria-label="Draft skill"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </div>
    </section>
  )
}

function ToolCallColumn({
  tools,
  schemaError,
  canContinue,
  onTools,
  onViewScripts,
  onBack,
  onContinue,
}: {
  tools: DraftTool[]
  schemaError: string | null
  canContinue: boolean
  onTools: (tools: DraftTool[]) => void
  onViewScripts: (tool: DraftTool) => void
  onBack: () => void
  onContinue: () => void
}) {
  const update = (id: string, patch: Partial<DraftTool>) => {
    onTools(tools.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)))
  }
  const [expandedId, setExpandedId] = useState<string | null>(tools.length === 1 ? tools[0]?.id ?? null : null)
  const addTool = () => {
    const tool = newTool()
    onTools([...tools, tool])
    setExpandedId(tool.id)
  }
  const removeTool = (id: string) => {
    onTools(tools.filter((tool) => tool.id !== id))
    setExpandedId((current) => (current === id ? null : current))
  }

  return (
    <section className="w-[640px] rounded-[22px] border border-border bg-white/90 p-6 shadow-[0_20px_60px_-34px_rgba(25,25,23,0.34)] backdrop-blur">
      <ColumnEyebrow>TOOL CALL</ColumnEyebrow>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[24px] font-bold tracking-tight text-ink">Tool call contract</h2>
          <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-ink-secondary">
            Declare callable tools and parameter schemas. Script-backed tools get a real file you can view, edit and test.
          </p>
        </div>
        <button
          type="button"
          onClick={addTool}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-2 text-[12.5px] font-semibold text-ink-secondary hover:bg-surface-muted"
        >
          <Plus className="size-[14px]" /> Tool
        </button>
      </div>

      <div className="mt-5 grid max-h-[58vh] gap-3 overflow-y-auto pr-1">
        {tools.map((tool) => {
          const expanded = expandedId === tool.id
          const incomplete = !tool.name.trim() || !tool.description.trim()
          const isScript = tool.implementation === 'script'
          return (
            <article key={tool.id} className="overflow-hidden rounded-[16px] border border-border bg-surface">
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpandedId(expanded ? null : tool.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setExpandedId(expanded ? null : tool.id)
                }}
                className="flex cursor-pointer items-center gap-3 p-3.5"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
                  <Code2 className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] font-semibold text-ink">{tool.name.trim() || 'unnamed_tool'}</span>
                    <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">{isScript ? 'Script' : 'README'}</span>
                    {incomplete && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Needs a name and description" />}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-ink-tertiary">{tool.description.trim() || (isScript ? tool.entry || 'script.ts' : 'README instruction')}</div>
                </div>
                {isScript && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void onViewScripts(tool)
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border-strong bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:bg-surface-muted"
                  >
                    <FileCode2 className="size-[14px] text-accent-ink" /> View Scripts
                  </button>
                )}
                {tools.length > 1 && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeTool(tool.id)
                    }}
                    className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-tertiary hover:bg-surface-muted hover:text-destructive"
                    aria-label="Remove tool"
                  >
                    <Trash2 className="size-[15px]" />
                  </button>
                )}
                <ChevronDown className={cn('size-4 shrink-0 text-ink-tertiary transition-transform', expanded && 'rotate-180')} />
              </div>

              {expanded && (
                <div className="border-t border-border p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1.5">
                      <span className="text-[11.5px] font-semibold text-ink-secondary">Function name</span>
                      <input
                        value={tool.name}
                        onChange={(event) => {
                          const name = functionName(event.target.value)
                          update(tool.id, { name, entry: tool.implementation === 'script' ? `${slugify(name) || 'tool'}.ts` : tool.entry })
                        }}
                        placeholder="search_messages"
                        className="rounded-[10px] border border-border bg-white px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-primary"
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-[11.5px] font-semibold text-ink-secondary">Implementation</span>
                      <select
                        value={tool.implementation}
                        onChange={(event) => {
                          const implementation = event.target.value as ToolImplementation
                          update(tool.id, { implementation, entry: implementation === 'script' ? tool.entry || `${slugify(tool.name) || 'tool'}.ts` : '' })
                        }}
                        className="rounded-[10px] border border-border bg-white px-3 py-2.5 text-[13px] font-medium text-ink outline-none focus:border-primary"
                      >
                        <option value="readme">README instruction</option>
                        <option value="script">Script code</option>
                      </select>
                    </label>
                  </div>

                  <label className="mt-3 grid gap-1.5">
                    <span className="text-[11.5px] font-semibold text-ink-secondary">Description</span>
                    <textarea
                      value={tool.description}
                      onChange={(event) => update(tool.id, { description: event.target.value })}
                      rows={2}
                      placeholder="Searches messages and returns the most relevant threads."
                      className="resize-none rounded-[10px] border border-border bg-white px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none focus:border-primary"
                    />
                  </label>

                  {isScript && (
                    <label className="mt-3 grid gap-1.5">
                      <span className="text-[11.5px] font-semibold text-ink-secondary">Script file</span>
                      <div className="flex items-center gap-2">
                        <input
                          value={tool.entry}
                          onChange={(event) => update(tool.id, { entry: event.target.value })}
                          placeholder="search_messages.ts"
                          className="min-w-0 flex-1 rounded-[10px] border border-border bg-white px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-primary"
                        />
                        <button
                          type="button"
                          onClick={() => void onViewScripts(tool)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border border-border-strong bg-white px-3 py-2.5 text-[12px] font-semibold text-ink hover:bg-surface-muted"
                        >
                          <FileCode2 className="size-[14px] text-accent-ink" /> View Scripts
                        </button>
                      </div>
                    </label>
                  )}

                  <label className="mt-3 grid gap-1.5">
                    <span className="text-[11.5px] font-semibold text-ink-secondary">Parameters JSON Schema</span>
                    <textarea
                      value={tool.parametersText}
                      onChange={(event) => update(tool.id, { parametersText: event.target.value })}
                      rows={6}
                      className="resize-none rounded-[10px] border border-border bg-white px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-primary"
                    />
                  </label>
                </div>
              )}
            </article>
          )
        })}
      </div>

      {schemaError && <div className="mt-3 rounded-[10px] bg-amber-100 px-3 py-2 text-[12px] font-medium text-amber-800">{schemaError}</div>}

      <div className="mt-5 flex justify-between">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
          <ArrowLeft className="size-[15px]" /> Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Configure <ArrowRight className="size-[15px]" />
        </button>
      </div>
    </section>
  )
}

function ConfigsColumn({
  definition,
  tools,
  settings,
  saving,
  canSave,
  onEditSettings,
  onBack,
  onSave,
}: {
  definition: SkillDefinition
  tools: DraftTool[]
  settings: DraftSetting[]
  saving: boolean
  canSave: boolean
  onEditSettings: () => void
  onBack: () => void
  onSave: () => void
}) {
  const configCount = settings.filter((setting) => !setting.secret).length
  const secretCount = settings.filter((setting) => setting.secret).length

  return (
    <section className="w-[560px] rounded-[22px] border border-border bg-white/90 p-6 shadow-[0_20px_60px_-34px_rgba(25,25,23,0.34)] backdrop-blur">
      <ColumnEyebrow>CONFIGS</ColumnEyebrow>
      <h2 className="text-[24px] font-bold tracking-tight text-ink">Configurations and secrets</h2>
      <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-ink-secondary">
        These settings come from the skill’s tools. Set config defaults here; secret values are bound per agent when the skill is installed.
      </p>

      <div className="mt-5 rounded-[18px] border border-border bg-surface p-5">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-[11px] bg-accent-soft text-accent-ink">
            <FileText className="size-[18px]" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[16px] font-bold text-ink">{definition.name || 'Untitled skill'}</h3>
            <p className="line-clamp-1 text-[12.5px] text-ink-secondary">{definition.description || 'No description yet.'}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2.5">
          <CountTile icon={<Braces className="size-3.5" />} label="Tools" value={tools.length} />
          <CountTile icon={<KeyRound className="size-3.5" />} label="Configs" value={configCount} />
          <CountTile icon={<Lock className="size-3.5" />} label="Secrets" value={secretCount} />
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <code key={tool.id} className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">{tool.name || 'unnamed_tool'}</code>
          ))}
        </div>

        <button
          type="button"
          onClick={onEditSettings}
          className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-[11px] border border-border-strong bg-white px-4 py-2.5 text-[13px] font-semibold text-ink hover:bg-surface-muted"
        >
          <SlidersHorizontal className="size-[15px] text-accent-ink" /> View &amp; edit settings
        </button>
      </div>

      <div className="mt-5 flex justify-between">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold text-ink-secondary hover:bg-surface-muted">
          <ArrowLeft className="size-[15px]" /> Back
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave || saving}
          className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-[15px] animate-spin" /> : <Save className="size-[15px]" />} Save skill
        </button>
      </div>
    </section>
  )
}

function CountTile({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-[12px] border border-border bg-white px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-ink-tertiary">
        {icon}
        <span className="text-[10.5px] font-medium">{label}</span>
      </div>
      <div className="mt-1 font-mono text-[18px] font-semibold text-ink">{value}</div>
    </div>
  )
}

// Settings editor opened from the Configs step. The skill DECLARES these settings
// (derived from its tools). You can only set defaults for non-secret config here;
// secret VALUES are never stored in the shareable skill — they bind per agent at
// install/test time, so secrets are display-only.
function SettingsPanel({
  settings,
  onSettings,
  onClose,
}: {
  settings: DraftSetting[]
  onSettings: (settings: DraftSetting[]) => void
  onClose: () => void
}) {
  const update = (id: string, patch: Partial<DraftSetting>) => {
    onSettings(settings.map((setting) => (setting.id === id ? { ...setting, ...patch } : setting)))
  }
  const configs = settings.filter((setting) => !setting.secret)
  const secrets = settings.filter((setting) => setting.secret)

  return (
    <FloatingPanel
      title="Settings"
      subtitle={`${configs.length} config · ${secrets.length} secret`}
      icon={<SlidersHorizontal className="size-[16px]" />}
      onClose={onClose}
      width={560}
      height={560}
      minWidth={420}
    >
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <section>
            <div className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-tertiary">
              <KeyRound className="size-3.5" /> CONFIGURATION
            </div>
            {configs.length === 0 ? (
              <p className="text-[12.5px] text-ink-tertiary">No configuration fields.</p>
            ) : (
              <div className="grid gap-2.5">
                {configs.map((setting) => (
                  <div key={setting.id} className="rounded-[13px] border border-border bg-white p-3.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold text-ink">{setting.key || 'unnamed'}</span>
                      <span className="text-[11.5px] text-ink-tertiary">{setting.label}</span>
                      <span className="ml-auto text-[10.5px] text-ink-tertiary">{setting.required === false ? 'Optional' : 'Required'}</span>
                    </div>
                    <label className="mt-2.5 grid gap-1.5">
                      <span className="text-[11px] font-semibold text-ink-secondary">Default value</span>
                      <input
                        value={(setting.default as string) ?? ''}
                        onChange={(event) => update(setting.id, { default: event.target.value })}
                        placeholder={setting.placeholder ?? 'e.g. imap.qq.com'}
                        className="rounded-[9px] border border-border bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-tertiary">
              <Lock className="size-3.5" /> SECRETS
            </div>
            <p className="mb-2.5 text-[11.5px] text-ink-tertiary">Secret values are provided per agent when the skill is installed (and for testing). They’re never stored in the shared skill.</p>
            {secrets.length === 0 ? (
              <p className="text-[12.5px] text-ink-tertiary">No secrets.</p>
            ) : (
              <div className="grid gap-2.5">
                {secrets.map((setting) => (
                  <div key={setting.id} className="flex items-center gap-3 rounded-[13px] border border-border bg-surface p-3.5">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-ink text-white">
                      <Lock className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[13px] font-semibold text-ink">{setting.key || 'unnamed'}</div>
                      <div className="truncate text-[11.5px] text-ink-tertiary">{setting.label}</div>
                    </div>
                    <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-ink-tertiary">bound on install</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
    </FloatingPanel>
  )
}

function ColumnEyebrow({ children }: { children: ReactNode }) {
  return <div className="mb-3 font-mono text-[11px] tracking-[0.16em] text-ink-tertiary">{children}</div>
}

function emptyDefinition(): SkillDefinition {
  return { name: '', description: '', readme: '', category: 'tool' }
}

function draftToolFromSkillTool(tool: SkillToolCall): DraftTool {
  const implementation: ToolImplementation = tool.entry ? 'script' : 'readme'
  return {
    id: uid('tool'),
    name: tool.name,
    description: tool.description,
    implementation,
    entry: tool.entry ?? '',
    parametersText: tool.parameters ? JSON.stringify(tool.parameters, null, 2) : DEFAULT_PARAMETERS,
  }
}

function draftSettingFromSkillSetting(setting: SkillSetting): DraftSetting {
  return { ...setting, id: uid(setting.secret ? 'secret' : 'config') }
}

function newTool(): DraftTool {
  return { id: uid('tool'), name: 'run_skill', description: '', implementation: 'readme', entry: '', parametersText: DEFAULT_PARAMETERS }
}

function toSkillTool(tool: DraftTool): SkillToolCall {
  const parsed = safeParse(tool.parametersText)
  return {
    name: tool.name.trim(),
    description: tool.description.trim(),
    parameters: parsed,
    ...(tool.implementation === 'script' ? { entry: tool.entry.trim() || `${slugify(tool.name) || 'tool'}.ts` } : {}),
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function firstSchemaError(tools: DraftTool[]) {
  for (const tool of tools) {
    try {
      const parsed = JSON.parse(tool.parametersText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${tool.name || 'Tool'} parameters must be a JSON object.`
    } catch {
      return `${tool.name || 'Tool'} has invalid JSON schema.`
    }
  }
  return null
}

function normalizedReadme(definition: SkillDefinition) {
  const readme = definition.readme.trim()
  if (readme) return readme
  return `# ${definition.name.trim()}\n\n${definition.description.trim()}\n`
}

/** Replace the first markdown H1 with the new title (keeps title ↔ skill.md in sync). */
function syncReadmeTitle(readme: string, name: string) {
  if (!readme.trim()) return readme
  const lines = readme.split('\n')
  const idx = lines.findIndex((line) => /^#\s/.test(line.trim()))
  if (idx === -1) return readme
  lines[idx] = `# ${name}`
  return lines.join('\n')
}

function descriptionFromReadme(readme: string, fallback: string) {
  const lines = readme
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#') && !line.startsWith('-'))
  const candidate = lines.find((line) => !line.toLowerCase().startsWith('use this skill when')) ?? lines[0]
  return candidate ?? fallback
}

function functionName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/_{2,}/g, '_').replace(/^([0-9])/, '_$1')
}

function slugify(value: string) {
  return functionName(value).toLowerCase().replace(/^_+|_+$/g, '')
}

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
