// Cirrus platform-tools MCP server, run inside the runtime sandbox and registered
// with native CLIs (e.g. opencode) so their model can call our platform tools:
// post_message, send_image, ask_user, and cron management. It is a minimal
// newline-delimited JSON-RPC (MCP stdio) server. Side-effects are RECORDED to an
// events JSONL file (path + platform context come from a ctx file the adapter
// writes per invoke); the host adapter reads/streams them after/while opencode runs.
const fs = require('fs')

const CTX_PATH = process.env.CIRRUS_MCP_CTX || '/home/user/.cirrus-mcp-ctx.json'
let ctx = { eventsPath: '/tmp/cirrus-events.jsonl', agents: [], cronJobs: [] }
try {
  ctx = Object.assign(ctx, JSON.parse(fs.readFileSync(CTX_PATH, 'utf8')))
} catch (e) {}

const rec = (o) => {
  try {
    fs.appendFileSync(ctx.eventsPath, JSON.stringify(o) + '\n')
  } catch (e) {}
}

function validCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  return parts.every((field, i) =>
    field.split(',').every((tok) => {
      const m = tok.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
      if (!m) return false
      if (m[1] === '*') return true
      const [lo, hi] = m[1].includes('-') ? m[1].split('-').map(Number) : [Number(m[1]), Number(m[1])]
      return lo <= hi && lo >= ranges[i][0] && hi <= ranges[i][1]
    }),
  )
}

const TOOLS = [
  { name: 'post_message', description: 'Send a chat message to the user RIGHT NOW (a progress update or intermediate finding) and keep working. Use it during longer tasks so the user sees progress.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'send_image', description: 'Send an image to the user. url must be an http(s) or data:image URL.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, alt: { type: 'string' } }, required: ['url'] } },
  { name: 'ask_user', description: 'Ask the user a question with optional quick-reply buttons, then STOP and wait for their reply.', inputSchema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } }, allowFreeText: { type: 'boolean' } }, required: ['question'] } },
  { name: 'list_cron_jobs', description: "List this runtime's scheduled tasks (cron jobs).", inputSchema: { type: 'object', properties: {} } },
  { name: 'create_cron_job', description: 'Schedule a recurring task: on the schedule, message is sent to a runtime agent. schedule is a 5-field cron expression. targetAgentKey is optional.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, schedule: { type: 'string' }, message: { type: 'string' }, targetAgentKey: { type: 'string' } }, required: ['schedule', 'message'] } },
  { name: 'update_cron_job', description: 'Update a scheduled task by id. Include only fields to change; enabled=false pauses it.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, schedule: { type: 'string' }, message: { type: 'string' }, targetAgentKey: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['id'] } },
  { name: 'delete_cron_job', description: 'Delete a scheduled task by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
]

function callTool(name, args) {
  args = args || {}
  if (name === 'post_message') {
    const text = String(args.text || '').trim()
    if (!text) return { error: 'text is required' }
    rec({ kind: 'post', text })
    return { ok: true, note: 'Sent to the user. Keep working; do not repeat this in your final reply.' }
  }
  if (name === 'send_image') {
    const url = String(args.url || '')
    if (!/^(https?:\/\/|data:image\/)/i.test(url)) return { error: 'url must be an http(s) or data:image URL' }
    rec({ kind: 'image', url, alt: args.alt ? String(args.alt) : undefined })
    return { ok: true }
  }
  if (name === 'ask_user') {
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => ({ label: String((o && (o.label != null ? o.label : o.value)) || '').trim(), value: String((o && (o.value != null ? o.value : o.label)) || '') }))
      .filter((o) => o.label)
    rec({ kind: 'ask', question: String(args.question || ''), options, allowFreeText: !!args.allowFreeText })
    return { ok: true, note: 'Shown to the user with buttons. Stop now and wait for their reply.' }
  }
  if (name === 'list_cron_jobs') return { ok: true, jobs: ctx.cronJobs || [] }
  if (name === 'create_cron_job') {
    const schedule = String(args.schedule || '')
    if (!validCron(schedule)) return { error: 'invalid cron schedule "' + schedule + '"' }
    if (!String(args.message || '').trim()) return { error: 'message is required' }
    const key = args.targetAgentKey ? String(args.targetAgentKey) : null
    if (key && !(ctx.agents || []).some((a) => a.key === key)) return { error: 'unknown agent key "' + key + '"' }
    rec({ kind: 'cron', op: 'create', name: String(args.name || ''), schedule, message: String(args.message || ''), targetAgentKey: key })
    return { ok: true, note: 'Will be created when the turn finishes.' }
  }
  if (name === 'update_cron_job') {
    if (!args.id) return { error: 'id is required' }
    rec({ kind: 'cron', op: 'update', id: String(args.id), patch: { name: args.name, schedule: args.schedule, message: args.message, targetAgentKey: args.targetAgentKey, enabled: args.enabled } })
    return { ok: true }
  }
  if (name === 'delete_cron_job') {
    if (!args.id) return { error: 'id is required' }
    rec({ kind: 'cron', op: 'delete', id: String(args.id) })
    return { ok: true }
  }
  return { error: 'unknown tool ' + name }
}

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n')
}

function handle(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cirrus-platform', version: '1.0.0' } } })
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } })
  } else if (m.method === 'tools/call') {
    const r = callTool(m.params && m.params.name, m.params && m.params.arguments)
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !!r.error } })
  } else if (m.method && m.method.indexOf('notifications/') === 0) {
    // notifications: no response
  } else if (m.id != null) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } })
  }
}

let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch (e) {
      continue
    }
    handle(m)
  }
})
