import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Check, Cpu, Loader2, Plus, Server, Star, Trash2 } from 'lucide-react'
import type { UserConnection } from '@shared/protocol'
import { createConnection, deleteConnection, listConnections, setDefaultConnection, updateConnection } from '@/lib/api'
import { cn } from '@/lib/utils'

const PAGE = 'mx-auto w-full max-w-[860px] px-4 pb-16 pt-9 sm:px-6'

interface FieldDef {
  key: string
  label: string
  placeholder?: string
  type?: 'text' | 'select' | 'password'
  options?: { label: string; value: string }[]
  secret?: boolean
  default?: string
}

interface ManagerProps {
  kind: 'model' | 'sandbox' | 'bot'
  title: string
  description: ReactNode
  icon: ReactNode
  addLabel: string
  fields: FieldDef[]
  /** Render a one-line summary under the connection name. */
  summary: (c: UserConnection) => ReactNode
}

function ConnectionsManager({ kind, title, description, icon, addLabel, fields, summary }: ManagerProps) {
  const [items, setItems] = useState<UserConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ id?: string; values: Record<string, string> } | null>(null)
  const [busy, setBusy] = useState(false)
  const showDefault = kind !== 'bot'

  const load = () =>
    listConnections(kind)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startNew = () => setEditing({ values: Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])) })
  const startEdit = (c: UserConnection) =>
    setEditing({
      id: c.id,
      values: Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : String((c as unknown as Record<string, unknown>)[f.key] ?? f.default ?? '')])),
    })

  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of fields) {
        const v = (editing.values[f.key] ?? '').trim()
        if (f.secret) {
          if (v) payload.secret = v
        } else {
          payload[f.key] = v
        }
      }
      if (editing.id) await updateConnection(editing.id, payload)
      else await createConnection({ kind, ...payload })
      setEditing(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm('Delete this connection?')) return
    await deleteConnection(id)
    await load()
  }
  const makeDefault = async (id: string) => {
    await setDefaultConnection(id)
    await load()
  }

  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className={PAGE}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-10 items-center justify-center rounded-[12px] bg-accent-soft text-accent-ink">{icon}</div>
            <div>
              <h1 className="text-[24px] font-bold tracking-tight text-ink">{title}</h1>
              <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-secondary">{description}</p>
            </div>
          </div>
          <button onClick={startNew} className="inline-flex shrink-0 items-center gap-1.5 rounded-[11px] bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90">
            <Plus className="size-[15px]" /> {addLabel}
          </button>
        </div>

        {editing && (
          <div className="mt-6 rounded-[16px] border border-border bg-white p-5 shadow-[0_8px_24px_-12px_rgba(25,25,23,0.10)]">
            <div className="text-[14px] font-semibold text-ink">{editing.id ? 'Edit connection' : addLabel}</div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <label key={f.key} className={cn('grid gap-1.5', f.type !== 'select' && !f.secret && f.key === 'name' ? 'sm:col-span-2' : '')}>
                  <span className="text-[11.5px] font-semibold text-ink-secondary">
                    {f.label}
                    {f.secret && editing.id ? <span className="ml-1.5 font-normal text-ink-tertiary">— leave blank to keep</span> : null}
                  </span>
                  {f.type === 'select' ? (
                    <select
                      value={editing.values[f.key] ?? ''}
                      onChange={(e) => setEditing((s) => (s ? { ...s, values: { ...s.values, [f.key]: e.target.value } } : s))}
                      className="rounded-[10px] border border-border bg-white px-3 py-2.5 text-[13px] text-ink outline-none focus:border-primary"
                    >
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={editing.values[f.key] ?? ''}
                      onChange={(e) => setEditing((s) => (s ? { ...s, values: { ...s.values, [f.key]: e.target.value } } : s))}
                      type={f.secret || f.type === 'password' ? 'password' : 'text'}
                      placeholder={f.placeholder}
                      className="rounded-[10px] border border-border bg-white px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-primary"
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
              </button>
              <button onClick={() => setEditing(null)} className="rounded-[10px] px-3.5 py-2 text-[13px] font-medium text-ink-secondary hover:bg-surface-muted">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 grid gap-3">
          {loading ? (
            <div className="flex items-center gap-2 rounded-[14px] border border-border bg-white/60 px-4 py-5 text-[13px] text-ink-secondary">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-[16px] border border-dashed border-border-strong bg-white/40 px-4 py-12 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">{icon}</div>
              <div className="mt-3 text-[15px] font-bold text-ink">Nothing connected yet</div>
              <p className="mx-auto mt-1 max-w-sm text-[12.5px] text-ink-secondary">Add your first {kind} so your agents can use it. Until then, the platform default is used.</p>
            </div>
          ) : (
            items.map((c) => {
              const configured = !!((c as { hasKey?: boolean; hasToken?: boolean }).hasKey ?? (c as { hasToken?: boolean }).hasToken)
              return (
              <article key={c.id} className="flex items-center gap-3 rounded-[14px] border border-border bg-white p-4 shadow-[0_8px_24px_-14px_rgba(25,25,23,0.10)]">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink">{icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-ink">{c.name || 'Untitled'}</span>
                    {showDefault && c.isDefault && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink">Default</span>}
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', configured ? 'bg-live-soft text-live' : 'bg-amber-100 text-amber-700')}>
                      <span className={cn('size-1.5 rounded-full', configured ? 'bg-live' : 'bg-amber-500')} />
                      {configured ? 'Ready' : kind === 'bot' ? 'No token' : 'No key'}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-tertiary">{summary(c)}</div>
                </div>
                {showDefault && !c.isDefault && (
                  <button onClick={() => makeDefault(c.id)} title="Set as default" className="flex size-8 items-center justify-center rounded-[8px] text-ink-tertiary hover:bg-surface-muted hover:text-accent-ink">
                    <Star className="size-[15px]" />
                  </button>
                )}
                <button onClick={() => startEdit(c)} className="rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-semibold text-ink-secondary hover:bg-surface-muted">
                  Edit
                </button>
                <button onClick={() => remove(c.id)} aria-label="Delete" className="flex size-8 items-center justify-center rounded-[8px] text-ink-tertiary hover:bg-surface-muted hover:text-destructive">
                  <Trash2 className="size-[15px]" />
                </button>
              </article>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export function ModelPage() {
  return (
    <ConnectionsManager
      kind="model"
      title="Model"
      description="Connect your own LLM endpoints (OpenAI-compatible). Your default model powers skill drafting, planning, and agent reasoning. Without one, a rate-limited platform model is used."
      icon={<Cpu className="size-[18px]" />}
      addLabel="Add model"
      fields={[
        { key: 'name', label: 'Name', placeholder: 'My OpenAI' },
        { key: 'endpoint', label: 'Base URL', placeholder: 'https://api.openai.com/v1', default: 'https://api.openai.com/v1' },
        { key: 'model', label: 'Model', placeholder: 'gpt-4o' },
        { key: 'secret', label: 'API key', placeholder: 'sk-…', secret: true },
      ]}
      summary={(c) => {
        const m = c as { endpoint?: string; model?: string; hasKey?: boolean }
        return `${m.model || '?'} · ${(m.endpoint || '').replace(/^https?:\/\//, '')} · ${m.hasKey ? 'key set' : 'no key'}`
      }}
    />
  )
}

export function SandboxPage() {
  return (
    <ConnectionsManager
      kind="sandbox"
      title="Sandbox"
      description="Connect your own code-execution sandbox (E2B or Daytona). Skill tests and tool runs execute here. Without one, a local/dev sandbox is used."
      icon={<Server className="size-[18px]" />}
      addLabel="Add sandbox"
      fields={[
        { key: 'name', label: 'Name', placeholder: 'My E2B' },
        { key: 'provider', label: 'Provider', type: 'select', options: [{ label: 'E2B', value: 'e2b' }, { label: 'Daytona', value: 'daytona' }], default: 'e2b' },
        { key: 'secret', label: 'API key', placeholder: 'e2b_…', secret: true },
      ]}
      summary={(c) => {
        const s = c as { provider?: string; hasKey?: boolean }
        return `${s.provider || 'e2b'} · ${s.hasKey ? 'key set' : 'no key'}`
      }}
    />
  )
}

export function BotsPage() {
  return (
    <ConnectionsManager
      kind="bot"
      title="Bots"
      description="Register chat bots once, then attach them to a runtime so users can talk to your agents. A bot serves one runtime at a time."
      icon={<Bot className="size-[18px]" />}
      addLabel="Add bot"
      fields={[
        { key: 'name', label: 'Name', placeholder: 'Support bot' },
        { key: 'platform', label: 'Platform', type: 'select', options: [{ label: 'Telegram', value: 'telegram' }, { label: 'Discord', value: 'discord' }, { label: 'Slack', value: 'slack' }], default: 'telegram' },
        { key: 'secret', label: 'Bot token', placeholder: 'token…', secret: true },
      ]}
      summary={(c) => {
        const b = c as { platform?: string; hasToken?: boolean; runtimeId?: string | null }
        return `${b.platform || 'telegram'} · ${b.hasToken ? 'token set' : 'no token'} · ${b.runtimeId ? 'attached' : 'unattached'}`
      }}
    />
  )
}
