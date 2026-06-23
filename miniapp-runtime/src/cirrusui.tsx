// miniapp-runtime/src/cirrusui.tsx
//
// The miniapp-side SDK. Agent-authored apps import from "@/cirrusui" to talk to the
// host through window.CirrusUI (injected by the bridge). This is the ONLY channel a
// miniapp has to the outside world — there is no direct network access.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export interface ActionResult {
  ok: boolean
  status: string
  code: string
  message: string
  retryable: boolean
  actionId: string
  stateVersion?: number
}

interface CirrusUIBridge {
  getState(): unknown
  getStateVersion(): number
  subscribe(listener: (state: unknown) => void): () => void
  action(actionId: string, payload?: unknown): Promise<ActionResult>
  openLink(href: string): void
  ready(): void
  resize(): void
}

declare global {
  interface Window {
    CirrusUI?: CirrusUIBridge
  }
}

const OFFLINE_RESULT: ActionResult = {
  ok: false,
  status: 'unavailable',
  code: 'bridge_unavailable',
  message: 'The Cirrus host bridge is not available.',
  retryable: false,
  actionId: '',
}

function bridge(): CirrusUIBridge | undefined {
  return typeof window !== 'undefined' ? window.CirrusUI : undefined
}

/**
 * Subscribe to the host-owned state model. Re-renders whenever the host pushes a
 * new state. The generic T is the shape declared in the miniapp manifest's stateModel.
 */
const EMPTY_STATE: Record<string, unknown> = {}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  return true
}

export function useCirrusState<T = Record<string, unknown>>(): T {
  const cacheRef = useRef<T>(EMPTY_STATE as T)
  const subscribe = useCallback((onChange: () => void) => {
    const ui = bridge()
    if (!ui) return () => {}
    return ui.subscribe(() => onChange())
  }, [])
  // useSyncExternalStore requires a referentially stable snapshot. The host may
  // hand back a fresh object (or nothing) each call, so cache and reuse the last
  // value whenever it's shallow-equal — otherwise React sees the snapshot change
  // every render and loops forever (Minified React error #185).
  const getSnapshot = useCallback(() => {
    const next = (bridge()?.getState() ?? EMPTY_STATE) as T
    if (shallowEqual(cacheRef.current, next)) return cacheRef.current
    cacheRef.current = next
    return next
  }, [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export interface TerrApi {
  /** Persist a shallow patch into the host-owned state model. */
  setState: (patch: Record<string, unknown>) => Promise<ActionResult>
  /** Invoke a manifest-declared action (mutate_state or agent). */
  action: (actionId: string, payload?: unknown) => Promise<ActionResult>
  /** Open an external link through the host (sandbox blocks direct navigation). */
  openLink: (href: string) => void
}

export function useCirrus(): TerrApi {
  const setState = useCallback(
    (patch: Record<string, unknown>) => bridge()?.action('terr.set_state', { patch }) ?? Promise.resolve(OFFLINE_RESULT),
    [],
  )
  const action = useCallback(
    (actionId: string, payload?: unknown) => bridge()?.action(actionId, payload) ?? Promise.resolve(OFFLINE_RESULT),
    [],
  )
  const openLink = useCallback((href: string) => bridge()?.openLink(href), [])
  return { setState, action, openLink }
}

/**
 * Convenience for kind:"agent" actions: tracks a pending flag and the last result
 * so a button can show a spinner while the agent works.
 */
export function useAgentAction(actionId: string) {
  const { action } = useCirrus()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const run = useCallback(
    async (payload?: unknown) => {
      setPending(true)
      try {
        const r = await action(actionId, payload)
        setResult(r)
        return r
      } finally {
        setPending(false)
      }
    },
    [action, actionId],
  )
  return { run, pending, result }
}

export function useAgentDataSource(
  actionId: string,
  payload?: unknown,
  options: { enabled?: boolean; refreshKey?: unknown } = {},
) {
  const action = useAgentAction(actionId)
  const ranRef = useRef(false)
  const refreshToken = JSON.stringify(options.refreshKey ?? null)

  useEffect(() => {
    if (options.enabled === false) return
    if (options.refreshKey === undefined && ranRef.current) return
    ranRef.current = true
    void action.run(payload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.run, actionId, options.enabled, refreshToken])

  return { refresh: action.run, pending: action.pending, result: action.result }
}

/** Mounts auto-resize: reports content height to the host on any layout change. */
export function useAutoResize<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const ui = bridge()
    ui?.ready()
    ui?.resize()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => ui?.resize())
    ro.observe(ref.current ?? document.body)
    return () => ro.disconnect()
  }, [])
  return ref
}
