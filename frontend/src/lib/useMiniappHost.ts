import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  buildTerrAppFrameSrcDoc,
  createAppFrameBridgeToken,
  buildAppFrameHostStateMessage,
  buildAppFrameHostActionResultMessage,
  buildAppFrameHostInspectMessage,
  buildAppFrameHostCanvasScreenshotMessage,
  parseAppFrameActionMessage,
  parseAppFrameControlMessage,
  parseAppFrameOpenLinkMessage,
  parseAppFrameDiagnosticMessage,
  parseAppFrameInspectSelectionMessage,
  parseAppFrameCanvasScreenshotMessage,
  frameActionFailure,
} from '@shared/bridge'
import { postAction } from './api'
import type { CanvasElementSelection, MiniappRecord } from '@shared/protocol'

export interface HostEvents {
  /** Runtime context when the iframe is hosted inside a runtime window. */
  runtimeId?: string
  /** Called whenever the host-owned state advances (after an action). */
  onState?: (state: Record<string, unknown>, version: number) => void
  /** Called with an agent/action message to surface in the UI. */
  onActivity?: (text: string) => void
  /** Enables element picking inside the sandboxed iframe. */
  inspectMode?: boolean
  /** Called when the user picks an element inside the iframe. */
  onInspectSelection?: (selection: CanvasElementSelection) => void
}

/**
 * Drives one miniapp inside an iframe: builds the bridged srcDoc, listens for
 * frame->host messages, forwards actions to the backend, and pushes new state
 * back into the frame. The iframe is sandboxed (allow-scripts only) so the
 * bridge is the only channel.
 */
export function useMiniappHost(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  miniapp: MiniappRecord | null,
  events: HostEvents = {},
) {
  const boxId = miniapp?.id ?? 'none'
  // Live state mirror (host is authoritative). Seeded from the record; advanced
  // by action results. Not used to rebuild srcDoc (that would remount the frame).
  const stateRef = useRef<{ state: Record<string, unknown>; version: number }>({
    state: miniapp?.state ?? {},
    version: miniapp?.stateVersion ?? 0,
  })
  const eventsRef = useRef(events)
  const screenshotRequestsRef = useRef(
    new Map<
      string,
      {
        resolve: (imageUrl: string) => void
        reject: (error: Error) => void
        timeout: number
      }
    >(),
  )
  eventsRef.current = events

  // Rebuild the srcDoc only when the built html (or app id) changes. A fresh
  // bridge token is minted per mount and embedded alongside the current state.
  const frame = useMemo(() => {
    if (!miniapp?.html) return null
    stateRef.current = { state: miniapp.state ?? {}, version: miniapp.stateVersion ?? 0 }
    const token = createAppFrameBridgeToken(miniapp.id)
    const srcDoc = buildTerrAppFrameSrcDoc(
      miniapp.html,
      { boxId: miniapp.id, state: miniapp.state ?? {}, version: miniapp.stateVersion ?? 0 },
      token,
    )
    return { srcDoc, token, boxId: miniapp.id }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniapp?.id, miniapp?.html])

  const pushState = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !frame) return
    win.postMessage(
      buildAppFrameHostStateMessage(
        { boxId: frame.boxId, state: stateRef.current.state, version: stateRef.current.version },
        frame.token,
      ),
      '*',
    )
  }, [frame, iframeRef])

  const pushInspectMode = useCallback(
    (enabled: boolean, clear = false) => {
      const win = iframeRef.current?.contentWindow
      if (!win || !frame) return
      win.postMessage(buildAppFrameHostInspectMessage(frame.boxId, frame.token, enabled, clear), '*')
    },
    [frame, iframeRef],
  )

  const captureScreenshot = useCallback(() => {
    const win = iframeRef.current?.contentWindow
    if (!win || !frame) return Promise.reject(new Error('Canvas iframe is not ready.'))
    const requestId = `shot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        screenshotRequestsRef.current.delete(requestId)
        reject(new Error('Canvas screenshot timed out.'))
      }, 12000)
      screenshotRequestsRef.current.set(requestId, { resolve, reject, timeout })
      win.postMessage(buildAppFrameHostCanvasScreenshotMessage(frame.boxId, frame.token, requestId), '*')
    })
  }, [frame, iframeRef])

  useEffect(() => {
    if (!frame || !miniapp || miniapp.id !== frame.boxId) return
    const nextState = miniapp.state ?? {}
    const nextVersion = miniapp.stateVersion ?? 0
    if (stateRef.current.version === nextVersion) return

    stateRef.current = { state: nextState, version: nextVersion }
    pushState()
  }, [frame, miniapp, miniapp?.state, miniapp?.stateVersion, pushState])

  useEffect(() => {
    if (!frame) return
    const enabled = events.inspectMode === true
    pushInspectMode(enabled, !enabled)
  }, [events.inspectMode, frame, pushInspectMode])

  useEffect(() => {
    if (!frame) return
    const win = () => iframeRef.current?.contentWindow ?? null

    const onMessage = async (event: MessageEvent) => {
      if (event.source !== win()) return
      const raw = event.data

      const control = parseAppFrameControlMessage(raw, frame.boxId, frame.token)
      if (control?.type === 'ready') {
        pushState()
        return
      }
      if (control?.type === 'resize') return

      const link = parseAppFrameOpenLinkMessage(raw, frame.boxId, frame.token)
      if (link) {
        window.open(link, '_blank', 'noopener,noreferrer')
        return
      }

      const diag = parseAppFrameDiagnosticMessage(raw, frame.boxId, frame.token)
      if (diag) {
        if (diag.level === 'error') console.error('[miniapp]', diag.message)
        else console.warn('[miniapp]', diag.message)
        return
      }

      const inspectSelection = parseAppFrameInspectSelectionMessage(raw, frame.boxId, frame.token)
      if (inspectSelection) {
        eventsRef.current.onInspectSelection?.(inspectSelection)
        pushInspectMode(false, true)
        return
      }

      const canvasScreenshot = parseAppFrameCanvasScreenshotMessage(raw, frame.boxId, frame.token)
      if (canvasScreenshot) {
        const pending = screenshotRequestsRef.current.get(canvasScreenshot.requestId)
        if (!pending) return
        window.clearTimeout(pending.timeout)
        screenshotRequestsRef.current.delete(canvasScreenshot.requestId)
        if (canvasScreenshot.ok && canvasScreenshot.imageUrl) pending.resolve(canvasScreenshot.imageUrl)
        else pending.reject(new Error(canvasScreenshot.error || 'Canvas screenshot failed.'))
        return
      }

      const action = parseAppFrameActionMessage(raw, frame.boxId, frame.token)
      if (!action) return

      const target = win()
      if (!target) return
      try {
        const outcome = await postAction(frame.boxId, action.actionId, action.payload, eventsRef.current.runtimeId)
        stateRef.current = { state: outcome.state, version: outcome.stateVersion }
        // Push new state first, then resolve the action so the frame's await sees it.
        pushState()
        eventsRef.current.onState?.(outcome.state, outcome.stateVersion)
        if (action.actionId !== 'terr.set_state' && outcome.message) {
          eventsRef.current.onActivity?.(outcome.message)
        }
        target.postMessage(
          buildAppFrameHostActionResultMessage(frame.boxId, frame.token, action.requestId, {
            ok: outcome.ok,
            status: outcome.ok ? 'ok' : 'error',
            code: outcome.ok ? 'ok' : 'error',
            message: outcome.message,
            retryable: false,
            actionId: action.actionId,
            stateVersion: outcome.stateVersion,
          }),
          '*',
        )
      } catch (err) {
        target.postMessage(
          buildAppFrameHostActionResultMessage(
            frame.boxId,
            frame.token,
            action.requestId,
            frameActionFailure(action.actionId, 'host_error', String((err as Error)?.message ?? err), true),
          ),
          '*',
        )
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [frame, iframeRef, pushInspectMode, pushState])

  return { srcDoc: frame?.srcDoc ?? null, boxId, captureScreenshot }
}
