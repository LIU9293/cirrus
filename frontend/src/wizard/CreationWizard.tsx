import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Check,
  X,
  Database,
  Wand2,
  Loader2,
  Link2,
  Upload,
  RefreshCw,
  Boxes,
  Globe,
  Clock,
  Share2,
  Play,
  Snowflake,
  Layout,
  MessageCircle,
  Code2,
  Send,
  Plus,
} from 'lucide-react'
import type {
  CreationPhase,
  MiniappDraft,
  MiniappRecord,
  MiniappSkill,
  SkillCategory,
  SkillDevelopMethod,
  SkillToolCall,
} from '@shared/protocol'
import { MiniappCanvas, type MiniappCanvasHandle } from '@/canvas/MiniappCanvas'
import {
  planSkills as apiPlanSkills,
  developSkill as apiDevelopSkill,
  loadDataset as apiLoadDataset,
  clarifyConcept as apiClarify,
  saveSkillCredentials as apiSaveCredentials,
  testSkillTool as apiTestTool,
  getAgentFile as apiGetAgentFile,
  putAgentFile as apiPutAgentFile,
  runTool as apiRunTool,
  refineAgentFile as apiRefineFile,
  saveFlow,
  type ChatTurn,
} from '@/lib/api'
import type { UiMessage } from '@/chat/ChatPanel'
import { cn } from '@/lib/utils'

const CATEGORY_ICON: Record<SkillCategory, React.ReactNode> = {
  data: <Database className="size-4" />,
  tool: <Boxes className="size-4" />,
  connector: <Globe className="size-4" />,
  trigger: <Clock className="size-4" />,
  ai: <Sparkles className="size-4" />,
}

const METHOD_META: Record<SkillDevelopMethod, { label: string; icon: React.ReactNode }> = {
  generate: { label: 'AI generate', icon: <Wand2 className="size-3.5" /> },
  integrate: { label: 'Connect API', icon: <Link2 className="size-3.5" /> },
  upload: { label: 'Upload data', icon: <Upload className="size-3.5" /> },
}

// Per-app configuration a skill instance can carry, keyed by platform skill id
// (or '__integration' for connected services). Skills not listed need no config.
type ConfigField = { key: string; label: string; placeholder: string; multiline?: boolean }
const SKILL_CONFIG_FIELDS: Record<string, ConfigField[]> = {
  http_request: [
    { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' },
    { key: 'authHeader', label: 'Auth header (optional)', placeholder: 'Bearer …' },
  ],
  notify: [{ key: 'target', label: 'Recipient / channel', placeholder: 'you@example.com or #standup' }],
  schedule: [{ key: 'frequency', label: 'Frequency', placeholder: 'every weekday at 09:00' }],
  webhook: [{ key: 'event', label: 'Event name', placeholder: 'order.created' }],
  __integration: [
    { key: 'endpoint', label: 'Endpoint', placeholder: 'https://…' },
    { key: 'auth', label: 'Auth (optional)', placeholder: 'token / header' },
  ],
}

function configFieldsOf(skill: MiniappSkill): ConfigField[] {
  const key = skill.source === 'integration' ? '__integration' : skill.platformSkillId ?? ''
  return SKILL_CONFIG_FIELDS[key] ?? []
}

function skillSourceLabel(skill: MiniappSkill): string {
  if (skill.source === 'generated') return 'AI-generated for this app'
  if (skill.source === 'integration') return 'Connected service · this app'
  return "From the platform library · this app's instance"
}

const PHASES: { key: CreationPhase; label: string }[] = [
  { key: 'define', label: 'Define' },
  { key: 'skills', label: 'Skills' },
  { key: 'surface', label: 'Surface' },
  { key: 'publish', label: 'Publish' },
]

export interface WizardFlowUpdate {
  creationPhase?: CreationPhase
  draft?: Partial<MiniappDraft>
  skills?: MiniappSkill[]
  defineMessages?: MiniappRecord['defineMessages']
}

interface Props {
  miniapp: MiniappRecord
  streaming: boolean
  messages: UiMessage[]
  canvasRef: React.Ref<MiniappCanvasHandle>
  onBuild: (text: string) => void
  onState: (state: Record<string, unknown>, version: number) => void
  onUpdateFlow: (partial: WizardFlowUpdate) => void
  onFreeze: () => void
}


export function CreationWizard({
  miniapp,
  streaming,
  messages,
  canvasRef,
  onBuild,
  onState,
  onUpdateFlow,
  onFreeze,
}: Props) {
  const phase = (miniapp.creationPhase ?? 'define') as CreationPhase
  const activeIndex = Math.max(0, PHASES.findIndex((p) => p.key === phase))

  const goTo = (key: CreationPhase) => onUpdateFlow({ creationPhase: key })
  const advance = (partial?: WizardFlowUpdate) => {
    const next = PHASES[Math.min(PHASES.length - 1, activeIndex + 1)].key
    onUpdateFlow({ ...partial, creationPhase: next })
  }
  const back = () => goTo(PHASES[Math.max(0, activeIndex - 1)].key)

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-border px-6 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="text-sm font-bold">T</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">Cirrus Studio</span>
        </div>
        <Stepper activeIndex={activeIndex} />
        <div className="flex justify-end">
          <button
            onClick={() => goTo('done')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" /> Exit to studio
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {phase === 'define' && <DefineStep miniapp={miniapp} onContinue={(draft) => advance({ draft })} />}
        {phase === 'skills' && (
          <SkillsStep miniapp={miniapp} onBack={back} onContinue={(skills) => advance({ skills })} />
        )}
        {phase === 'surface' && (
          <SurfaceStep
            miniapp={miniapp}
            streaming={streaming}
            messages={messages}
            canvasRef={canvasRef}
            onBuild={onBuild}
            onState={onState}
            onBack={back}
            onContinue={() => advance()}
          />
        )}
        {phase === 'publish' && (
          <PublishStep miniapp={miniapp} onBack={back} onFreeze={onFreeze} onFinish={() => goTo('done')} />
        )}
      </div>
    </div>
  )
}

function Stepper({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex items-center justify-center">
      {PHASES.map((p, i) => {
        const done = i < activeIndex
        const active = i === activeIndex
        return (
          <div key={p.key} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-[11px] font-medium',
                  done
                    ? 'bg-primary text-primary-foreground'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-secondary text-muted-foreground',
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </div>
              <span className={cn('text-[13px]', active ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                {p.label}
              </span>
            </div>
            {i < PHASES.length - 1 && <div className="mx-3 h-px w-8 bg-border" />}
          </div>
        )
      })}
    </div>
  )
}

function StepShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-xl flex-col">{children}</div>
    </div>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 font-mono text-[11px] tracking-widest text-muted-foreground">{children}</div>
}

function DefineStep({ miniapp, onContinue }: { miniapp: MiniappRecord; onContinue: (d: MiniappDraft) => void }) {
  const seeded = !!(miniapp.draft?.goal ?? miniapp.manifest?.description)
  const [thread, setThread] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [concept, setConcept] = useState<{ name: string; goal: string } | null>(
    seeded ? { name: miniapp.draft?.name ?? miniapp.manifest?.name ?? '', goal: miniapp.draft?.goal ?? miniapp.manifest?.description ?? '' } : null,
  )

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    const history: ChatTurn[] = [...thread, { role: 'user', content: text }]
    setThread(history)
    setInput('')
    setBusy(true)
    try {
      const r = await apiClarify(miniapp.id, history)
      if (r.ready) {
        setConcept({ name: r.name ?? '', goal: r.goal ?? '' })
        setThread((t) => [...t, { role: 'assistant', content: `想清楚了 ✦ ${r.name}：${r.goal}` }])
      } else {
        setThread((t) => [...t, { role: 'assistant', content: r.question ?? '再多说一点？' }])
      }
    } catch {
      setThread((t) => [...t, { role: 'assistant', content: '出错了，再试一次？' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <StepShell>
      <Eyebrow>STEP 01 · IDENTITY</Eyebrow>
      <h1 className="text-2xl font-semibold tracking-tight">What do you want to build?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Describe your idea. The agent asks a few questions until it has a complete, buildable concept.
      </p>

      {thread.length > 0 && (
        <div className="mt-6 flex flex-col gap-3">
          {thread.map((m, i) => (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border border-border bg-card',
                )}
              >
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> working...
            </div>
          )}
        </div>
      )}

      {concept && (
        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          <div className="font-mono text-[10px] tracking-widest text-emerald-600">CONCEPT READY</div>
          <input
            value={concept.name}
            onChange={(e) => setConcept({ ...concept, name: e.target.value })}
            className="mt-1.5 w-full bg-transparent text-lg font-semibold tracking-tight outline-none"
          />
          <textarea
            value={concept.goal}
            onChange={(e) => setConcept({ ...concept, goal: e.target.value })}
            rows={3}
            className="mt-1 w-full resize-none bg-transparent text-sm leading-relaxed text-muted-foreground outline-none"
          />
        </div>
      )}

      <div className="mt-5 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder={thread.length ? 'Answer, or refine…' : 'e.g. 帮我每小时清理 Gmail，分类邮件并做个看板…'}
          className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:border-primary"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          <Send className="size-4" />
        </button>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          disabled={!concept || !concept.name.trim() || !concept.goal.trim()}
          onClick={() => concept && onContinue({ name: concept.name.trim(), goal: concept.goal.trim() })}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Build the plan <ArrowRight className="size-4" />
        </button>
      </div>
    </StepShell>
  )
}

function suggestedMethodsOf(s: MiniappSkill): SkillDevelopMethod[] {
  const fromConfig = s.config?.suggestedMethods as SkillDevelopMethod[] | undefined
  return fromConfig && fromConfig.length ? fromConfig : ['generate', 'integrate']
}

function SkillsStep({
  miniapp,
  onBack,
  onContinue,
}: {
  miniapp: MiniappRecord
  onBack: () => void
  onContinue: (skills: MiniappSkill[]) => void
}) {
  const [skills, setSkills] = useState<MiniappSkill[]>(miniapp.skills ?? [])
  const [planning, setPlanning] = useState(false)
  const [planned, setPlanned] = useState((miniapp.skills ?? []).length > 0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('agentReadme')
  const [refreshNonce, setRefreshNonce] = useState(0)

  const runPlan = async () => {
    setPlanning(true)
    setError(null)
    try {
      const res = await apiPlanSkills(miniapp.id)
      setSkills(res.skills)
      setPlanned(true)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setPlanning(false)
    }
  }

  // Auto-plan once when entering the step with a goal but no skills yet.
  useEffect(() => {
    if (!planned && !planning && (miniapp.draft?.goal || miniapp.manifest?.description)) void runPlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persist = (next: MiniappSkill[]) => {
    setSkills(next)
    void saveFlow(miniapp.id, { skills: next }).catch(() => {})
  }
  const update = (id: string, partial: Partial<MiniappSkill>) =>
    persist(
      skills.map((s) =>
        s.id === id ? { ...s, ...partial, config: partial.config ? { ...s.config, ...partial.config } : s.config } : s,
      ),
    )
  const remove = (id: string) => persist(skills.filter((s) => s.id !== id))
  const addSkill = (name: string) => {
    const id = 'sk-' + Math.random().toString(36).slice(2, 8)
    const skill: MiniappSkill = {
      id,
      name,
      category: 'tool',
      description: '',
      source: 'generated',
      kind: 'custom',
      status: 'needs_dev',
      tools: [],
      credentials: [],
      config: { suggestedMethods: ['generate', 'integrate'] },
    }
    persist([...skills, skill])
    setSelected(id)
  }

  const develop = async (skill: MiniappSkill, method: SkillDevelopMethod, input?: Record<string, unknown>) => {
    setBusyId(skill.id)
    setError(null)
    setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, status: 'building' } : s)))
    try {
      const res = await apiDevelopSkill(miniapp.id, skill.id, method, input ?? {})
      if (res.skill) setSkills((prev) => prev.map((s) => (s.id === skill.id ? res.skill! : s)))
      if (!res.ok) setError(res.message)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      setSkills((prev) => prev.map((s) => (s.id === skill.id ? { ...s, status: 'needs_dev' } : s)))
    } finally {
      setBusyId(null)
    }
  }

  const todo = skills.filter((s) => s.status !== 'active')
  const selectedSkill = skills.find((s) => s.id === selected) ?? null
  const filePath =
    selected === 'agentReadme'
      ? 'agent.md'
      : selectedSkill?.config?.file
        ? String(selectedSkill.config.file)
        : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <div className="font-mono text-[11px] tracking-widest text-muted-foreground">STEP 02 · CAPABILITIES</div>
          <div className="text-base font-semibold tracking-tight">Build the agent's capabilities</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={runPlan}
            disabled={planning}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
          >
            {planning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Re-plan
          </button>
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            <ArrowLeft className="size-4" /> Back
          </button>
          <button
            onClick={() => onContinue(skills)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Continue{todo.length ? ' anyway' : ''} <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[256px_minmax(0,1fr)_340px]">
        <WorkspaceTree
          miniapp={miniapp}
          skills={skills}
          planning={planning}
          selected={selected}
          onSelect={setSelected}
          onPlan={runPlan}
          onAdd={addSkill}
        />
        <div className="min-h-0 overflow-y-auto border-x border-border">
          <CapabilityDetail
            key={selected + ':' + refreshNonce}
            selected={selected}
            skill={selectedSkill}
            appId={miniapp.id}
            filePath={filePath}
            busy={busyId === selectedSkill?.id}
            onUpdate={(p) => selectedSkill && update(selectedSkill.id, p)}
            onRemove={() => {
              if (selectedSkill) {
                remove(selectedSkill.id)
                setSelected('agentReadme')
              }
            }}
            onDevelop={(m, input) => selectedSkill && develop(selectedSkill, m, input)}
          />
        </div>
        <RefinePane appId={miniapp.id} filePath={filePath} label={selected} onRefined={() => setRefreshNonce((n) => n + 1)} />
      </div>

      {error && <div className="border-t border-border px-6 py-2 text-xs text-destructive">{error}</div>}
    </div>
  )
}

function WorkspaceTree({
  miniapp,
  skills,
  planning,
  selected,
  onSelect,
  onPlan,
  onAdd,
}: {
  miniapp: MiniappRecord
  skills: MiniappSkill[]
  planning: boolean
  selected: string
  onSelect: (id: string) => void
  onPlan: () => void
  onAdd: (name: string) => void
}) {
  const name = miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Agent'
  const Row = ({ id, icon, label, meta, badge }: { id: string; icon: React.ReactNode; label: string; meta?: string; badge?: React.ReactNode }) => (
    <button
      onClick={() => onSelect(id)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
        selected === id ? 'bg-accent-soft' : 'hover:bg-secondary',
      )}
    >
      <span className={cn(selected === id ? 'text-accent-ink' : 'text-muted-foreground')}>{icon}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', selected === id ? 'font-semibold text-accent-ink' : 'text-foreground')}>
        {label}
      </span>
      {badge}
      {meta && <span className="font-mono text-[9px] text-muted-foreground">{meta}</span>}
    </button>
  )
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{name}</div>
          <div className="font-mono text-[10px] text-muted-foreground">agent/ · {skills.length + 1} capabilities</div>
        </div>
      </div>
      <div className="flex flex-col gap-0.5 p-2">
        <div className="px-2 pb-1 pt-1 font-mono text-[9px] tracking-widest text-muted-foreground">AGENT</div>
        <Row id="agentReadme" icon={<Sparkles className="size-3.5" />} label="agent.md" />

        {planning && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> planning…
          </div>
        )}

        {([
          { label: 'SKILLS', items: skills.filter((s) => s.category !== 'trigger') },
          { label: 'TRIGGERS', items: skills.filter((s) => s.category === 'trigger') },
        ] as const).map((sec) =>
          sec.items.length ? (
            <div key={sec.label} className="mt-1.5">
              <div className="px-2 pb-1 font-mono text-[9px] tracking-widest text-muted-foreground">{sec.label}</div>
              {sec.items.map((s) => (
                <Row
                  key={s.id}
                  id={s.id}
                  icon={CATEGORY_ICON[s.category]}
                  label={s.name}
                  badge={
                    s.status !== 'active' || skillNeedsCredentials(s) ? (
                      <span className="size-1.5 rounded-full bg-amber-500" />
                    ) : (
                      <Check className="size-3 text-emerald-600" />
                    )
                  }
                  meta={s.kind === 'builtin' || s.source === 'library' ? 'lib' : undefined}
                />
              ))}
            </div>
          ) : null,
        )}

        <div className="mt-1.5 px-2 pb-1 font-mono text-[9px] tracking-widest text-muted-foreground">SURFACES · optional</div>
        {[
          { id: 'miniapp', label: 'miniapp', icon: <Layout className="size-3.5" /> },
          { id: 'bot', label: 'bot', icon: <MessageCircle className="size-3.5" /> },
          { id: 'api', label: 'api', icon: <Share2 className="size-3.5" /> },
        ].map((c) => (
          <Row key={c.id} id={'surface:' + c.id} icon={c.icon} label={c.label} />
        ))}

        <button
          onClick={() => {
            const name = window.prompt('New skill name (you build it next with AI):')?.trim()
            if (name) onAdd(name)
          }}
          className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          <Plus className="size-3.5" /> Add a skill
        </button>
        <button
          onClick={onPlan}
          className="mt-1.5 inline-flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          <Sparkles className="size-3.5" /> Re-plan capabilities
        </button>
      </div>
    </div>
  )
}

function DetailHeader({ icon, path, badge }: { icon: React.ReactNode; path: string; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-6 py-3.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-mono text-sm text-foreground">{path}</span>
      {badge}
    </div>
  )
}

function CapabilityDetail({
  selected,
  skill,
  appId,
  filePath,
  busy,
  onUpdate,
  onRemove,
  onDevelop,
}: {
  selected: string
  skill: MiniappSkill | null
  appId: string
  filePath: string | null
  busy: boolean
  onUpdate: (p: Partial<MiniappSkill>) => void
  onRemove: () => void
  onDevelop: (m: SkillDevelopMethod, input?: Record<string, unknown>) => void
}) {
  if (selected === 'agentReadme') return <AgentReadmeDetail appId={appId} />
  if (selected.startsWith('surface:')) return <SurfaceDetail name={selected.slice(8)} />
  if (!skill) return <div className="p-8 text-sm text-muted-foreground">Select a capability.</div>

  const isData = skill.platformSkillId === 'dataset_library' || skill.platformSkillId === 'database'
  return (
    <div className="flex min-h-0 flex-col">
      <DetailHeader
        icon={CATEGORY_ICON[skill.category]}
        path={filePath ?? `${skill.category}/${skill.name}`}
        badge={
          <span className="rounded bg-secondary px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
            {skill.source === 'library' ? skill.platformSkillId ?? 'library' : skill.source}
            {filePath ? ' · file' : ''}
          </span>
        }
      />
      <div className="flex flex-col gap-5 p-6">
        <div>
          <div className="text-lg font-semibold tracking-tight">{skill.name}</div>
          {skill.description && <div className="mt-1 text-sm text-muted-foreground">{skill.description}</div>}
        </div>

        {skill.status !== 'active' && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50/50 p-3">
            <span className="text-xs font-medium text-amber-700">Not built yet — how should we make it?</span>
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> working...
              </span>
            ) : (
              suggestedMethodsOf(skill).map((m, i) => (
                <button
                  key={m}
                  onClick={() => onDevelop(m)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                    i === 0 ? 'bg-primary text-primary-foreground hover:opacity-90' : 'border border-border hover:bg-secondary',
                  )}
                >
                  {METHOD_META[m].icon} {METHOD_META[m].label}
                </button>
              ))
            )}
          </div>
        )}

        {!!skill.credentials?.length && <CredentialsPanel appId={appId} skill={skill} onUpdate={onUpdate} />}

        {!!skill.tools?.length && <ToolCallsList appId={appId} skill={skill} />}

        {isData && <DatasetLoader appId={appId} skill={skill} onUpdate={onUpdate} />}

        {filePath && <ToolDetail appId={appId} path={filePath} />}

        {!filePath && !isData && !skill.tools?.length && !skill.credentials?.length && skill.status === 'active' && (
          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            This capability is configured above. Refine it with AI on the right →
          </div>
        )}

        <button onClick={onRemove} className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-destructive hover:underline">
          <X className="size-3.5" /> Remove capability
        </button>
      </div>
    </div>
  )
}

function AgentReadmeDetail({ appId }: { appId: string }) {
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    void apiGetAgentFile(appId, 'agent.md')
      .catch(() => apiGetAgentFile(appId, 'soul.md'))
      .catch(() => apiGetAgentFile(appId, 'instructions.md'))
      .then((c) => {
        setText(c)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [appId])
  return (
    <div className="flex min-h-0 flex-col">
      <DetailHeader icon={<Sparkles className="size-4" />} path="agent.md" badge={<span className="rounded bg-secondary px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">AGENT</span>} />
      <div className="flex flex-col gap-3 p-6">
        <div className="text-sm text-muted-foreground">What the agent is and does — seeded from Define, fully editable. The runtime loads it as the agent's system prompt.</div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setSaved(false)
          }}
          disabled={!loaded}
          rows={14}
          className="w-full resize-none rounded-lg border border-border bg-card p-3.5 font-mono text-[13px] leading-relaxed outline-none focus:border-primary"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => apiPutAgentFile(appId, 'agent.md', text).then(() => setSaved(true))}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Check className="size-4" /> Save
          </button>
          {saved && <span className="text-xs text-emerald-600">Saved</span>}
          <span className="text-xs text-muted-foreground">— or refine it with AI on the right →</span>
        </div>
      </div>
    </div>
  )
}

function ToolDetail({ appId, path }: { appId: string; path: string }) {
  const [code, setCode] = useState('')
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState<{ ok: boolean; stdout: string; error?: string } | null>(null)
  useEffect(() => {
    void apiGetAgentFile(appId, path).then(setCode).catch(() => setCode('// (could not load)'))
  }, [appId, path])
  const run = async () => {
    setRunning(true)
    setOut(null)
    try {
      const r = await apiRunTool(appId, path)
      setOut({ ok: r.ok, stdout: r.stdout, error: r.error })
    } finally {
      setRunning(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] tracking-widest text-muted-foreground">SOURCE · runs in the sandbox</div>
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Test run
        </button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-sunken p-3.5 font-mono text-[12px] leading-relaxed">
        {code}
      </pre>
      {out && (
        <div className={cn('rounded-lg border p-3 font-mono text-[11px] leading-relaxed', out.ok ? 'border-emerald-300/60 bg-emerald-50/50' : 'border-amber-300/60 bg-amber-50/50')}>
          <div className="mb-1 text-[10px] tracking-widest text-muted-foreground">{out.ok ? 'OUTPUT' : 'ERROR'}</div>
          {(out.ok ? out.stdout : out.error || out.stdout || 'failed').slice(0, 1200)}
        </div>
      )}
    </div>
  )
}

function SurfaceDetail({ name }: { name: string }) {
  const desc: Record<string, string> = {
    miniapp: 'The visual surface — the React app rendered in the sandboxed iframe. Optional; the agent works headless too.',
    bot: 'A bot connector — users talk to the agent in chat; it answers using its skills.',
    api: 'Call the agent like an API: POST /v1/agents/<id>/run.',
  }
  return (
    <div className="flex min-h-0 flex-col">
      <DetailHeader icon={<Share2 className="size-4" />} path={`surfaces/${name}`} badge={<span className="rounded bg-secondary px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">SURFACE · OPTIONAL</span>} />
      <div className="p-6">
        <div className="text-lg font-semibold capitalize tracking-tight">{name}</div>
        <div className="mt-1 text-sm text-muted-foreground">{desc[name] ?? ''}</div>
      </div>
    </div>
  )
}

function RefinePane({ appId, filePath, label, onRefined }: { appId: string; filePath: string | null; label: string; onRefined: () => void }) {
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setThread([])
  }, [filePath])

  const send = async () => {
    const text = input.trim()
    if (!text || busy || !filePath) return
    setThread((t) => [...t, { role: 'user', content: text }])
    setInput('')
    setBusy(true)
    try {
      const r = await apiRefineFile(appId, filePath, text)
      setThread((t) => [...t, { role: 'assistant', content: r.message + (r.test && !r.ok ? '' : '') }])
      if (r.ok) onRefined()
    } catch (e) {
      setThread((t) => [...t, { role: 'assistant', content: String((e as Error)?.message ?? e) }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col bg-card">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-semibold">Refine with AI</span>
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {filePath ? `edits ${filePath}` : 'select agent.md or a skill file to refine'}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {thread.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed', m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border border-border bg-background')}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> editing the file…
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
          disabled={!filePath}
          placeholder={filePath ? 'Tell the agent how to improve it…' : 'not editable'}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim() || !filePath}
          aria-label="Send refinement"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          <Send className="size-4" />
        </button>
      </div>
    </div>
  )
}


/** True when a skill declares credentials that aren't all filled yet. */
function skillNeedsCredentials(skill: MiniappSkill): boolean {
  const fields = skill.credentials ?? []
  if (!fields.length) return false
  const filled = new Set(skill.credentialsFilled ?? [])
  return !fields.filter((f) => f.required !== false).every((f) => filled.has(f.key))
}

/** Configure a skill's declared credentials. Secret values go to the agent folder. */
function CredentialsPanel({
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
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await apiSaveCredentials(appId, skill.id, values)
      if (r.ok) {
        onUpdate({ credentialsFilled: r.credentialsFilled })
        setEditing(false)
        setValues({})
      } else setErr('Save failed')
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  if (allFilled && !editing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50/50 px-3 py-2.5 text-xs">
        <Check className="size-3.5 text-emerald-600" />
        <span className="text-emerald-700">Credentials configured ({filledKeys.join(', ')}) — stored in this app's agent folder.</span>
        <button onClick={() => setEditing(true)} className="ml-auto text-muted-foreground hover:text-foreground">
          update
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-amber-300/70 bg-amber-50/50 p-3.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
        <Link2 className="size-3.5" /> Configure credentials — you authorize on this page; secrets stay in the app's agent folder
      </div>
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-foreground">
            {f.label}
            {f.required === false && <span className="ml-1.5 text-muted-foreground">optional</span>}
            {filledKeys.includes(f.key) && <span className="ml-1.5 text-emerald-600">✓ set</span>}
          </span>
          {f.type === 'select' ? (
            <select
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
            >
              <option value="">{f.placeholder ?? 'Select...'}</option>
              {(f.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder ?? (filledKeys.includes(f.key) ? 'Leave blank to keep current value' : '')}
              className="min-h-[84px] resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
            />
          ) : (
            <input
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              type={f.secret || f.type === 'password' ? 'password' : 'text'}
              placeholder={f.placeholder ?? (filledKeys.includes(f.key) ? '•••••• (leave blank to keep)' : '')}
              className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary"
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !fields.some((f) => (values[f.key] ?? '').trim())}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save credentials
        </button>
        {allFilled && (
          <button onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground">
            cancel
          </button>
        )}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </div>
  )
}

/** The tool calls a skill exposes to the agent, each testable in isolation. */
function ToolCallsList({ appId, skill }: { appId: string; skill: MiniappSkill }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="font-mono text-[10px] tracking-widest text-muted-foreground">
        TOOL CALLS · the pi-agent calls these (standard contract)
      </div>
      {(skill.tools ?? []).length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          No tool calls yet — this skill is a trigger/surface, or still being built.
        </div>
      )}
      {(skill.tools ?? []).map((t) => (
        <ToolCallRow key={t.name} appId={appId} skillId={skill.id} tool={t} />
      ))}
    </div>
  )
}

function ToolCallRow({ appId, skillId, tool }: { appId: string; skillId: string; tool: SkillToolCall }) {
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState<{ ok: boolean; result?: unknown; error?: string } | null>(null)
  const params = ((tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}
  const run = async () => {
    setRunning(true)
    setOut(null)
    try {
      setOut(await apiTestTool(appId, skillId, tool.name))
    } catch (e) {
      setOut({ ok: false, error: String((e as Error)?.message ?? e) })
    } finally {
      setRunning(false)
    }
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Code2 className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[13px] font-semibold">{tool.name}</span>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          {tool.builtin ? 'built-in' : tool.entry ? 'script' : 'tool'}
        </span>
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-secondary disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />} Test
        </button>
      </div>
      {tool.description && <div className="mt-1 text-xs text-muted-foreground">{tool.description}</div>}
      {!!Object.keys(params).length && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Object.keys(params).map((k) => (
            <span key={k} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {k}
            </span>
          ))}
        </div>
      )}
      {out && (
        <div
          className={cn(
            'mt-2 max-h-40 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed',
            out.ok ? 'border-emerald-300/60 bg-emerald-50/50' : 'border-amber-300/60 bg-amber-50/50',
          )}
        >
          <div className="mb-1 text-[9px] tracking-widest text-muted-foreground">{out.ok ? 'RESULT' : 'ERROR'}</div>
          {(out.ok ? JSON.stringify(out.result, null, 2) : out.error || 'failed')?.slice(0, 1500)}
        </div>
      )}
    </div>
  )
}

function DatasetLoader({
  appId,
  skill,
  onUpdate,
}: {
  appId: string
  skill: MiniappSkill
  onUpdate: (partial: Partial<MiniappSkill>) => void
}) {
  const [format, setFormat] = useState<'json' | 'csv'>('csv')
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const loadedTable = skill.config?.table as string | undefined
  const loadedRows = skill.config?.rowCount as number | undefined
  const schema = (skill.config?.schema as { name: string }[] | undefined)?.map((c) => c.name).join(', ')

  const load = async () => {
    if (!text.trim()) return
    setLoading(true)
    setErr(null)
    setMsg(null)
    try {
      const res = await apiLoadDataset(appId, { skillId: skill.id, format, text })
      if (res.ok) {
        setMsg(res.message)
        onUpdate({ status: 'active', source: 'library', config: { table: res.table, rowCount: res.rowCount, schema: res.columns } })
        setText('')
      } else setErr(res.message)
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-[11px] font-medium text-muted-foreground">DATASET (this app's datastore)</label>
      {loadedTable && (
        <div className="flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <Database className="size-3.5" />
          <span className="font-mono">
            {loadedTable} · {loadedRows ?? 0} rows{schema ? ` · ${schema}` : ''}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md bg-secondary p-0.5">
          {(['csv', 'json'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={cn('rounded px-2.5 py-1 text-xs font-medium uppercase', format === f ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">paste {format === 'csv' ? 'CSV (with a header row)' : 'a JSON array of objects'}</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={format === 'csv' ? 'word,meaning,deck\nubiquitous,无处不在的,GRE' : '[{"word":"ubiquitous","meaning":"无处不在的","deck":"GRE"}]'}
        className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={load}
          disabled={loading || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Load into datastore
        </button>
        {msg && <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><Check className="size-3.5" /> {msg}</span>}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground">CSV / Excel file upload & private-API import coming next — same pipeline, this is the paste path.</p>
    </div>
  )
}

function buildPrompt(miniapp: MiniappRecord): string {
  const name = miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Untitled miniapp'
  const goal = miniapp.draft?.goal ?? ''
  const skills = miniapp.skills ?? []
  const lines = [`Build a miniapp called "${name}".`, goal ? `Goal: ${goal}` : '']
  if (skills.length) {
    lines.push('', 'Skills / data sources to wire in:')
    for (const s of skills) {
      if (s.source === 'library') {
        lines.push(`- ${s.name} (platform skill: ${s.platformSkillId ?? s.category}) — use this built-in capability.`)
      } else if (s.source === 'integration') {
        lines.push(`- ${s.name} (${s.category} integration) — call the connected service.`)
      } else {
        lines.push(`- ${s.name} (generated ${s.category} skill) — include a representative dataset/logic and an agent action for this.`)
      }
    }
  }
  lines.push('', 'Follow the miniapp spec. Make it polished and build it into the canvas.')
  return lines.filter((l) => l !== undefined).join('\n')
}

function SurfaceStep({
  miniapp,
  streaming,
  messages,
  canvasRef,
  onBuild,
  onState,
  onBack,
  onContinue,
}: {
  miniapp: MiniappRecord
  streaming: boolean
  messages: UiMessage[]
  canvasRef: React.Ref<MiniappCanvasHandle>
  onBuild: (text: string) => void
  onState: (state: Record<string, unknown>, version: number) => void
  onBack: () => void
  onContinue: () => void
}) {
  const [refine, setRefine] = useState('')
  const prompt = useMemo(() => buildPrompt(miniapp), [miniapp])
  const built = !!miniapp.html
  const lastActivity = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    return last?.activities?.at(-1)?.text
  }, [messages])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <div className="font-mono text-[11px] tracking-widest text-muted-foreground">STEP 03 · SURFACE</div>
          <div className="text-base font-semibold tracking-tight">Build the canvas</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            <ArrowLeft className="size-4" /> Back
          </button>
          <button
            disabled={!built}
            onClick={onContinue}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            Continue <ArrowRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-border p-5">
          {!built ? (
            <>
              <p className="text-sm text-muted-foreground">
                Generate the first version from everything you defined. You can refine it afterwards.
              </p>
              <pre className="whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {prompt}
              </pre>
              <button
                disabled={streaming}
                onClick={() => onBuild(prompt)}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                <Sparkles className="size-4" /> {streaming ? 'Generating…' : 'Generate the app'}
              </button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Refine the canvas in plain language — the developer agent rebuilds it.
            </p>
          )}

          {streaming && lastActivity && (
            <div className="flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-2 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 animate-pulse" />
              <span className="truncate">{lastActivity}</span>
            </div>
          )}

          {built && (
            <div className="mt-auto flex items-end gap-2">
              <textarea
                value={refine}
                onChange={(e) => setRefine(e.target.value)}
                rows={2}
                placeholder="把按钮换成更醒目的颜色…"
                className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <button
                disabled={streaming || !refine.trim()}
                onClick={() => {
                  onBuild(refine.trim())
                  setRefine('')
                }}
                aria-label="Send refinement"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <Send className="size-4" />
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0">
          <MiniappCanvas
            ref={canvasRef}
            miniapp={miniapp}
            onState={onState}
            canSelectElements={false}
            selectingElement={false}
            selectedElement={null}
            onToggleElementSelect={() => {}}
            onElementSelected={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

function PublishStep({
  miniapp,
  onBack,
  onFreeze,
  onFinish,
}: {
  miniapp: MiniappRecord
  onBack: () => void
  onFreeze: () => void
  onFinish: () => void
}) {
  const name = miniapp.draft?.name ?? miniapp.manifest?.name ?? 'Untitled'
  const handle = '@' + (miniapp.manifest?.id ?? miniapp.id).replace(/^app-/, '')
  const skills = miniapp.skills ?? []
  const endpoints = [
    { icon: <MessageCircle className="size-4" />, k: 'CHAT', v: `terr.app/${handle}` },
    { icon: <Layout className="size-4" />, k: 'CANVAS', v: miniapp.html ? `terr.app/${miniapp.id}/canvas` : 'headless — no surface' },
    { icon: <Code2 className="size-4" />, k: 'API', v: `POST /v1/agents/${miniapp.id}/run` },
  ]
  return (
    <StepShell>
      <Eyebrow>STEP 04 · PUBLISH</Eyebrow>
      <h1 className="text-2xl font-semibold tracking-tight">Review &amp; publish</h1>
      <p className="mt-2 text-sm text-muted-foreground">Freeze the source to lock it in. The app stays usable in the studio.</p>

      <div className="mt-6 rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold tracking-tight">{name}</div>
            <div className="font-mono text-xs text-muted-foreground">{handle}</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Stat label="SKILLS" value={String(skills.length)} />
          <Stat label="SURFACE" value={miniapp.html ? 'Canvas' : 'Headless'} />
          <Stat label="STATUS" value={miniapp.frozen ? 'Frozen' : miniapp.html ? 'Ready' : 'Draft'} />
        </div>
      </div>

      <div className="mt-5 font-mono text-[11px] tracking-widest text-muted-foreground">REACHABLE AT</div>
      <div className="mt-2 flex flex-col gap-2">
        {endpoints.map((e) => (
          <div key={e.k} className="flex items-center gap-3 rounded-lg bg-secondary/50 px-3 py-2.5">
            <span className="text-muted-foreground">{e.icon}</span>
            <span className="w-16 font-mono text-[10px] tracking-wide text-muted-foreground">{e.k}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.v}</span>
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary"
        >
          <ArrowLeft className="size-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onFreeze}
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium',
              miniapp.frozen
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-secondary',
            )}
          >
            <Snowflake className="size-4" /> {miniapp.frozen ? 'Frozen' : 'Freeze'}
          </button>
          <button
            onClick={onFinish}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Check className="size-4" /> Finish
          </button>
        </div>
      </div>
    </StepShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <div className="font-mono text-[10px] tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  )
}
