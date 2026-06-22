import { config } from './config.ts'
import { runInRuntimeSandbox } from './sandbox/runtimeSandbox.ts'
import type { ChatTurn } from './agent/developerAgent.ts'
import type { DeveloperChatActivity, RuntimeAgentRef, RuntimeAgentModelConfig } from '../../shared/protocol.ts'

export interface CommunityAgentDefinition {
  key: string
  name: string
  description: string
  category: 'framework' | 'browser' | 'core' | 'coding'
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
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: platformModel(),
    capabilities: ['multi-agent coordination', 'workflow planning', 'handoff routing', 'status synthesis'],
    systemPrompt:
      'You are Hermes, a runtime coordination agent. Focus on decomposing requests, assigning work to available agents, and explaining orchestration decisions clearly.',
    installNotes: ['Installed as a Terr platform LLM adapter. Native Hermes package support can replace this adapter later.'],
  },
  'community:OpenClaw': {
    key: 'community:OpenClaw',
    name: 'OpenClaw',
    description: 'Open web-browsing automation agent that drives real sites.',
    category: 'browser',
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: platformModel(),
    capabilities: ['browser task planning', 'website automation planning', 'DOM/action reasoning'],
    systemPrompt:
      'You are OpenClaw, a web automation agent. Help plan browser actions and explain safe website automation steps. Do not claim to click external sites unless a browser tool is explicitly connected.',
    installNotes: ['Installed as a Terr platform LLM adapter. Browser-control tools will be wired as explicit capabilities later.'],
  },
  'community:Pi Agent': {
    key: 'community:Pi Agent',
    name: 'Pi Agent',
    description: 'Lightweight, framework-agnostic tool-calling agent core.',
    category: 'core',
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: platformModel(),
    capabilities: ['tool calling patterns', 'agent loop design', 'structured reasoning'],
    systemPrompt:
      'You are Pi Agent, a compact tool-calling runtime agent. Emphasize structured tool contracts, minimal loops, and practical agent execution.',
    installNotes: ['Installed as a Terr platform LLM adapter using the current platform model.'],
  },
  'community:Claude Code': {
    key: 'community:Claude Code',
    name: 'Claude Code',
    description: "Anthropic's agentic coding assistant for the terminal and IDE.",
    category: 'coding',
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: subscriptionSkeleton('claude_code'),
    capabilities: ['codebase reasoning', 'patch planning', 'terminal workflow guidance'],
    systemPrompt:
      'You are Claude Code in a Terr runtime adapter. Help with software-engineering tasks, code navigation, patch plans, and terminal-oriented workflows. Mention when native subscription auth is not connected.',
    installNotes: ['Native Claude Code subscription auth is a skeleton; current adapter uses the Terr platform model.'],
  },
  'community:Codex': {
    key: 'community:Codex',
    name: 'Codex',
    description: "OpenAI's autonomous software-engineering agent.",
    category: 'coding',
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: subscriptionSkeleton('codex'),
    capabilities: ['software engineering', 'repo inspection', 'implementation planning', 'test strategy'],
    systemPrompt:
      'You are Codex in a Terr runtime adapter. Act as a pragmatic software-engineering agent. Mention when native Codex login/subscription auth is not connected.',
    installNotes: ['Native Codex subscription auth is a skeleton; current adapter uses the Terr platform model.'],
  },
  'community:OpenCode': {
    key: 'community:OpenCode',
    name: 'OpenCode',
    description: 'Open-source AI coding agent you can run anywhere.',
    category: 'coding',
    adapter: 'platform-llm-adapter',
    version: '0.1.0',
    defaultModelConfig: subscriptionSkeleton('opencode'),
    capabilities: ['coding workflows', 'CLI-oriented engineering guidance', 'open-source agent operations'],
    systemPrompt:
      'You are OpenCode in a Terr runtime adapter. Help with coding tasks and CLI-oriented development. Mention when native OpenCode auth/install is not connected.',
    installNotes: ['Native OpenCode install/auth is a skeleton; current adapter uses the Terr platform model.'],
  },
}

export function communityAgentDefinition(key: string): CommunityAgentDefinition | null {
  return COMMUNITY_AGENT_REGISTRY[key] ?? null
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
        : { status: 'ready', adapter: 'terr-own-agent', version: '0.1.0' }),
  }
}

function agentDirName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function installCode(definition: CommunityAgentDefinition): string {
  const dir = `/home/user/terr/agents/${agentDirName(definition.key)}`
  const manifest = {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    adapter: definition.adapter,
    version: definition.version,
    capabilities: definition.capabilities,
    installNotes: definition.installNotes,
  }
  const invokeSource = `
export async function invoke(payload) {
  const { model, agent, history } = payload;
  const messages = [
    { role: 'system', content: agent.systemPrompt },
    ...(history || []).map((turn) => ({ role: turn.role, content: turn.content }))
  ];
  const res = await fetch(model.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + model.apiKey },
    body: JSON.stringify({ model: model.id, messages, max_completion_tokens: 900 })
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: JSON.stringify(data).slice(0, 1200) };
  return { ok: true, reply: data?.choices?.[0]?.message?.content ?? '' };
}
`
  return [
    `await (async () => {`,
    `  const fs = await import('node:fs/promises');`,
    `  const os = await import('node:os');`,
    `  const dir = ${JSON.stringify(dir)};`,
    `  await fs.mkdir(dir, { recursive: true });`,
    `  await fs.writeFile(dir + '/agent.json', ${JSON.stringify(JSON.stringify(manifest, null, 2))});`,
    `  await fs.writeFile(dir + '/invoke.mjs', ${JSON.stringify(invokeSource)});`,
    `  console.log(JSON.stringify({ ok: true, host: os.hostname(), dir, manifest: ${JSON.stringify(manifest)} }));`,
    `})();`,
  ].join('\n')
}

function invokeCode(definition: CommunityAgentDefinition, history: ChatTurn[]): string {
  const dir = `/home/user/terr/agents/${agentDirName(definition.key)}`
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
      systemPrompt: [
        definition.systemPrompt,
        '',
        `Installed adapter: ${definition.adapter} ${definition.version}.`,
        'Model mode: platform. Custom LLM API and subscription authorization configs are available in the runtime schema but not active in this adapter yet.',
        'If asked where you run, say you are invoked through your installed Terr community-agent adapter inside the runtime E2B sandbox.',
      ].join('\n'),
    },
    history,
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
  const out = await runInRuntimeSandbox(sandboxId, installCode(definition), { timeoutMs: 90_000 })
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
      logs: [`${startedAt} installed ${definition.name} into runtime sandbox`, out.stdout.trim()].filter(Boolean).slice(-8),
    },
  }
}

export async function invokeInstalledCommunityAgent(
  sandboxId: string,
  agent: RuntimeAgentRef,
  history: ChatTurn[],
): Promise<{ ok: boolean; message: string; activities: DeveloperChatActivity[] }> {
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
  const out = await runInRuntimeSandbox(sandboxId, invokeCode(definition, history), { timeoutMs: 90_000 })
  if (!out.ok) {
    const error = out.error ?? (out.stderr || 'Community agent invocation failed.')
    return { ok: false, message: `${definition.name} failed: ${error}`, activities: [...activities, { kind: 'error', text: error, ok: false }] }
  }
  const line = out.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    const parsed = JSON.parse(line) as { ok: boolean; reply?: string; error?: string; host?: string; dir?: string }
    if (parsed.host) activities.push({ kind: 'status', text: `Sandbox host: ${parsed.host}` })
    if (parsed.dir) activities.push({ kind: 'status', text: `Installed adapter: ${parsed.dir}` })
    if (!parsed.ok) {
      return { ok: false, message: `${definition.name} failed: ${parsed.error ?? 'unknown error'}`, activities: [...activities, { kind: 'error', text: parsed.error ?? 'Invocation failed', ok: false }] }
    }
    return { ok: true, message: parsed.reply || '(no reply)', activities }
  } catch {
    return {
      ok: false,
      message: `Could not parse ${definition.name} adapter output.`,
      activities: [...activities, { kind: 'error', text: out.stdout.slice(0, 500), ok: false }],
    }
  }
}
