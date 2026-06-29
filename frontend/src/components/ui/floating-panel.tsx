import { useState, type ReactNode } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// The shared floating window used across the studio (skill scripts/README viewer,
// settings editor, …). Handles the glass chrome, a draggable title bar, a
// bottom-right resize grip, maximize, and close — so panels only supply content.

function startPointerDrag(e: React.PointerEvent, onMove: (dx: number, dy: number) => void) {
  const sx = e.clientX
  const sy = e.clientY
  const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

export function FloatingPanel({
  title,
  subtitle,
  icon,
  onClose,
  children,
  width = 880,
  height = 580,
  minWidth = 460,
  minHeight = 320,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
}) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ w: width, h: height })
  const [max, setMax] = useState(false)

  const onHeaderDown = (e: React.PointerEvent) => {
    if (max || (e.target as HTMLElement).closest('button, input, select, textarea')) return
    const ox = pos.x
    const oy = pos.y
    startPointerDrag(e, (dx, dy) => setPos({ x: ox + dx, y: oy + dy }))
  }
  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const sw = size.w
    const sh = size.h
    startPointerDrag(e, (dx, dy) => setSize({ w: Math.max(minWidth, sw + dx), h: Math.max(minHeight, sh + dy) }))
  }

  return (
    <div
      data-no-pan
      onPointerDown={(e) => e.stopPropagation()}
      className={cn('absolute z-[265] cursor-default select-text', max ? 'inset-x-6 top-[96px] bottom-6' : 'left-1/2 top-1/2')}
      style={max ? undefined : { width: size.w, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
    >
      <div
        className={cn('relative flex flex-col overflow-hidden rounded-[18px] border border-white/70 shadow-[0_26px_64px_-14px_rgba(25,25,23,0.36)]', max && 'h-full')}
        style={{ ...(max ? {} : { height: size.h }), background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(26px)', WebkitBackdropFilter: 'blur(26px)' }}
      >
        <div onPointerDown={onHeaderDown} className={cn('flex select-none items-center gap-2.5 border-b border-black/5 px-4 py-2.5', !max && 'cursor-grab active:cursor-grabbing')}>
          {icon && <div className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-surface-muted text-ink">{icon}</div>}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-ink">{title}</div>
            {subtitle && <div className="truncate text-[10.5px] text-ink-tertiary">{subtitle}</div>}
          </div>
          <button onClick={() => setMax((v) => !v)} className="flex size-8 items-center justify-center rounded-[8px] text-ink-secondary hover:bg-surface-muted" aria-label="Toggle maximize">
            {max ? <Minimize2 className="size-[15px]" /> : <Maximize2 className="size-[15px]" />}
          </button>
          <button onClick={onClose} className="flex size-8 items-center justify-center rounded-[8px] text-ink-secondary hover:bg-surface-muted" aria-label="Close">
            <X className="size-[16px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">{children}</div>

        {!max && (
          <div onPointerDown={onResizeDown} className="absolute bottom-0 right-0 z-10 flex size-5 cursor-nwse-resize items-end justify-end p-1" aria-label="Resize panel">
            <svg viewBox="0 0 10 10" className="size-[11px] text-ink-tertiary">
              <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
            </svg>
          </div>
        )}
      </div>
    </div>
  )
}
