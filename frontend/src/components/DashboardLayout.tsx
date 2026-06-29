import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Blocks, Bot, Cpu, Globe, LogOut, Server, Settings, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { AuthUser } from '@shared/protocol'
import type { NavView } from '@/wizard/AgentCanvas'
import { logout } from '@/lib/api'
import { cn } from '@/lib/utils'

// The user's workspace shell: a full-height left sidebar (brand + account at the
// top, grouped sections below) and the active page. There is no top navbar here —
// the sidebar owns the chrome. Community discovery lives outside (top-level pages).

const GROUPS: { label: string; items: { view: NavView; label: string; icon: ReactNode }[] }[] = [
  {
    label: 'Build',
    items: [
      { view: 'dashAgents', label: 'Agents', icon: <Sparkles className="size-[15px]" /> },
      { view: 'dashSkills', label: 'Skills', icon: <Blocks className="size-[15px]" /> },
    ],
  },
  {
    label: 'Run',
    items: [
      { view: 'dashRuntimes', label: 'Runtimes', icon: <SlidersHorizontal className="size-[15px]" /> },
      { view: 'dashBots', label: 'Bots', icon: <Bot className="size-[15px]" /> },
    ],
  },
  {
    label: 'Connect',
    items: [
      { view: 'dashModel', label: 'Model', icon: <Cpu className="size-[15px]" /> },
      { view: 'dashSandbox', label: 'Sandbox', icon: <Server className="size-[15px]" /> },
    ],
  },
  {
    label: 'Account',
    items: [{ view: 'dashSettings', label: 'Settings', icon: <Settings className="size-[15px]" /> }],
  },
]

export function DashboardLayout({ user, view, onNavigate, children }: { user: AuthUser; view: NavView; onNavigate: (v: NavView) => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full bg-background">
      <aside className="hidden w-[220px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-white/80 px-3 pb-6 pt-3 backdrop-blur sm:flex">
        {/* Brand + account */}
        <div className="flex items-center gap-2 px-1 py-1">
          <button onClick={() => onNavigate('dashAgents')} className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-surface-muted">
            <span className="flex size-7 items-center justify-center rounded-[8px] bg-primary text-primary-foreground">
              <Sparkles className="size-4" />
            </span>
            <span className="truncate text-[15px] font-bold tracking-tight text-ink">Cirrus</span>
          </button>
          <AccountMenu user={user} onNavigate={onNavigate} />
        </div>

        <div className="flex flex-1 flex-col gap-4">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-2.5 pb-1.5 font-mono text-[9.5px] font-semibold tracking-[0.16em] text-ink-tertiary">{group.label.toUpperCase()}</div>
              <nav className="flex flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = view === item.view
                  return (
                    <button
                      key={item.view}
                      onClick={() => onNavigate(item.view)}
                      className={cn(
                        'group relative flex items-center gap-2.5 rounded-[10px] py-2 pl-3 pr-2.5 text-left text-[13.5px] font-medium transition',
                        active ? 'bg-accent-soft text-accent-ink' : 'text-ink-secondary hover:bg-surface-muted hover:text-ink',
                      )}
                    >
                      {active && <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent-ink" />}
                      <span className={active ? 'text-accent-ink' : 'text-ink-tertiary group-hover:text-ink-secondary'}>{item.icon}</span>
                      {item.label}
                    </button>
                  )
                })}
              </nav>
            </div>
          ))}
        </div>

        <button
          onClick={() => onNavigate('communityAgents')}
          className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[12.5px] font-semibold text-ink-secondary hover:bg-surface-muted"
        >
          <Globe className="size-[15px] text-ink-tertiary" /> Browse community
        </button>
      </aside>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}

function AccountMenu({ user, onNavigate }: { user: AuthUser; onNavigate: (v: NavView) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const label = user.name || user.email

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="grid size-8 place-items-center rounded-full hover:bg-surface-muted" aria-label="Account menu">
        {user.picture ? (
          <img src={user.picture} alt="" className="size-7 rounded-full" />
        ) : (
          <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{label.slice(0, 1).toUpperCase()}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-52 overflow-hidden rounded-[12px] border border-border bg-surface p-1 shadow-[0_18px_46px_-18px_rgba(25,25,23,0.35)]">
          <div className="px-2.5 py-2">
            <div className="truncate text-[12px] font-semibold text-ink">{label}</div>
            <div className="truncate text-[11px] text-ink-tertiary">{user.email}</div>
          </div>
          <button
            onClick={() => {
              setOpen(false)
              onNavigate('dashSettings')
            }}
            className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-ink-secondary hover:bg-surface-muted"
          >
            <Settings className="size-[14px]" /> Settings
          </button>
          <button
            onClick={async () => {
              await logout()
              window.location.reload()
            }}
            className="flex w-full items-center gap-2 rounded-[7px] px-2.5 py-2 text-left text-[13px] font-medium text-destructive hover:bg-destructive/10"
          >
            <LogOut className="size-[14px]" /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}
