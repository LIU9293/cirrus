import { config } from './config.ts'
import { runInRuntimeSandbox } from './sandbox/runtimeSandbox.ts'
import type { ChatTurn } from './agent/developerAgent.ts'
import type { RuntimeMessageUi } from './agent/skillTools.ts'
import { createCronJob, deleteCronJob, listCronJobs, updateCronJob } from './cronStore.ts'
import type { CronJob, DeveloperChatActivity, RuntimeAgentRef, RuntimeAgentModelConfig } from '../../shared/protocol.ts'

/** Context the host gives the in-sandbox community adapter so it can use platform
 *  tools (cron management, ask_user, send_image) for the right runtime. */
export interface CommunityPlatformContext {
  runtimeId: string
  ownerId: string
  agents: { key: string; name: string }[]
}

/** What the adapter records and the host applies after invoke() returns. */
interface CronRequest {
  op: 'create' | 'update' | 'delete'
  id?: string
  name?: string
  schedule?: string
  message?: string
  targetAgentKey?: string | null
  patch?: { name?: string; schedule?: string; message?: string; targetAgentKey?: string | null; enabled?: boolean }
}

export interface CommunityAgentDefinition {
  key: string
  name: string
  description: string
  category: 'framework' | 'browser' | 'core' | 'coding'
  /** Whether the agent gets sandbox filesystem + shell tools (run_command, etc.). */
  shell: boolean
  /** The agent's real upstream CLI. We install it into the sandbox (step 1); a
   *  later step will drive it instead of the platform-model adapter. `risky` marks
   *  install scripts from less-certain sources (curl|bash) worth reviewing. */
  nativeCli?: { install: string; bin: string; versionCmd?: string; risky?: boolean }
  adapter: 'platform-llm-adapter'
  version: string
  defaultModelConfig: RuntimeAgentModelConfig
  capabilities: string[]
  systemPrompt: string
  installNotes: string[]
}

const platformModel = (): RuntimeAgentModelConfig => ({
  mode: 'platform',
  platformModel: config.model,
  authStatus: 'authorized',
})

const subscriptionSkeleton = (provider: string): RuntimeAgentModelConfig => ({
  mode: 'platform',
  platformModel: config.model,
  subscriptionProvider: provider,
  authStatus: 'not_configured',
})

export const COMMUNITY_AGENT_REGISTRY: Record<string, CommunityAgentDefinition> = {
  'community:Hermes': {
    key: 'community:Hermes',
    name: 'Hermes',
    description: 'Multi-agent orchestration framework for complex, long-running workflows.',
    category: 'framework',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: platformModel(),
    nativeCli: { install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', bin: 'hermes', risky: true },
    capabilities: ['multi-agent coordination', 'workflow planning', 'handoff routing', 'status synthesis'],
    systemPrompt:
      'You are Hermes, a runtime coordination agent. Focus on decomposing requests, assigning work to available agents, and explaining orchestration decisions clearly.',
    installNotes: ['Installed as a Cirrus platform LLM adapter. Native Hermes package support can replace this adapter later.'],
  },
  'community:OpenClaw': {
    key: 'community:OpenClaw',
    name: 'OpenClaw',
    description: 'Open web-browsing automation agent that drives real sites.',
    category: 'framework',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: platformModel(),
    nativeCli: { install: "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash", bin: 'clawbot', risky: true },
    capabilities: ['browser task planning', 'website automation planning', 'DOM/action reasoning'],
    systemPrompt:
      'You are OpenClaw, a web automation agent. Help plan browser actions and explain safe website automation steps. Do not claim to click external sites unless a browser tool is explicitly connected.',
    installNotes: ['Installed as a Cirrus platform LLM adapter. Browser-control tools will be wired as explicit capabilities later.'],
  },
  'community:Pi Agent': {
    key: 'community:Pi Agent',
    name: 'Pi Agent',
    description: 'Lightweight, framework-agnostic tool-calling agent core.',
    category: 'core',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: platformModel(),
    nativeCli: { install: 'npm i -g @mariozechner/pi-coding-agent', bin: 'pi' },
    capabilities: ['tool calling patterns', 'agent loop design', 'structured reasoning'],
    systemPrompt:
      'You are Pi Agent, a compact tool-calling runtime agent. Emphasize structured tool contracts, minimal loops, and practical agent execution.',
    installNotes: ['Installed as a Cirrus platform LLM adapter using the current platform model.'],
  },
  'community:Claude Code': {
    key: 'community:Claude Code',
    name: 'Claude Code',
    description: "Anthropic's agentic coding assistant for the terminal and IDE.",
    category: 'coding',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: subscriptionSkeleton('claude_code'),
    nativeCli: { install: 'npm i -g @anthropic-ai/claude-code', bin: 'claude' },
    capabilities: ['codebase reasoning', 'patch planning', 'terminal workflow guidance'],
    systemPrompt:
      'You are Claude Code in a Cirrus runtime adapter. Help with software-engineering tasks, code navigation, patch plans, and terminal-oriented workflows. Mention when native subscription auth is not connected.',
    installNotes: ['Native Claude Code subscription auth is a skeleton; current adapter uses the Cirrus platform model.'],
  },
  'community:Codex': {
    key: 'community:Codex',
    name: 'Codex',
    description: "OpenAI's autonomous software-engineering agent.",
    category: 'coding',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: subscriptionSkeleton('codex'),
    nativeCli: { install: 'npm i -g @openai/codex', bin: 'codex' },
    capabilities: ['software engineering', 'repo inspection', 'implementation planning', 'test strategy'],
    systemPrompt:
      'You are Codex in a Cirrus runtime adapter. Act as a pragmatic software-engineering agent. Mention when native Codex login/subscription auth is not connected.',
    installNotes: ['Native Codex subscription auth is a skeleton; current adapter uses the Cirrus platform model.'],
  },
  'community:OpenCode': {
    key: 'community:OpenCode',
    name: 'OpenCode',
    description: 'Open-source AI coding agent you can run anywhere.',
    category: 'coding',
    shell: true,
    adapter: 'platform-llm-adapter',
    version: '0.6.0',
    defaultModelConfig: subscriptionSkeleton('opencode'),
    nativeCli: { install: 'npm i -g opencode-ai', bin: 'opencode' },
    capabilities: ['coding workflows', 'CLI-oriented engineering guidance', 'open-source agent operations'],
    systemPrompt:
      'You are OpenCode in a Cirrus runtime adapter. Help with coding tasks and CLI-oriented development. Mention when native OpenCode auth/install is not connected.',
    installNotes: ['Native OpenCode install/auth is a skeleton; current adapter uses the Cirrus platform model.'],
  },
}

export function communityAgentDefinition(key: string): CommunityAgentDefinition | null {
  return COMMUNITY_AGENT_REGISTRY[key] ?? null
}

/** A community agent needs (re)installation when it isn't ready, or when the
 *  registry adapter version has moved past what's installed (so capability
 *  changes — shell, streaming, … — reach already-provisioned runtimes). */
export function communityAgentNeedsInstall(agent: RuntimeAgentRef): boolean {
  if (agent.source !== 'community') return false
  if (agent.installation?.status !== 'ready') return true
  const registryVersion = communityAgentDefinition(agent.key)?.version
  return !!registryVersion && agent.installation?.version !== registryVersion
}

export function defaultRuntimeAgentModelConfig(agent: Pick<RuntimeAgentRef, 'key' | 'source'>): RuntimeAgentModelConfig {
  if (agent.source === 'community') return communityAgentDefinition(agent.key)?.defaultModelConfig ?? platformModel()
  return platformModel()
}

export function normalizeRuntimeAgentRef(agent: RuntimeAgentRef): RuntimeAgentRef {
  const definition = agent.source === 'community' ? communityAgentDefinition(agent.key) : null
  return {
    ...agent,
    name: agent.name || definition?.name || agent.key,
    modelConfig: agent.modelConfig ?? defaultRuntimeAgentModelConfig(agent),
    capabilities: agent.capabilities ?? definition?.capabilities ?? agent.capabilities,
    installation:
      agent.installation ??
      (agent.source === 'community'
        ? { status: 'not_installed', adapter: definition?.adapter ?? 'unknown', version: definition?.version }
        : { status: 'ready', adapter: 'cirrus-own-agent', version: '0.1.0' }),
  }
}

function agentDirName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function invokeSourceFor(definition: CommunityAgentDefinition): string {
  return `
export async function invoke(payload) {
  const { model, agent, history } = payload;
  const shell = agent.shell === true;
  const baseSystem = [
    agent.systemPrompt,
    'You are running inside a Cirrus runtime and can act on the platform through these tools:',
    '- ask_user(question, options:[{label,value}], allowFreeText): ask the user and show quick-reply buttons. After calling it, STOP and wait for their reply.',
    '- post_message(text): proactively send a chat message to the user RIGHT NOW and KEEP WORKING (unlike ask_user, it does NOT end your turn). Use it for progress updates and intermediate findings during a long task; each call appears as its own chat message. Your final answer is whatever text you return at the end.',
    '- send_image(url, alt): send an image to the user (http(s) or data:image URL).',
    '- list_cron_jobs(): list this runtime\\'s scheduled tasks.',
    '- create_cron_job(name, schedule, message, targetAgentKey?): schedule a recurring message to a runtime agent. schedule is a 5-field cron expression (e.g. "0 9 * * 1-5" = weekdays 09:00, server timezone).',
    '- update_cron_job(id, ...fields), delete_cron_job(id): edit/remove a scheduled task.',
    shell ? [
      'You also run inside this runtime\\'s isolated E2B sandbox with full filesystem and shell access.',
      'Use /home/user/cirrus/workspace as the default workspace for repositories.',
      'You have file and shell tools under /home/user/cirrus.',
      'Use read_file/write_file/list_dir/run_command to inspect, edit, run commands, use git, push branches, and verify work.',
      'You HAVE outbound internet access through the sandbox: use run_command with curl/wget to fetch URLs, call HTTP APIs, clone repos, and install packages (npm/pip). Do not claim you cannot go online — when you need web data, fetch it with run_command.',
      'When the user asks you to make a change, execute it in the sandbox rather than only describing the commands.',
    ].join('\\n') : '',
  ].filter(Boolean).join('\\n');
  const messages = [
    { role: 'system', content: baseSystem },
    ...(history || []).map((turn) => ({ role: turn.role, content: turn.content }))
  ];
  // Accumulates out-of-band UI (ask_user buttons, send_image) and deferred cron
  // mutations; the host applies/propagates these after invoke() returns.
  const acc = { ui: {}, cronRequests: [], posts: [] };
  const tools = [...platformTools(), ...(shell ? codingTools() : [])];
  const done = (msg) => ({ ok: true, reply: msg, ui: acc.ui, cronRequests: acc.cronRequests, posts: acc.posts });
  // Stream events to stdout so the host can forward them live. Each event is ONE
  // line: __CIRRUS_EVENT__<json>. The wrapper still prints the final result object
  // as the last (non-event) stdout line. JSON.stringify keeps each event single-line.
  const emit = (k, t) => { try { console.log('__CIRRUS_EVENT__' + JSON.stringify({ k: k, t: t })); } catch (e) {} };
  acc.emit = emit;
  let fullText = '';

  for (let i = 0; i < (shell ? 14 : 6); i += 1) {
    const turn = await streamChatCompletion(model, messages, tools, shell ? 1800 : 1000, function (d) { fullText += d; emit('delta', d); });
    if (turn.error) return { ok: false, error: String(turn.error).slice(0, 1200) };
    const toolCalls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
    messages.push({ role: 'assistant', content: turn.content ?? '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) return done(fullText);
    let asked = false;
    for (const call of toolCalls) {
      const result = await runTool(call.function?.name, call.function?.arguments, payload, acc);
      if (call.function?.name === 'ask_user') asked = true;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
    // ask_user ends the turn so the user can respond.
    if (asked) return done(fullText);
  }
  return done(fullText || 'Stopped after the maximum tool iterations.');
}

// Streaming chat completion. Calls onDelta(text) for each content token as it
// arrives and reconstructs tool_calls from the SSE deltas. Falls back to a single
// JSON read if the endpoint doesn't return a streamable body.
async function streamChatCompletion(model, messages, tools, maxTokens, onDelta) {
  let res;
  try {
    res = await fetch(model.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + model.apiKey },
      body: JSON.stringify({ model: model.id, messages, tools, tool_choice: 'auto', max_completion_tokens: maxTokens, stream: true })
    });
  } catch (e) { return { error: String(e && e.message || e) }; }
  if (!res.ok) { let t = ''; try { t = await res.text(); } catch (e) {} return { error: 'HTTP ' + res.status + ' ' + t }; }
  if (!res.body || !res.body.getReader) {
    const data = await res.json();
    const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
    if (typeof msg.content === 'string' && msg.content) onDelta(msg.content);
    return { content: msg.content || '', toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [] };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const toolMap = {};
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.slice(0, 5) !== 'data:') continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt; try { evt = JSON.parse(payload); } catch (e) { continue; }
      const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; onDelta(delta.content); }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          const cur = toolMap[idx] || (toolMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
        }
      }
    }
  }
  const toolCalls = Object.keys(toolMap).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return toolMap[k]; }).filter(function (c) { return c.function.name; });
  return { content: content, toolCalls: toolCalls };
}

function platformTools() {
  const obj = (properties) => ({ type: 'object', properties });
  return [
    { type: 'function', function: { name: 'ask_user', description: 'Ask the user a question and show quick-reply buttons. options is [{label, value}]; value is sent when tapped (defaults to label). Set allowFreeText to also allow typing. After calling, STOP and wait for the reply.', parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } }, allowFreeText: { type: 'boolean' } }) } },
    { type: 'function', function: { name: 'post_message', description: 'Proactively send a chat message to the user now and keep working (does NOT end your turn). Use for progress updates and intermediate findings; each call is its own chat message.', parameters: obj({ text: { type: 'string' } }) } },
    { type: 'function', function: { name: 'send_image', description: 'Send an image to the user. url is an http(s) or data:image URL; alt is an optional caption.', parameters: obj({ url: { type: 'string' }, alt: { type: 'string' } }) } },
    { type: 'function', function: { name: 'list_cron_jobs', description: 'List the scheduled tasks (cron jobs) in this runtime.', parameters: obj({}) } },
    { type: 'function', function: { name: 'create_cron_job', description: 'Schedule a recurring task: on the cron schedule, message is sent to a runtime agent. schedule is a 5-field cron expression. targetAgentKey is optional.', parameters: obj({ name: { type: 'string' }, schedule: { type: 'string' }, message: { type: 'string' }, targetAgentKey: { type: 'string' } }) } },
    { type: 'function', function: { name: 'update_cron_job', description: 'Update a scheduled task by id. Include only fields to change; enabled=false pauses it.', parameters: obj({ id: { type: 'string' }, name: { type: 'string' }, schedule: { type: 'string' }, message: { type: 'string' }, targetAgentKey: { type: 'string' }, enabled: { type: 'boolean' } }) } },
    { type: 'function', function: { name: 'delete_cron_job', description: 'Delete a scheduled task by id.', parameters: obj({ id: { type: 'string' } }) } },
  ];
}

function validCron(expr) {
  const parts = String(expr || '').trim().split(/\\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  return parts.every((field, i) => field.split(',').every((tok) => {
    const m = tok.match(/^(\\*|\\d+(?:-\\d+)?)(?:\\/(\\d+))?$/);
    if (!m) return false;
    if (m[1] === '*') return true;
    const [lo, hi] = m[1].includes('-') ? m[1].split('-').map(Number) : [Number(m[1]), Number(m[1])];
    return lo <= hi && lo >= ranges[i][0] && hi <= ranges[i][1];
  }));
}

function codingTools() {
  const obj = (properties) => ({ type: 'object', properties });
  return [
    { type: 'function', function: { name: 'list_dir', description: 'List files under /home/user/cirrus. Use /home/user/cirrus/workspace for repository workspaces.', parameters: obj({ path: { type: 'string' } }) } },
    { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file under /home/user/cirrus.', parameters: obj({ path: { type: 'string' } }) } },
    { type: 'function', function: { name: 'write_file', description: 'Write a UTF-8 text file under /home/user/cirrus, creating parent directories.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }) } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command inside /home/user/cirrus or a subdirectory. Use this for development commands, git operations, tests, builds, and verification.', parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' } }) } },
  ];
}

async function runTool(name, rawArgs, payload, acc) {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const platform = (payload && payload.platform) || {};

  // ── Platform tools: recorded here, applied/propagated by the host ──
  if (name === 'ask_user') {
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => ({ label: String((o && (o.label ?? o.value)) || '').trim(), value: String((o && (o.value ?? o.label)) || '') }))
      .filter((o) => o.label);
    acc.ui.choices = options;
    acc.ui.allowFreeText = !!args.allowFreeText;
    if (args.question) acc.ui.question = String(args.question);
    return { ok: true, presented: { question: args.question, options, allowFreeText: !!args.allowFreeText }, note: 'Shown to the user. Stop and wait for their reply.' };
  }
  if (name === 'post_message') {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, error: 'text is required' };
    acc.posts.push(text);
    if (acc.emit) acc.emit('post', text);
    return { ok: true, posted: true, note: 'Sent to the user. Keep working — do not repeat this in your final reply.' };
  }
  if (name === 'send_image') {
    const url = String(args.url || '');
    if (!/^(https?:\\/\\/|data:image\\/)/i.test(url)) return { ok: false, error: 'url must be an http(s) or data:image URL' };
    acc.ui.images = [...(acc.ui.images || []), { url, alt: args.alt ? String(args.alt) : undefined }];
    return { ok: true, sent: { url } };
  }
  if (name === 'list_cron_jobs') return { ok: true, jobs: platform.cronJobs || [] };
  if (name === 'create_cron_job') {
    const schedule = String(args.schedule || '');
    if (!validCron(schedule)) return { ok: false, error: 'Invalid cron schedule "' + schedule + '"' };
    if (!String(args.message || '').trim()) return { ok: false, error: 'message is required' };
    const key = args.targetAgentKey ? String(args.targetAgentKey) : null;
    if (key && !(platform.agents || []).some((a) => a.key === key)) return { ok: false, error: 'Unknown agent key "' + key + '"' };
    acc.cronRequests.push({ op: 'create', name: String(args.name || ''), schedule, message: String(args.message || ''), targetAgentKey: key });
    return { ok: true, scheduled: { name: args.name, schedule, targetAgentKey: key }, note: 'Will be created when you finish.' };
  }
  if (name === 'update_cron_job') {
    if (args.schedule !== undefined && !validCron(String(args.schedule))) return { ok: false, error: 'Invalid cron schedule' };
    acc.cronRequests.push({ op: 'update', id: String(args.id || ''), patch: { name: args.name, schedule: args.schedule, message: args.message, targetAgentKey: args.targetAgentKey, enabled: args.enabled } });
    return { ok: true, updated: String(args.id || '') };
  }
  if (name === 'delete_cron_job') {
    acc.cronRequests.push({ op: 'delete', id: String(args.id || '') });
    return { ok: true, deleted: String(args.id || '') };
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const cp = await import('node:child_process');
  const root = '/home/user/cirrus';
  const safe = (input = '.') => {
    const abs = path.resolve(root, String(input || '.').replace(/^\\/home\\/user\\/cirrus\\/?/, ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes /home/user/cirrus');
    return abs;
  };
  try {
    if (name === 'list_dir') {
      const dir = safe(args.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { ok: true, path: dir, entries: entries.slice(0, 100).map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    if (name === 'read_file') {
      const file = safe(args.path);
      const text = await fs.readFile(file, 'utf8');
      return { ok: true, path: file, content: text.slice(0, 20000), truncated: text.length > 20000 };
    }
    if (name === 'write_file') {
      const file = safe(args.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return { ok: true, path: file, bytes: Buffer.byteLength(String(args.content ?? ''), 'utf8') };
    }
    if (name === 'run_command') {
      const command = String(args.command ?? '').slice(0, 4000);
      if (!command.trim()) return { ok: false, error: 'command is required' };
      const cwd = safe(args.cwd || '.');
      return await new Promise((resolve) => {
        cp.exec(command, {
          cwd,
          timeout: 120000,
          maxBuffer: 60000,
          env: {
            ...process.env,
            HOME: '/home/user',
            PATH: ['/home/user/cirrus/bin', process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':'),
          },
        }, (error, stdout, stderr) => {
          resolve({ ok: !error, cwd, command, stdout: String(stdout || '').slice(0, 30000), stderr: String(stderr || '').slice(0, 12000), error: error ? String(error.message || error) : undefined });
        });
      });
    }
    return { ok: false, error: 'Unknown tool: ' + name };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
`
}

function installCode(definition: CommunityAgentDefinition): string {
  const dir = `/home/user/cirrus/agents/${agentDirName(definition.key)}`
  const manifest = {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    adapter: definition.adapter,
    version: definition.version,
    capabilities: definition.capabilities,
    installNotes: definition.installNotes,
  }
  const invokeSource = invokeSourceFor(definition)
  const cli = definition.nativeCli ?? null
  return [
    `await (async () => {`,
    `  const fs = await import('node:fs/promises');`,
    `  const os = await import('node:os');`,
    `  const cproc = await import('node:child_process');`,
    `  const dir = ${JSON.stringify(dir)};`,
    `  await fs.mkdir(dir, { recursive: true });`,
    `  await fs.writeFile(dir + '/agent.json', ${JSON.stringify(JSON.stringify(manifest, null, 2))});`,
    `  await fs.writeFile(dir + '/invoke.mjs', ${JSON.stringify(invokeSource)});`,
    // Install the agent's real upstream CLI (step 1). Non-fatal: the platform-model
    // adapter still serves the agent, so a CLI install failure just gets recorded.
    `  let cli = null;`,
    `  const spec = ${JSON.stringify(cli)};`,
    `  if (spec) {`,
    `    try {`,
    `      const log = cproc.execSync(spec.install, { encoding: 'utf8', timeout: 240000, stdio: ['ignore','pipe','pipe'], shell: '/bin/bash' });`,
    `      const path = cproc.execSync('command -v ' + spec.bin + ' 2>/dev/null || echo ""', { encoding: 'utf8', shell: '/bin/bash' }).trim();`,
    `      let version = '';`,
    `      if (path) { try { version = cproc.execSync((spec.versionCmd || (spec.bin + ' --version')) + ' 2>&1 | head -1', { encoding: 'utf8', timeout: 20000, shell: '/bin/bash' }).trim(); } catch (e) {} }`,
    `      cli = { installed: !!path, bin: spec.bin, path: path || undefined, version: version || undefined, log: String(log).slice(-240) };`,
    `    } catch (e) {`,
    `      cli = { installed: false, bin: spec.bin, error: String((e && (e.stderr || e.message)) || e).slice(-400) };`,
    `    }`,
    `  }`,
    `  console.log(JSON.stringify({ ok: true, host: os.hostname(), dir, manifest: ${JSON.stringify(manifest)}, cli }));`,
    `})();`,
  ].join('\n')
}

function invokeCode(
  definition: CommunityAgentDefinition,
  history: ChatTurn[],
  platform?: CommunityPlatformContext & { cronJobs: CronJob[] },
): string {
  const dir = `/home/user/cirrus/agents/${agentDirName(definition.key)}`
  const endpoint = config.baseURL.replace(/\/$/, '') + '/chat/completions'
  const payload = {
    model: {
      id: config.model,
      endpoint,
      apiKey: config.apiKey,
    },
    agent: {
      key: definition.key,
      name: definition.name,
      category: definition.category,
      shell: definition.shell,
      systemPrompt: [
        definition.systemPrompt,
        '',
        `Installed adapter: ${definition.adapter} ${definition.version}.`,
        'Model mode: platform. Custom LLM API and subscription authorization configs are available in the runtime schema but not active in this adapter yet.',
        'If asked where you run, say you are invoked through your installed Cirrus community-agent adapter inside the runtime E2B sandbox.',
      ].join('\n'),
    },
    history,
    // Lets the adapter validate agent keys and read current schedules for the
    // platform cron tools. Side-effects are applied host-side after invoke().
    platform: platform
      ? { agents: platform.agents, cronJobs: platform.cronJobs.map((j) => ({ id: j.id, name: j.name, schedule: j.schedule, message: j.message, targetAgentKey: j.targetAgentKey ?? null, enabled: j.enabled })) }
      : { agents: [], cronJobs: [] },
  }
  return [
    `await (async () => {`,
    `  const fs = await import('node:fs/promises');`,
    `  const os = await import('node:os');`,
    `  const dir = ${JSON.stringify(dir)};`,
    `  try {`,
    `    await fs.access(dir + '/agent.json');`,
    `    const mod = await import('file://' + dir + '/invoke.mjs?t=' + Date.now());`,
    `    const result = await mod.invoke(${JSON.stringify(payload)});`,
    `    console.log(JSON.stringify({ ...result, host: os.hostname(), dir }));`,
    `  } catch (err) {`,
    `    console.log(JSON.stringify({ ok: false, host: os.hostname(), dir, error: String(err && err.message || err) }));`,
    `  }`,
    `})();`,
  ].join('\n')
}

export async function installCommunityAgentInSandbox(sandboxId: string, agent: RuntimeAgentRef): Promise<RuntimeAgentRef> {
  const definition = communityAgentDefinition(agent.key)
  const normalized = normalizeRuntimeAgentRef(agent)
  if (!definition) {
    return {
      ...normalized,
      installation: {
        status: 'not_supported',
        adapter: 'unknown',
        error: `No community agent registry entry for ${agent.key}.`,
        logs: [`${new Date().toISOString()} registry entry missing`],
      },
    }
  }
  const startedAt = new Date().toISOString()
  // Generous timeout: writing the adapter is instant, but installing the native
  // CLI (npm global / curl|bash) can take a minute or more.
  const out = await runInRuntimeSandbox(sandboxId, installCode(definition), { timeoutMs: 270_000 })
  if (!out.ok) {
    return {
      ...normalized,
      installation: {
        status: 'failed',
        adapter: definition.adapter,
        version: definition.version,
        error: out.error ?? (out.stderr || 'Install failed.'),
        logs: [`${startedAt} install failed`, out.stderr, out.stdout].filter(Boolean).slice(-8),
      },
    }
  }
  // Parse the install result line for the native-CLI outcome.
  let cli: { installed?: boolean; bin?: string; version?: string; path?: string; error?: string; log?: string } | undefined
  try {
    const last = out.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    cli = (JSON.parse(last) as { cli?: typeof cli }).cli ?? undefined
  } catch {}
  const cliLog = cli
    ? cli.installed
      ? `native CLI ${cli.bin} installed${cli.version ? ` (${cli.version})` : ''}`
      : `native CLI ${cli.bin} NOT installed${cli.error ? `: ${cli.error}` : ''}`
    : undefined
  return {
    ...normalized,
    modelConfig: normalized.modelConfig ?? definition.defaultModelConfig,
    capabilities: definition.capabilities,
    installation: {
      status: 'ready',
      adapter: definition.adapter,
      version: definition.version,
      installedAt: new Date().toISOString(),
      error: null,
      ...(cli ? { nativeCli: { installed: !!cli.installed, bin: cli.bin ?? definition.nativeCli?.bin ?? '', version: cli.version, path: cli.path, error: cli.error } } : {}),
      logs: [`${startedAt} installed ${definition.name} into runtime sandbox`, cliLog].filter(Boolean).slice(-8) as string[],
    },
  }
}

/** Apply the cron mutations the adapter requested, host-side via cronStore.
 *  Returns one activity line per applied request. */
async function applyCronRequests(ctx: CommunityPlatformContext, requests: CronRequest[]): Promise<DeveloperChatActivity[]> {
  const out: DeveloperChatActivity[] = []
  for (const r of requests.slice(0, 20)) {
    try {
      if (r.op === 'create') {
        const job = await createCronJob({
          runtimeId: ctx.runtimeId,
          ownerId: ctx.ownerId,
          name: r.name ?? '',
          schedule: r.schedule ?? '',
          message: r.message ?? '',
          targetAgentKey: r.targetAgentKey ?? null,
        })
        out.push({ kind: 'tool', text: `Scheduled "${job.name || job.schedule}" (${job.schedule})` })
      } else if (r.op === 'update' && r.id) {
        await updateCronJob(r.id, r.patch ?? {})
        out.push({ kind: 'tool', text: `Updated cron job ${r.id}` })
      } else if (r.op === 'delete' && r.id) {
        await deleteCronJob(r.id)
        out.push({ kind: 'tool', text: `Deleted cron job ${r.id}` })
      }
    } catch (err) {
      out.push({ kind: 'error', text: `Cron ${r.op} failed: ${String((err as Error)?.message ?? err)}`, ok: false })
    }
  }
  return out
}

/** Live stream callback: 'delta' = a chunk of the final reply as it generates;
 *  'post' = a standalone post_message the agent sent mid-turn. */
export type CommunityStreamEvent = { kind: 'delta' | 'post'; text: string }

const STREAM_EVENT_PREFIX = '__CIRRUS_EVENT__'

export async function invokeInstalledCommunityAgent(
  sandboxId: string,
  agent: RuntimeAgentRef,
  history: ChatTurn[],
  platform?: CommunityPlatformContext,
  onEvent?: (ev: CommunityStreamEvent) => void,
): Promise<{ ok: boolean; message: string; activities: DeveloperChatActivity[]; ui?: RuntimeMessageUi; posts?: string[] }> {
  const definition = communityAgentDefinition(agent.key)
  const activities: DeveloperChatActivity[] = []
  if (!definition) {
    return {
      ok: false,
      message: `No community agent registry entry for ${agent.name}.`,
      activities: [{ kind: 'error', text: `Community agent ${agent.key} is not supported.`, ok: false }],
    }
  }
  if (agent.installation?.status !== 'ready') {
    activities.push({ kind: 'status', text: `${definition.name} is not installed yet; installing adapter…` })
    const installed = await installCommunityAgentInSandbox(sandboxId, agent)
    if (installed.installation?.status !== 'ready') {
      return {
        ok: false,
        message: `${definition.name} install failed: ${installed.installation?.error ?? 'unknown error'}`,
        activities: [...activities, { kind: 'error', text: installed.installation?.error ?? 'Install failed', ok: false }],
      }
    }
  }
  activities.push({ kind: 'status', text: `Invoking installed ${definition.name} adapter in E2B sandbox` })
  const cronJobs = platform ? await listCronJobs(platform.runtimeId) : []
  const code = invokeCode(definition, history, platform ? { ...platform, cronJobs } : undefined)
  // Forward live stream events ('__CIRRUS_EVENT__<json>' lines) to onEvent as they
  // arrive. Non-event lines (the final result object, host/dir logs) pass through.
  // E2B delivers one OutputMessage per console.log line (no trailing newline);
  // split defensively in case a chunk ever carries several lines.
  const onStdout = onEvent
    ? (raw: string) => {
        for (const line of String(raw).split('\n')) {
          if (!line.startsWith(STREAM_EVENT_PREFIX)) continue
          try {
            const ev = JSON.parse(line.slice(STREAM_EVENT_PREFIX.length)) as { k?: string; t?: string }
            if ((ev.k === 'delta' || ev.k === 'post') && typeof ev.t === 'string') onEvent({ kind: ev.k, text: ev.t })
          } catch {}
        }
      }
    : undefined
  const out = await runInRuntimeSandbox(sandboxId, code, { timeoutMs: 90_000, onStdout })
  if (!out.ok) {
    const error = out.error ?? (out.stderr || 'Community agent invocation failed.')
    return { ok: false, message: `${definition.name} failed: ${error}`, activities: [...activities, { kind: 'error', text: error, ok: false }] }
  }
  // The result object is the last NON-event stdout line (events are streamed above).
  const line = out.stdout.trim().split('\n').filter((l) => l && !l.startsWith(STREAM_EVENT_PREFIX)).pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { ok: boolean; reply?: string; error?: string; host?: string; dir?: string; ui?: RuntimeMessageUi; cronRequests?: CronRequest[]; posts?: string[] }
    if (parsed.host) activities.push({ kind: 'status', text: `Sandbox host: ${parsed.host}` })
    if (parsed.dir) activities.push({ kind: 'status', text: `Installed adapter: ${parsed.dir}` })
    if (!parsed.ok) {
      return { ok: false, message: `${definition.name} failed: ${parsed.error ?? 'unknown error'}`, activities: [...activities, { kind: 'error', text: parsed.error ?? 'Invocation failed', ok: false }] }
    }
    // Apply the platform side-effects the adapter requested.
    if (platform && parsed.cronRequests?.length) activities.push(...(await applyCronRequests(platform, parsed.cronRequests)))
    const ui = parsed.ui && (parsed.ui.choices?.length || parsed.ui.images?.length) ? parsed.ui : undefined
    const posts = Array.isArray(parsed.posts) ? parsed.posts.filter((p) => typeof p === 'string' && p.trim()) : []
    return { ok: true, message: parsed.reply || (ui?.question ?? '(no reply)'), activities, ui, posts: posts.length ? posts : undefined }
  } catch {
    return {
      ok: false,
      message: `Could not parse ${definition.name} adapter output.`,
      activities: [...activities, { kind: 'error', text: out.stdout.slice(0, 500), ok: false }],
    }
  }
}
