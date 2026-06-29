import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Code2,
  Database,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Plus,
  Server,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react'
import type { MiniappRecord, PlatformSkill, SkillCategory, SkillRecord } from '@shared/protocol'
import {
  deleteSkill as apiDeleteSkill,
  installSkillOnAgent,
  listCommunitySkills,
  listMySkills,
  listSkillLibrary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const PAGE_CONTAINER_CLASS =
  'relative z-10 mx-auto w-full max-w-[1080px] px-4 pb-16 pt-[92px] sm:px-6 sm:pb-20 sm:pt-[112px] lg:px-10 lg:pt-[116px]'
const PAGE_GRID_CLASS = 'mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3'

const CATEGORY_ICON: Record<SkillCategory, ReactNode> = {
  connector: <Globe className="size-[17px]" />,
  data: <Database className="size-[17px]" />,
  trigger: <Server className="size-[17px]" />,
  tool: <Wrench className="size-[17px]" />,
  ai: <Sparkles className="size-[17px]" />,
}

const STATUS_META: Record<SkillRecord['status'], { label: string; tone: 'draft' | 'ok' | 'shared' }> = {
  draft: { label: 'Draft', tone: 'draft' },
  built: { label: 'Built', tone: 'ok' },
  configured: { label: 'Configured', tone: 'ok' },
  shared: { label: 'Shared', tone: 'shared' },
}

export function SkillsPage({
  agents,
  onNew,
  onEditDraft,
  scope = 'mine',
}: {
  agents: MiniappRecord[]
  onNew?: () => void
  onEditDraft?: (draftId: string) => void
  scope?: 'mine' | 'community'
}) {
  const [mine, setMine] = useState<SkillRecord[]>([])
  const [community, setCommunity] = useState<SkillRecord[]>([])
  const [library, setLibrary] = useState<PlatformSkill[]>([])
  const [loading, setLoading] = useState(true)

  const reload = () => {
    void Promise.all([listMySkills().catch(() => []), listCommunitySkills().catch(() => []), listSkillLibrary().catch(() => [])])
      .then(([m, c, l]) => {
        setMine(m)
        setCommunity(c)
        setLibrary(l)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    window.addEventListener('cirrus:skills-changed', reload)
    return () => window.removeEventListener('cirrus:skills-changed', reload)
  }, [])

  const communityCount = community.length + library.length

  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className={PAGE_CONTAINER_CLASS}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight text-ink">{scope === 'community' ? 'Community Skills' : 'Skills'}</h1>
            <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-secondary">
              {scope === 'community'
                ? 'Skills shared by the community and the platform library — install them on your agents.'
                : 'Author reusable skills, install them on your agents, and share them with the community.'}
            </p>
          </div>
          {scope === 'mine' && (
            <div className="flex flex-wrap items-center gap-2">
              <StatPill label="My Skills" value={mine.length} />
              {onNew && (
                <button
                  type="button"
                  onClick={onNew}
                  className="inline-flex items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:opacity-90"
                >
                  <Plus className="size-[15px]" /> New skill
                </button>
              )}
            </div>
          )}
        </div>

        {scope === 'mine' && (
          <section className="mt-7">
            <SectionHeader title="My Skills" count={mine.length} subtitle="Reusable skills you authored — edit, install on an agent, or share." />
            {loading ? (
              <LoadingRow />
            ) : mine.length ? (
              <div className={PAGE_GRID_CLASS}>
                {mine.map((skill) => (
                  <MySkillCard key={skill.id} skill={skill} agents={agents} onEdit={onEditDraft} onChanged={reload} />
                ))}
              </div>
            ) : (
              <EmptySkills />
            )}
          </section>
        )}

        {scope === 'community' && (
        <section className="mt-7">
          <SectionHeader title="Community Skills" count={communityCount} subtitle="Skills shared by others, plus the platform library." />
          {loading ? (
            <LoadingRow />
          ) : communityCount ? (
            <div className={PAGE_GRID_CLASS}>
              {community.map((skill) => (
                <CommunitySkillCard key={`pub:${skill.id}`} skill={skill} />
              ))}
              {library.map((skill) => (
                <LibrarySkillCard key={`lib:${skill.id}`} skill={skill} />
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-[16px] border border-dashed border-border-strong bg-white/40 px-4 py-8 text-center text-[13px] text-ink-tertiary">
              No community skills are available right now.
            </div>
          )}
        </section>
        )}
      </div>
    </div>
  )
}

function MySkillCard({
  skill,
  agents,
  onEdit,
  onChanged,
}: {
  skill: SkillRecord
  agents: MiniappRecord[]
  onEdit?: (id: string) => void
  onChanged: () => void
}) {
  const [installOpen, setInstallOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const status = STATUS_META[skill.status]
  const ready = skill.status !== 'draft'
  const secrets = skill.credentials.filter((c) => c.secret).length
  const scriptTools = skill.tools.filter((t) => t.entry).length

  useEffect(() => {
    if (!installOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setInstallOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [installOpen])

  const install = async (agentId: string, agentName: string) => {
    setBusy(true)
    setInstallOpen(false)
    try {
      const r = await installSkillOnAgent(skill.id, agentId)
      setFlash(r.ok ? `Installed on ${agentName}` : r.message)
    } catch {
      setFlash('Install failed')
    } finally {
      setBusy(false)
      window.setTimeout(() => setFlash(null), 2600)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete “${skill.name}”? This cannot be undone.`)) return
    setBusy(true)
    try {
      await apiDeleteSkill(skill.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="flex min-h-[210px] flex-col gap-3 rounded-[16px] border border-border bg-white p-5 shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)]">
      <div className="flex items-start gap-2.5">
        <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">{categoryIcon(skill)}</div>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => onEdit?.(skill.id)} className="block w-full text-left">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold text-ink hover:text-primary">{skill.name}</h3>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </div>
          </button>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <MiniBadge>{skill.category}</MiniBadge>
            <MiniBadge>{scriptTools ? 'Script code' : skill.tools.length ? 'Tool contract' : 'Instruction-only'}</MiniBadge>
          </div>
        </div>
      </div>

      <p className="line-clamp-2 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">{skill.description || 'No description yet.'}</p>

      <div className="grid grid-cols-2 gap-2">
        <Metric icon={<Code2 className="size-3.5" />} label="Tools" value={skill.tools.length} />
        <Metric icon={<KeyRound className="size-3.5" />} label="Secrets" value={secrets} />
      </div>

      {flash && <div className="rounded-[9px] bg-live-soft px-2.5 py-1.5 text-[11.5px] font-semibold text-live">{flash}</div>}

      <div className="flex items-center gap-1.5 border-t border-border pt-3">
        <button type="button" onClick={() => onEdit?.(skill.id)} className="rounded-[9px] border border-border px-2.5 py-1.5 text-[12px] font-semibold text-ink-secondary hover:bg-surface-muted">
          Edit
        </button>
        {ready ? (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              disabled={busy || agents.length === 0}
              onClick={() => setInstallOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-2.5 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Install
            </button>
            {installOpen && (
              <div className="absolute bottom-full left-0 z-30 mb-1.5 max-h-56 w-56 overflow-y-auto rounded-[12px] border border-border bg-surface p-1 shadow-[0_18px_46px_-18px_rgba(25,25,23,0.35)]">
                <div className="px-2.5 py-1.5 font-mono text-[10px] tracking-[0.14em] text-ink-tertiary">INSTALL ON AGENT</div>
                {agents.map((agent) => {
                  const name = agent.draft?.name ?? agent.manifest?.name ?? 'Untitled agent'
                  return (
                    <button key={agent.id} type="button" onClick={() => install(agent.id, name)} className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[13px] font-medium text-ink-secondary hover:bg-surface-muted">
                      <span className="truncate">{name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <span className="rounded-[9px] bg-surface-muted px-2.5 py-1.5 text-[11.5px] font-medium text-ink-tertiary">Finish building to install</span>
        )}
        <button type="button" onClick={remove} disabled={busy} className="ml-auto flex size-8 items-center justify-center rounded-[8px] text-ink-tertiary hover:bg-surface-muted hover:text-destructive disabled:opacity-40" aria-label="Delete skill">
          <Trash2 className="size-[15px]" />
        </button>
      </div>
    </article>
  )
}

function CommunitySkillCard({ skill }: { skill: SkillRecord }) {
  return (
    <article className="flex min-h-[170px] flex-col gap-3 rounded-[16px] border border-border bg-white p-5 shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)]">
      <div className="flex items-start gap-2.5">
        <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">{categoryIcon(skill)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-ink">{skill.name}</h3>
            <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">Community</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <MiniBadge>{skill.category}</MiniBadge>
          </div>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">{skill.description}</p>
      <div className="grid grid-cols-2 gap-2">
        <Metric icon={<Code2 className="size-3.5" />} label="Tools" value={skill.tools.length} />
        <Metric icon={<Lock className="size-3.5" />} label="Secrets" value={skill.credentials.filter((c) => c.secret).length} />
      </div>
    </article>
  )
}

function LibrarySkillCard({ skill }: { skill: PlatformSkill }) {
  return (
    <article className="flex min-h-[170px] flex-col gap-3 rounded-[16px] border border-border bg-white p-5 shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)]">
      <div className="flex items-start gap-2.5">
        <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
          {skill.id === 'gmail' ? <Mail className="size-[17px]" /> : CATEGORY_ICON[skill.category] ?? <Sparkles className="size-[17px]" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-ink">{skill.name}</h3>
            <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">Library</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <MiniBadge>{skill.category}</MiniBadge>
            <MiniBadge>Built-in</MiniBadge>
          </div>
        </div>
      </div>
      <p className="line-clamp-3 flex-1 text-[12.5px] leading-relaxed text-ink-secondary">{skill.description}</p>
      <div className="grid grid-cols-2 gap-2">
        <Metric icon={<Code2 className="size-3.5" />} label="Tools" value={skill.tools?.length ?? 0} />
        <Metric icon={<Lock className="size-3.5" />} label="Secrets" value={(skill.credentials ?? []).filter((c) => c.secret).length} />
      </div>
    </article>
  )
}

function categoryIcon(skill: SkillRecord) {
  return CATEGORY_ICON[skill.category] ?? <Sparkles className="size-[17px]" />
}

function SectionHeader({ title, subtitle, count }: { title: string; subtitle: string; count: number }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[17px] font-bold tracking-tight text-ink">{title}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">{subtitle}</p>
      </div>
      <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-secondary">{count}</span>
    </div>
  )
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-white/70 px-3">
      <span className="text-[11px] font-semibold leading-none text-ink-secondary">{label}</span>
      <span className="font-mono text-[11px] leading-none text-ink-tertiary">{value}</span>
    </div>
  )
}

function StatusBadge({ tone, children }: { tone: 'draft' | 'ok' | 'shared'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        tone === 'ok' && 'bg-live-soft text-live',
        tone === 'shared' && 'bg-accent-soft text-accent-ink',
        tone === 'draft' && 'bg-amber-100 text-amber-700',
      )}
    >
      {children}
    </span>
  )
}

function MiniBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10.5px] font-semibold capitalize text-ink-tertiary">{children}</span>
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-[10px] border border-border bg-surface px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-ink-tertiary">
        {icon}
        <span className="text-[10.5px] font-medium">{label}</span>
      </div>
      <div className="mt-1 font-mono text-[13px] text-ink">{value}</div>
    </div>
  )
}

function LoadingRow() {
  return (
    <div className="mt-4 flex items-center gap-2 rounded-[16px] border border-border bg-white/60 px-4 py-5 text-[13px] text-ink-secondary">
      <Loader2 className="size-4 animate-spin" /> Loading skills…
    </div>
  )
}

function EmptySkills() {
  return (
    <div className="mt-4 flex flex-col items-center justify-center gap-4 rounded-[20px] border border-dashed border-border-strong bg-white/40 px-4 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
        <Database className="size-6" />
      </div>
      <div>
        <div className="text-[16px] font-bold tracking-tight text-ink">No skills yet</div>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-secondary">Create a skill to read, operate, or send on an agent’s behalf — then install it on any agent.</p>
      </div>
    </div>
  )
}
