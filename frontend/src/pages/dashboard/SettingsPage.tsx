import { LogOut, UserCircle } from 'lucide-react'
import type { AuthUser } from '@shared/protocol'
import { logout } from '@/lib/api'

export function SettingsPage({ user }: { user: AuthUser }) {
  return (
    <div className="dot-bg relative h-full w-full overflow-auto">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-16 pt-[100px] sm:px-6">
        <h1 className="text-[24px] font-bold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-ink-secondary">Your profile and account.</p>

        <div className="mt-6 rounded-[16px] border border-border bg-white p-5 shadow-[0_8px_24px_-14px_rgba(25,25,23,0.10)]">
          <div className="flex items-center gap-4">
            {user.picture ? (
              <img src={user.picture} alt="" className="size-14 rounded-full" />
            ) : (
              <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-[20px] font-bold text-accent-ink">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <div className="truncate text-[16px] font-semibold text-ink">{user.name || '—'}</div>
              <div className="truncate text-[13px] text-ink-secondary">{user.email}</div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 border-t border-border pt-4">
            <Row icon={<UserCircle className="size-[15px]" />} label="Display name" value={user.name || '—'} />
            <Row icon={<UserCircle className="size-[15px]" />} label="Email" value={user.email} />
          </div>

          <button
            onClick={async () => {
              await logout()
              window.location.reload()
            }}
            className="mt-5 inline-flex items-center gap-2 rounded-[10px] border border-border px-3.5 py-2 text-[13px] font-semibold text-destructive hover:bg-destructive/10"
          >
            <LogOut className="size-[15px]" /> Sign out
          </button>
        </div>

        <p className="mt-4 text-[12px] text-ink-tertiary">Avatar upload and more profile options are coming soon.</p>
      </div>
    </div>
  )
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] bg-surface-muted/60 px-3 py-2.5">
      <span className="text-ink-tertiary">{icon}</span>
      <span className="w-32 text-[12px] font-medium text-ink-secondary">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{value}</span>
    </div>
  )
}
