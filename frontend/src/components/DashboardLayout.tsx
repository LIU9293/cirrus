import { type ReactNode } from 'react'
import { Blocks, Bot, Cpu, Globe, Server, Settings, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { NavView } from '@/wizard/AgentCanvas'
import { cn } from '@/lib/utils'

// The user's workspace shell: a grouped left sidebar of dashboard sections + the
// active page. Community discovery lives outside this (top-level /skills, /agents).

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

export function DashboardLayout({ view, onNavigate, children }: { view: NavView; onNavigate: (v: NavView) => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="hidden w-[216px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-white/75 px-3 pb-6 pt-[84px] backdrop-blur sm:flex">
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

        <button
          onClick={() => onNavigate('communityAgents')}
          className="mt-auto flex items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[12.5px] font-semibold text-ink-secondary hover:bg-surface-muted"
        >
          <Globe className="size-[15px] text-ink-tertiary" /> Browse community
        </button>
      </aside>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}
