import { forwardRef, useImperativeHandle, useRef } from 'react'
import { Loader2, AppWindow, AlertTriangle, MousePointer2, Wand2, Sparkles } from 'lucide-react'
import type { CanvasElementSelection, MiniappRecord } from '@shared/protocol'
import { useMiniappHost } from '@/lib/useMiniappHost'
import { cn } from '@/lib/utils'

interface Props {
  miniapp: MiniappRecord | null
  runtimeId?: string
  onState?: (state: Record<string, unknown>, version: number) => void
  canSelectElements: boolean
  selectingElement: boolean
  selectedElement: CanvasElementSelection | null
  onToggleElementSelect: () => void
  onElementSelected: (selection: CanvasElementSelection) => void
  /** Show the built-in title header (default true). The panel hides it. */
  chrome?: boolean
}

export interface MiniappCanvasHandle {
  captureScreenshot: () => Promise<string>
}

export const MiniappCanvas = forwardRef<MiniappCanvasHandle, Props>(function MiniappCanvas({
  miniapp,
  runtimeId,
  onState,
  canSelectElements,
  selectingElement,
  selectedElement,
  onToggleElementSelect,
  onElementSelected,
  chrome = true,
}: Props, ref) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const { srcDoc, captureScreenshot } = useMiniappHost(iframeRef, miniapp, {
    runtimeId,
    onState,
    inspectMode: selectingElement,
    onInspectSelection: onElementSelected,
  })

  useImperativeHandle(ref, () => ({ captureScreenshot }), [captureScreenshot])

  return (
    <div className="flex h-full flex-col">
      {chrome && (
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
            <AppWindow className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{miniapp?.manifest?.name ?? 'Canvas'}</div>
            <div className="truncate text-xs text-muted-foreground">
              {miniapp?.manifest?.description ?? 'Your miniapp will appear here.'}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {miniapp?.html && canSelectElements && (
            <button
              onClick={onToggleElementSelect}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition',
                selectingElement ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-secondary',
              )}
            >
              <MousePointer2 className="size-3.5" />
              {selectingElement ? 'Pick element' : 'Select element'}
            </button>
          )}
        </div>
      </header>
      )}

      <div className="relative min-h-0 flex-1 bg-muted/30">
        {miniapp?.status === 'building' && <Overlay icon={<Loader2 className="size-5 animate-spin" />} text="Building the miniapp…" />}
        {miniapp?.status === 'error' && !miniapp.html && (
          <Overlay icon={<AlertTriangle className="size-5 text-destructive" />} text={miniapp.buildError ?? 'Build failed.'} mono />
        )}
        {!miniapp?.html && miniapp?.status !== 'building' && miniapp?.status !== 'error' && <EmptyCanvas />}
        {srcDoc && (
          <>
            <iframe
              ref={iframeRef}
              title="miniapp"
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              className="h-full w-full border-0 bg-white"
            />
            {selectedElement && <SelectionOverlay selection={selectedElement} />}
          </>
        )}
      </div>

      {miniapp?.status === 'error' && miniapp.html && (
        <div className="max-h-32 overflow-auto border-t border-destructive/40 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <div className="mb-1 font-semibold">Last build failed (showing previous version)</div>
          <pre className="whitespace-pre-wrap font-mono">{miniapp.buildError}</pre>
        </div>
      )}
    </div>
  )
})

function EmptyCanvas() {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden p-6">
      {/* playful floating shapes */}
      <div className="pointer-events-none absolute inset-0">
        <div className="terr-float-slow absolute left-[16%] top-[22%] size-14 rounded-2xl border-2 border-dashed border-primary/25" />
        <div className="terr-float-rev absolute right-[18%] top-[28%] size-9 rounded-full bg-primary/10" />
        <div className="terr-float absolute bottom-[24%] left-[26%] h-2.5 w-16 rounded-full bg-primary/10" />
        <Sparkles className="terr-float-slow absolute right-[26%] bottom-[30%] size-5 text-primary/30" />
        <div className="terr-float-rev absolute left-[40%] top-[16%] size-3 rounded-full bg-primary/20" />
      </div>

      <div className="relative flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="terr-float flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#837DFF] text-primary-foreground shadow-[0_14px_34px_-10px_rgba(91,87,242,0.65)]">
          <Wand2 className="size-7" />
        </div>
        <div>
          <div className="text-[16px] font-bold tracking-tight text-foreground">A blank canvas ✨</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            Describe the app you want in the build chat — I&apos;ll sketch it right here.
          </p>
        </div>
      </div>
    </div>
  )
}

function Overlay({ icon, text, mono }: { icon: React.ReactNode; text: string; mono?: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <p className={cn('text-sm text-muted-foreground', mono && 'whitespace-pre-wrap text-left font-mono text-xs')}>{text}</p>
      </div>
    </div>
  )
}

function SelectionOverlay({ selection }: { selection: CanvasElementSelection }) {
  const rect = selection.rect
  if (rect.width <= 0 || rect.height <= 0) return null
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-md border-2 border-primary bg-primary/10 shadow-[0_0_0_2px_rgba(255,255,255,0.75)]"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    >
      <div className="absolute -top-7 left-0 max-w-64 truncate rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground shadow">
        {selection.label}
      </div>
    </div>
  )
}
