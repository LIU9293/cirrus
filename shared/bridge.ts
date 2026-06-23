// shared/bridge.ts
//
// REUSED from terr: frontend/src/new-ui/chat/appFrameBridge.ts (the "JS bridge plugin").
// This is the host<->frame communication layer. The host:
//   - wraps a miniapp's single-file HTML with buildTerrAppFrameSrcDoc() which injects
//     a CSP <meta> + a <script> that defines window.CirrusUI inside the sandboxed iframe,
//   - pushes state with buildAppFrameHostStateMessage(),
//   - parses frame->host messages (action / open_link / ready / resize / diagnostic),
//   - replies to actions with buildAppFrameHostActionResultMessage().
//
// The only change vs. the original is inlining the AppFrameActionResult type
// (was imported from '@/lib/appFrameRuntime') so this file is standalone.

export interface AppFrameActionResult {
  ok: boolean
  status: string
  code: string
  message: string
  retryable: boolean
  actionId: string
  blockedRole?: string
  stateVersion?: number
  stateVersions?: Record<string, number>
  modelsChanged?: string[]
}

export const APP_FRAME_PROTOCOL = 'terr.app_frame.v1'

type AppFrameDirection = 'frame_to_host' | 'host_to_frame'

interface AppFrameEnvelope {
  protocol?: unknown
  direction?: unknown
  type?: unknown
  boxId?: unknown
  bridgeToken?: unknown
}

export interface AppFrameActionMessage {
  actionId: string
  payload: unknown
  requestId: string
}

export interface AppFrameControlMessage {
  type: 'ready' | 'resize'
}

export interface AppFrameDiagnostic {
  level: 'warn' | 'error'
  message: string
  stack?: string
}

export interface AppFrameCanvasScreenshot {
  requestId: string
  ok: boolean
  imageUrl?: string
  error?: string
}

export interface AppFrameInspectSelection {
  tagName: string
  selector: string
  label: string
  text: string
  imageUrl?: string
  id?: string
  className?: string
  role?: string
  ariaLabel?: string
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
  viewport: {
    width: number
    height: number
  }
}

interface AppFrameBridgeBox {
  boxId: string
  serviceHttpBaseUrl?: string
  serviceRequestToken?: string
  serviceWsBaseUrl?: string
  stateModelId?: string
  state?: unknown
  version: number
}

interface AppFrameStateBox {
  boxId: string
  stateModelId?: string
  state?: unknown
  version: number
}

const maxAppFramePayloadBytes = 32 * 1024
const maxAppFrameDiagnosticBytes = 2 * 1024
const appFrameCSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' http: https:",
  "img-src data: blob: http: https:",
  "media-src data: blob: http: https:",
  "font-src data: http: https:",
  'connect-src http: https: ws: wss:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function createAppFrameBridgeToken(boxId: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${boxId}:${random}`
}

export function buildAppFrameHostStateMessage(box: AppFrameStateBox, bridgeToken: string) {
  return {
    protocol: APP_FRAME_PROTOCOL,
    direction: 'host_to_frame' as const,
    type: 'state' as const,
    boxId: box.boxId,
    bridgeToken,
    stateModelId: box.stateModelId,
    state: box.state ?? {},
    stateVersion: box.version,
  }
}

export function buildAppFrameHostActionResultMessage(
  boxId: string,
  bridgeToken: string,
  requestId: string,
  result: AppFrameActionResult,
) {
  return {
    protocol: APP_FRAME_PROTOCOL,
    direction: 'host_to_frame' as const,
    type: 'action_result' as const,
    boxId,
    bridgeToken,
    requestId,
    ok: result.ok === true,
    status: result.status,
    code: result.code,
    message: result.message,
    retryable: result.retryable === true,
    actionId: result.actionId,
    ...(result.stateVersion !== undefined ? { stateVersion: result.stateVersion } : {}),
  }
}

export function buildAppFrameHostInspectMessage(boxId: string, bridgeToken: string, enabled: boolean, clear = false) {
  return {
    protocol: APP_FRAME_PROTOCOL,
    direction: 'host_to_frame' as const,
    type: 'inspect' as const,
    boxId,
    bridgeToken,
    enabled,
    clear,
  }
}

export function buildAppFrameHostCanvasScreenshotMessage(boxId: string, bridgeToken: string, requestId: string) {
  return {
    protocol: APP_FRAME_PROTOCOL,
    direction: 'host_to_frame' as const,
    type: 'capture_screenshot' as const,
    boxId,
    bridgeToken,
    requestId,
  }
}

export function frameActionOK(actionId: string, stateVersion?: number): AppFrameActionResult {
  return {
    ok: true,
    status: 'ok',
    code: 'ok',
    message: 'Action completed.',
    retryable: false,
    actionId,
    ...(stateVersion !== undefined ? { stateVersion } : {}),
  }
}

export function frameActionFailure(actionId: string, code: string, message: string, retryable = false, status = 'error'): AppFrameActionResult {
  return { ok: false, status, code, message, retryable, actionId }
}

export function buildTerrAppFrameSrcDoc(
  html: string,
  box: AppFrameBridgeBox,
  bridgeToken = createAppFrameBridgeToken(box.boxId),
): string {
  const bridge = bridgeScript(box, bridgeToken)
  const headInjection = `${cspMeta()}${bridge}`
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${headInjection}`)
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${headInjection}</head>`)
  }
  return `<!doctype html><html><head>${headInjection}</head><body>${html}</body></html>`
}

export function parseAppFrameActionMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): AppFrameActionMessage | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message || message.type !== 'action') return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  const typed = raw as { actionId?: unknown; requestId?: unknown; payload?: unknown }
  const actionId = typeof typed.actionId === 'string' ? typed.actionId.trim() : ''
  if (!actionId) return null
  if (!payloadWithinLimit(typed.payload)) return null
  const payload = sanitizeActionPayload(typed.payload)
  if (!payload) return null
  const requestId = typeof typed.requestId === 'string' ? typed.requestId.trim() : ''
  if (!requestId) return null
  return { actionId, requestId, payload }
}

export function parseAppFrameOpenLinkMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): string | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message || message.type !== 'open_link') return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  const href = (raw as { href?: unknown }).href
  if (typeof href !== 'string') return null
  let url: URL
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.href
}

export function parseAppFrameControlMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): AppFrameControlMessage | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message) return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  if (message.type !== 'ready' && message.type !== 'resize') return null
  return { type: message.type }
}

export function parseAppFrameDiagnosticMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): AppFrameDiagnostic | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message || message.type !== 'diagnostic') return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  const diagnostic = (raw as { diagnostic?: unknown }).diagnostic
  if (!diagnostic || typeof diagnostic !== 'object') return null
  const typed = diagnostic as { level?: unknown; message?: unknown; stack?: unknown }
  const level = typed.level === 'warn' ? 'warn' : 'error'
  const text = typeof typed.message === 'string' ? typed.message.slice(0, maxAppFrameDiagnosticBytes) : ''
  if (!text) return null
  const stack = typeof typed.stack === 'string' ? typed.stack.slice(0, maxAppFrameDiagnosticBytes) : ''
  return { level, message: text, ...(stack ? { stack } : {}) }
}

export function parseAppFrameInspectSelectionMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): AppFrameInspectSelection | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message || message.type !== 'inspect_selection') return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  const selection = (raw as { selection?: unknown }).selection
  if (!selection || typeof selection !== 'object') return null
  const typed = selection as Partial<AppFrameInspectSelection>
  const rect = typed.rect
  const viewport = typed.viewport
  if (!rect || !viewport) return null
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every((v) => typeof v === 'number')) return null
  const tagName = typeof typed.tagName === 'string' ? typed.tagName.slice(0, 80) : 'element'
  const selector = typeof typed.selector === 'string' ? typed.selector.slice(0, 400) : tagName.toLowerCase()
  const label = typeof typed.label === 'string' ? typed.label.slice(0, 160) : selector
  const text = typeof typed.text === 'string' ? typed.text.slice(0, 500) : ''
  const imageUrl = typeof typed.imageUrl === 'string' && typed.imageUrl.startsWith('data:image/') ? typed.imageUrl.slice(0, 180_000) : ''
  return {
    tagName,
    selector,
    label,
    text,
    ...(imageUrl ? { imageUrl } : {}),
    ...(typeof typed.id === 'string' && typed.id ? { id: typed.id.slice(0, 120) } : {}),
    ...(typeof typed.className === 'string' && typed.className ? { className: typed.className.slice(0, 300) } : {}),
    ...(typeof typed.role === 'string' && typed.role ? { role: typed.role.slice(0, 80) } : {}),
    ...(typeof typed.ariaLabel === 'string' && typed.ariaLabel ? { ariaLabel: typed.ariaLabel.slice(0, 160) } : {}),
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
  }
}

export function parseAppFrameCanvasScreenshotMessage(
  raw: unknown,
  expectedBoxId: string,
  expectedBridgeToken: string,
): AppFrameCanvasScreenshot | null {
  const message = parseEnvelope(raw, 'frame_to_host')
  if (!message || message.type !== 'canvas_screenshot') return null
  if (message.boxId !== expectedBoxId) return null
  if (message.bridgeToken !== expectedBridgeToken) return null
  const typed = raw as Partial<AppFrameCanvasScreenshot>
  const requestId = typeof typed.requestId === 'string' ? typed.requestId.trim() : ''
  if (!requestId) return null
  const imageUrl = typeof typed.imageUrl === 'string' && typed.imageUrl.startsWith('data:image/') ? typed.imageUrl.slice(0, 500_000) : ''
  const error = typeof typed.error === 'string' ? typed.error.slice(0, 500) : ''
  return {
    requestId,
    ok: typed.ok === true && !!imageUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(error ? { error } : {}),
  }
}

function parseEnvelope(raw: unknown, direction: AppFrameDirection): (AppFrameEnvelope & { type: string; boxId: string; bridgeToken: string }) | null {
  if (!raw || typeof raw !== 'object') return null
  const message = raw as AppFrameEnvelope
  if (message.protocol !== APP_FRAME_PROTOCOL) return null
  if (message.direction !== direction) return null
  if (typeof message.type !== 'string') return null
  if (typeof message.boxId !== 'string' || !message.boxId.trim()) return null
  if (typeof message.bridgeToken !== 'string' || !message.bridgeToken.trim()) return null
  return { ...message, type: message.type, boxId: message.boxId, bridgeToken: message.bridgeToken }
}

function scriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16))
}

function bridgeScript(box: AppFrameBridgeBox, bridgeToken: string): string {
  const boxId = scriptJSON(box.boxId)
  const serviceHttpBaseUrl = scriptJSON(box.serviceHttpBaseUrl ?? '')
  const serviceRequestToken = scriptJSON(box.serviceRequestToken ?? '')
  const serviceWsBaseUrl = scriptJSON(box.serviceWsBaseUrl ?? '')
  const token = scriptJSON(bridgeToken)
  const state = scriptJSON(box.state ?? {})
  const version = scriptJSON(box.version)
  const protocol = scriptJSON(APP_FRAME_PROTOCOL)
  return `<script>
(() => {
  const protocol = ${protocol};
  const boxId = ${boxId};
  const serviceHttpBaseUrl = ${serviceHttpBaseUrl};
  const serviceRequestToken = ${serviceRequestToken};
  const serviceWsBaseUrl = ${serviceWsBaseUrl};
  const bridgeToken = ${token};
  let currentState = ${state};
  let stateVersion = ${version};
  let actionSeq = 0;
  let inspectActive = false;
  let inspectLocked = false;
  let inspectOverlay = null;
  const stateListeners = new Set();
  const pendingActions = new Map();
  const notifyListener = (listener) => { try { listener(currentState); } catch {} };
  const notifyState = () => { for (const listener of Array.from(stateListeners)) notifyListener(listener); };
  const post = (type, payload) => {
    window.parent.postMessage({ protocol, direction: 'frame_to_host', type, boxId, bridgeToken, stateVersion, ...payload }, '*');
  };
  const postDiagnostic = (level, message, stack) => {
    post('diagnostic', { diagnostic: { level, message: String(message || '').slice(0, ${maxAppFrameDiagnosticBytes}), stack: stack ? String(stack).slice(0, ${maxAppFrameDiagnosticBytes}) : undefined } });
  };
  const ensureInspectOverlay = () => {
    if (inspectOverlay) return inspectOverlay;
    inspectOverlay = document.createElement('div');
    inspectOverlay.setAttribute('data-cirrus-inspect-overlay', 'true');
    inspectOverlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #1683ff;background:rgba(22,131,255,.12);border-radius:6px;display:none;';
    document.documentElement.appendChild(inspectOverlay);
    return inspectOverlay;
  };
  const hideInspectOverlay = () => {
    if (inspectOverlay) inspectOverlay.style.display = 'none';
  };
  const showInspectOverlay = (element) => {
    if (!element || !(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const overlay = ensureInspectOverlay();
    overlay.style.display = 'block';
    overlay.style.left = Math.max(0, rect.left) + 'px';
    overlay.style.top = Math.max(0, rect.top) + 'px';
    overlay.style.width = Math.max(0, rect.width) + 'px';
    overlay.style.height = Math.max(0, rect.height) + 'px';
  };
  const selectorPart = (element) => {
    const esc = (value) => window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    const tag = element.tagName ? element.tagName.toLowerCase() : 'element';
    if (element.id) return tag + '#' + esc(element.id);
    const classes = typeof element.className === 'string'
      ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((name) => '.' + esc(name)).join('')
      : '';
    let index = 1;
    let prev = element.previousElementSibling;
    while (prev) {
      if (prev.tagName === element.tagName) index += 1;
      prev = prev.previousElementSibling;
    }
    return tag + classes + ':nth-of-type(' + index + ')';
  };
  const selectorFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 5) {
      parts.unshift(selectorPart(current));
      if (current.id) break;
      current = current.parentElement;
    }
    return parts.join(' > ') || selectorPart(element);
  };
  const textFor = (element) => {
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value || element.placeholder || ''
      : element.textContent || '';
    return value.replace(/\\s+/g, ' ').trim().slice(0, 500);
  };
  const copyComputedStyles = (source, target) => {
    if (!(source instanceof Element) || !(target instanceof Element)) return;
    const computed = window.getComputedStyle(source);
    for (let i = 0; i < computed.length; i += 1) {
      const name = computed[i];
      target.style.setProperty(name, computed.getPropertyValue(name), computed.getPropertyPriority(name));
    }
    if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) target.setAttribute('value', source.value);
    if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) target.textContent = source.value;
    if (source instanceof HTMLCanvasElement && target instanceof HTMLCanvasElement) {
      try {
        const dataUrl = source.toDataURL('image/png');
        const image = document.createElement('img');
        image.src = dataUrl;
        image.style.cssText = target.style.cssText;
        target.replaceWith(image);
        target = image;
      } catch {}
    }
    const sourceChildren = Array.from(source.children);
    const targetChildren = Array.from(target.children);
    for (let i = 0; i < sourceChildren.length; i += 1) copyComputedStyles(sourceChildren[i], targetChildren[i]);
  };
  const elementBackground = (element) => {
    let current = element;
    while (current && current instanceof Element) {
      const color = window.getComputedStyle(current).backgroundColor;
      if (color && color !== 'transparent' && !/^rgba\\([^,]+,[^,]+,[^,]+,\\s*0\\s*\\)$/.test(color)) return color;
      current = current.parentElement;
    }
    return '#ffffff';
  };
  const svgToPngDataUrl = (svg, width, height, scale) => new Promise((resolve) => {
    const image = new Image();
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve('');
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve('');
      }
    };
    image.onerror = () => resolve('');
    image.src = svgUrl;
  });
  const captureElementImage = async (element) => {
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return '';
      const maxWidth = 360;
      const maxHeight = 180;
      const width = Math.ceil(Math.min(rect.width, 720));
      const height = Math.ceil(Math.min(rect.height, 360));
      const renderScale = Math.min(2, maxWidth / Math.max(width, 1), maxHeight / Math.max(height, 1));
      const clone = element.cloneNode(true);
      copyComputedStyles(element, clone);
      const wrapper = document.createElement('div');
      wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      wrapper.style.cssText = 'box-sizing:border-box;margin:0;width:' + width + 'px;height:' + height + 'px;overflow:hidden;background:' + elementBackground(element) + ';';
      wrapper.appendChild(clone);
      const serialized = new XMLSerializer().serializeToString(wrapper);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '"><foreignObject x="0" y="0" width="100%" height="100%">' + serialized + '</foreignObject></svg>';
      return await svgToPngDataUrl(svg, width, height, Math.max(1, renderScale));
    } catch {
      return '';
    }
  };
  const selectionFor = async (element) => {
    const rect = element.getBoundingClientRect();
    const tagName = element.tagName ? element.tagName.toLowerCase() : 'element';
    const id = element.id || '';
    const className = typeof element.className === 'string' ? element.className : '';
    const role = element.getAttribute('role') || '';
    const ariaLabel = element.getAttribute('aria-label') || '';
    const text = textFor(element);
    const selector = selectorFor(element);
    const label = ariaLabel || text || selector;
    const imageUrl = await captureElementImage(element);
    return {
      tagName,
      selector,
      label,
      text,
      imageUrl,
      id,
      className,
      role,
      ariaLabel,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  };
  const inspectTarget = (event) => {
    const target = event.target;
    if (!target || !(target instanceof Element)) return null;
    if (target.closest('[data-cirrus-inspect-overlay]')) return null;
    return target;
  };
  document.addEventListener('pointermove', (event) => {
    if (!inspectActive || inspectLocked) return;
    const target = inspectTarget(event);
    if (target) showInspectOverlay(target);
  }, true);
  document.addEventListener('pointerleave', () => {
    if (inspectActive && !inspectLocked) hideInspectOverlay();
  }, true);
  document.addEventListener('click', async (event) => {
    if (!inspectActive) return;
    const target = inspectTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    inspectLocked = true;
    inspectActive = false;
    showInspectOverlay(target);
    post('inspect_selection', { selection: await selectionFor(target) });
  }, true);
  const diagnosticArgText = (arg) => {
    if (typeof arg === 'string') return arg;
    try { const j = JSON.stringify(arg); return j === undefined ? String(arg) : j; } catch { return '[unserializable]'; }
  };
  const nextRequestId = () => { actionSeq += 1; return String(Date.now()) + '-' + String(actionSeq); };
  const finishAction = (requestId, result) => {
    const pending = pendingActions.get(requestId);
    if (!pending) return;
    pendingActions.delete(requestId);
    window.clearTimeout(pending.timeout);
    pending.resolve(result);
  };
  const postAction = (actionId, payload) => {
    const requestId = nextRequestId();
    const normalizedActionId = String(actionId || '').trim();
    if (!normalizedActionId) {
      return Promise.resolve({ ok: false, status: 'validation_failed', code: 'missing_action_id', message: 'App frame action id is required.', retryable: false, actionId: '' });
    }
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingActions.delete(requestId);
        postDiagnostic('warn', 'App frame action timed out: ' + normalizedActionId);
        resolve({ ok: false, status: 'timeout', code: 'action_timeout', message: 'App frame action timed out.', retryable: true, actionId: normalizedActionId });
      }, 120000);
      pendingActions.set(requestId, { resolve, timeout });
      post('action', { requestId, actionId: normalizedActionId, payload: payload ?? {} });
    });
  };
  const api = {
    getState() { return currentState; },
    getStateVersion() { return stateVersion; },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      stateListeners.add(listener);
      notifyListener(listener);
      return () => { stateListeners.delete(listener); };
    },
    action(actionId, payload) { return postAction(actionId, payload); },
    openLink(href) { post('open_link', { href: String(href || '') }); },
    ready() { post('ready', {}); },
    resize() { post('resize', {}); },
  };
  const originalWarn = console.warn ? console.warn.bind(console) : null;
  const originalError = console.error ? console.error.bind(console) : null;
  console.warn = (...args) => { if (originalWarn) originalWarn(...args); postDiagnostic('warn', args.map(diagnosticArgText).join(' ')); };
  console.error = (...args) => { if (originalError) originalError(...args); postDiagnostic('error', args.map(diagnosticArgText).join(' ')); };
  window.addEventListener('error', (event) => { postDiagnostic('error', event.message || 'App frame runtime error.', event.error && event.error.stack); });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    postDiagnostic('error', reason && reason.message ? reason.message : String(reason || 'Unhandled app frame rejection.'), reason && reason.stack);
  });
  Object.defineProperty(window, 'CirrusUI', { value: api, configurable: true });
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.protocol !== protocol || data.direction !== 'host_to_frame' || data.boxId !== boxId || data.bridgeToken !== bridgeToken) return;
    if (data.type === 'state') {
      currentState = data.state ?? {};
      stateVersion = data.stateVersion ?? stateVersion;
      notifyState();
      return;
    }
    if (data.type === 'action_result' && typeof data.requestId === 'string') {
      finishAction(data.requestId, {
        ok: data.ok === true,
        status: typeof data.status === 'string' ? data.status : (data.ok === true ? 'ok' : 'error'),
        code: typeof data.code === 'string' ? data.code : (data.ok === true ? 'ok' : 'error'),
        message: typeof data.message === 'string' ? data.message : (data.ok === true ? 'Action completed.' : 'App frame action failed.'),
        retryable: data.retryable === true,
        actionId: typeof data.actionId === 'string' ? data.actionId : '',
        stateVersion: typeof data.stateVersion === 'number' ? data.stateVersion : undefined,
      });
      return;
    }
    if (data.type === 'inspect') {
      inspectActive = data.enabled === true;
      if (inspectActive) inspectLocked = false;
      if (data.clear === true) {
        inspectLocked = false;
        hideInspectOverlay();
      }
      return;
    }
    if (data.type === 'capture_screenshot' && typeof data.requestId === 'string') {
      (async () => {
        try {
          const target = document.body || document.documentElement;
          const imageUrl = target ? await captureElementImage(target) : '';
          post('canvas_screenshot', {
            requestId: data.requestId,
            ok: !!imageUrl,
            imageUrl,
            error: imageUrl ? undefined : 'Unable to capture canvas screenshot.',
          });
        } catch (error) {
          post('canvas_screenshot', {
            requestId: data.requestId,
            ok: false,
            error: String(error && error.message ? error.message : error),
          });
        }
      })();
    }
  });
})();
</script>`
}

function cspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${appFrameCSP}">`
}

function payloadWithinLimit(payload: unknown): boolean {
  try {
    return new Blob([JSON.stringify(payload ?? {})]).size <= maxAppFramePayloadBytes
  } catch {
    return false
  }
}

function sanitizeActionPayload(payload: unknown): Record<string, unknown> | null {
  if (payload == null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) return null
  return { ...(payload as Record<string, unknown>) }
}
