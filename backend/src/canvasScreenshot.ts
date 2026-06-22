import type { AgentEvent } from './agent/developerAgent.ts'

interface PendingScreenshot {
  miniappId: string
  resolve: (result: CanvasScreenshotResult) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface CanvasScreenshotResult {
  ok: boolean
  imageUrl?: string
  error?: string
}

const pendingScreenshots = new Map<string, PendingScreenshot>()

export function requestCanvasScreenshot(
  miniappId: string,
  emit: (event: AgentEvent) => void,
  timeoutMs = 15000,
): Promise<CanvasScreenshotResult> {
  const requestId = `canvas-shot-${Date.now()}-${Math.random().toString(36).slice(2)}`
  emit({ type: 'canvas_screenshot_request', requestId })
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingScreenshots.delete(requestId)
      resolve({ ok: false, error: 'Canvas screenshot timed out.' })
    }, timeoutMs)
    pendingScreenshots.set(requestId, { miniappId, resolve, timeout })
  })
}

export function resolveCanvasScreenshot(
  miniappId: string,
  requestId: string,
  result: CanvasScreenshotResult,
): boolean {
  const pending = pendingScreenshots.get(requestId)
  if (!pending || pending.miniappId !== miniappId) return false
  clearTimeout(pending.timeout)
  pendingScreenshots.delete(requestId)
  pending.resolve(result)
  return true
}
