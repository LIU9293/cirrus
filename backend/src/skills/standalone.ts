import type { OpenAI } from 'openai'
import { openai } from '../agent/client.ts'
import { config } from '../config.ts'
import { getSandboxDriver } from '../sandbox/index.ts'
import { saveRecord } from '../store.ts'
import { writeAgentFile } from '../agentfs.ts'
import {
  loadSkill,
  saveSkill,
  writeSkillFile,
  readSkillFile,
  toolScriptPath,
  computeStatus,
} from './store.ts'
import { SKILL_TEMPLATES } from './templates.ts'
import type {
  MiniappRecord,
  MiniappSkill,
  SkillCategory,
  SkillRecord,
  SkillSetting,
  SkillToolCall,
} from '../../../shared/protocol.ts'

const CATEGORIES: SkillCategory[] = ['data', 'tool', 'connector', 'trigger', 'ai']

export interface DraftSkillResult {
  name: string
  category: SkillCategory
  description: string
  readme: string
  tools: SkillToolCall[]
  credentials: SkillSetting[]
  summary: string
  templateId?: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function sanitizeTool(input: unknown): SkillToolCall | null {
  if (!isObject(input)) return null
  const name = String(input.name ?? '').trim()
  const description = String(input.description ?? '').trim()
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || !description) return null
  const tool: SkillToolCall = { name, description }
  if (isObject(input.parameters)) tool.parameters = input.parameters
  if (typeof input.entry === 'string' && input.entry.trim()) tool.entry = input.entry.trim()
  return tool
}

function sanitizeSetting(input: unknown): SkillSetting | null {
  if (!isObject(input)) return null
  const key = String(input.key ?? '').trim()
  const label = String(input.label ?? '').trim()
  if (!key || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || !label) return null
  return {
    key,
    label,
    ...(input.type === 'password' || input.type === 'select' || input.type === 'textarea' || input.type === 'number' || input.type === 'boolean' || input.type === 'text'
      ? { type: input.type as SkillSetting['type'] }
      : {}),
    ...(input.required === false ? { required: false } : {}),
    secret: input.secret === true,
    ...(input.default != null ? { default: input.default } : {}),
    ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
  }
}

/* ── Draft a skill from a free-text description (LLM, with strong fallback) ── */

/** Heuristic draft used when the model is unavailable — and tuned so the common
 *  email case (e.g. QQ Mailbox) produces a genuinely useful skill offline. */
function heuristicDraft(description: string): DraftSkillResult {
  const goal = description.trim().replace(/\s+/g, ' ')
  const lower = goal.toLowerCase()
  const isMail = /(mail|email|inbox|imap|smtp|邮箱|邮件)/.test(lower)

  if (isMail) {
    const tplId = /qq/.test(lower)
      ? 'qq-mailbox'
      : /gmail|google/.test(lower)
        ? 'gmail'
        : /outlook|office\s?365|hotmail|microsoft|微软/.test(lower)
          ? 'outlook'
          : 'imap-mailbox'
    const tpl = SKILL_TEMPLATES.find((t) => t.id === tplId)
    if (tpl) {
      return {
        name: tpl.name,
        category: tpl.category,
        description: tpl.description,
        readme: tpl.readme,
        tools: tpl.tools,
        credentials: tpl.credentials,
        summary: `Started from the ${tpl.name} template — review the tools and fill the credentials.`,
        templateId: tpl.id,
      }
    }
  }

  const cleaned = goal
    .replace(/^(please\s+)?(create|build|make|write|add|i need|i want|i want to|help me)\s+/i, '')
    .replace(/^(a|an|the)\s+/i, '')
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5)
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const name = titled ? (/skill/i.test(titled) ? titled : `${titled} Skill`) : 'Custom Skill'
  const description2 = goal.replace(/[.。]+$/g, '') || 'A custom agent skill.'
  return {
    name,
    category: 'tool',
    description: description2,
    readme: [
      `# ${name}`,
      '',
      '## When to use',
      `Use this skill when an agent needs to ${description2.charAt(0).toLowerCase() + description2.slice(1)}.`,
      '',
      '## What it does',
      `- Interprets the user's request in the context of ${name}.`,
      '- Chooses the relevant tool call or instruction path.',
      '- Returns concise, structured results the agent can use next.',
    ].join('\n'),
    tools: [{ name: 'run_skill', description: description2, parameters: { type: 'object', properties: { query: { type: 'string', description: 'User intent or lookup query.' } }, required: ['query'] } }],
    credentials: [],
    summary: 'Created a draft from your description.',
  }
}

export async function draftSkill(description: string): Promise<DraftSkillResult> {
  const goal = description.trim()
  if (!goal) return heuristicDraft('Custom skill')
  if (!config.apiKey) return heuristicDraft(goal)

  const draftTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'draft_skill',
      description: 'Draft a single, reusable agent skill from the creator’s description.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short, clear, product-like name (2-4 words, Title Case). For a QQ email skill prefer "QQ Mailbox".' },
          category: { type: 'string', enum: CATEGORIES },
          description: { type: 'string', description: 'One or two sentences on what the skill does.' },
          readme: { type: 'string', description: 'A complete skill.md (markdown): # title, ## When to use, ## What it does, ## Inputs, ## Guidance.' },
          tools: {
            type: 'array',
            description: '1-4 concrete tool calls the agent would call (external data/services only). Set entry to a <name>.ts filename for tools that need real code.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'snake_case function name.' },
                description: { type: 'string' },
                parameters: { type: 'object', description: 'JSON Schema for the arguments.' },
                entry: { type: 'string', description: 'Script filename if this tool needs code, else omit for an instruction-only tool.' },
              },
              required: ['name', 'description'],
            },
          },
          credentials: {
            type: 'array',
            description: 'Settings/credentials the skill needs (servers, ports, tokens, auth codes). secret:true for sensitive values.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                secret: { type: 'boolean' },
                type: { type: 'string', enum: ['text', 'password', 'select', 'textarea', 'number', 'boolean'] },
                placeholder: { type: 'string' },
                default: { type: 'string' },
                required: { type: 'boolean' },
              },
              required: ['key', 'label'],
            },
          },
          summary: { type: 'string', description: 'One short line on what you drafted and what to finish next.' },
        },
        required: ['name', 'category', 'description', 'readme'],
      },
    },
  }

  try {
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: [
            'You are the Cirrus skill designer. The creator describes a reusable capability they want an agent to have.',
            'Draft ONE skill: a clean product-like name, the right category, a refined description, a complete skill.md,',
            'and concrete tool calls plus the credentials/settings it needs.',
            'Only draft tools for external data/services/APIs — not for things the agent already does by reasoning.',
            'For email/IMAP/SMTP skills, include host/port/address settings and a secret auth token/password.',
          ].join('\n'),
        },
        { role: 'user', content: `Skill the creator wants:\n${goal}\n\nCall draft_skill.` },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: [draftTool],
      tool_choice: { type: 'function', function: { name: 'draft_skill' } },
      max_completion_tokens: 1600,
    }, { timeout: 12_000, maxRetries: 0 })
    const call = completion.choices[0]?.message?.tool_calls?.[0]
    const args = (call?.type === 'function' && call.function.arguments ? JSON.parse(call.function.arguments) : {}) as Record<string, unknown>
    const category = CATEGORIES.includes(args.category as SkillCategory) ? (args.category as SkillCategory) : 'tool'
    const tools = Array.isArray(args.tools) ? args.tools.map(sanitizeTool).filter((t): t is SkillToolCall => !!t) : []
    const credentials = Array.isArray(args.credentials) ? args.credentials.map(sanitizeSetting).filter((c): c is SkillSetting => !!c) : []
    const name = String(args.name ?? '').trim()
    const readme = String(args.readme ?? '').trim()
    if (!name || !readme) return heuristicDraft(goal)
    return {
      name,
      category,
      description: String(args.description ?? goal).trim() || goal,
      readme,
      tools: tools.length ? tools : heuristicDraft(goal).tools,
      credentials,
      summary: String(args.summary ?? 'Drafted an initial version — fill the details and generate any scripts.'),
    }
  } catch {
    return heuristicDraft(goal)
  }
}

/* ── Generate / refine / test tool scripts ── */

function scriptTemplate(skill: SkillRecord, tool: SkillToolCall): string {
  const params = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  const argList = Object.keys(params)
  return [
    `// ${tool.name} — ${tool.description}`,
    `// Skill: ${skill.name}`,
    `// Settings available at runtime (bound per agent): ${skill.credentials.map((c) => c.key).join(', ') || 'none'}`,
    `// Arguments: ${argList.join(', ') || '(none)'}`,
    '//',
    '// Portable JS: console.log only, no imports/Node APIs (runs in the sandbox).',
    'const input = globalThis.__INPUT__ || {}',
    '',
    'async function run(input) {',
    '  // TODO: implement. Use the Edit-with-AI chat (right) to flesh this out,',
    `  // e.g. "implement ${tool.name} against the configured server".`,
    `  return { ok: true, tool: ${JSON.stringify(tool.name)}, received: input }`,
    '}',
    '',
    'run(input).then((result) => console.log(JSON.stringify(result)))',
    '  .catch((err) => console.log(JSON.stringify({ ok: false, error: String(err && err.message || err) })))',
    '',
  ].join('\n')
}

/** Ensure every script tool has a file; seed missing ones from a template.
 *  Returns the list of script paths now present. */
export async function ensureToolScripts(skill: SkillRecord): Promise<string[]> {
  const paths: string[] = []
  for (const tool of skill.tools) {
    const path = toolScriptPath(tool)
    if (!path) continue
    paths.push(path)
    if ((await readSkillFile(skill.id, path)) == null) {
      await writeSkillFile(skill.id, path, scriptTemplate(skill, tool))
    }
  }
  // Always keep skill.md in sync as the canonical instruction file.
  await writeSkillFile(skill.id, 'skill.md', skill.readme)
  return paths
}

export interface GenerateResult {
  ok: boolean
  path: string
  content: string
  message: string
}

/** Author a tool's script with the model (or template), write it, and persist. */
export async function generateToolScript(skill: SkillRecord, toolName: string, notes: string): Promise<GenerateResult> {
  const tool = skill.tools.find((t) => t.name === toolName)
  if (!tool) return { ok: false, path: '', content: '', message: `Unknown tool: ${toolName}` }
  const path = toolScriptPath(tool)
  if (!path) return { ok: false, path: '', content: '', message: `Tool ${toolName} is not a script tool (set an entry file first).` }

  let code = scriptTemplate(skill, tool)
  if (config.apiKey) {
    try {
      const completion = await openai.chat.completions.create({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: [
              'You write ONE self-contained portable-JS tool script: console.log only, no imports, no Node APIs.',
              'It reads input from globalThis.__INPUT__, implements the tool, runs a tiny self-test, and console.log()s a JSON result.',
              'Output ONLY the code, no prose, no fences.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `Skill: ${skill.name} — ${skill.description}`,
              `Tool: ${tool.name} — ${tool.description}`,
              `Arguments JSON Schema: ${JSON.stringify(tool.parameters ?? {})}`,
              `Settings available (bound per agent): ${skill.credentials.map((c) => `${c.key} (${c.label})`).join(', ') || 'none'}`,
              notes ? `Notes: ${notes}` : '',
              'Write the script.',
            ].filter(Boolean).join('\n'),
          },
        ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        max_completion_tokens: 1600,
      }, { timeout: 20_000, maxRetries: 0 })
      const raw = completion.choices[0]?.message?.content ?? ''
      const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
      if (cleaned) code = cleaned
    } catch {
      // keep the template
    }
  }
  await writeSkillFile(skill.id, path, code)
  skill.status = await computeStatus(skill)
  await saveSkill(skill)
  return { ok: true, path, content: code, message: config.apiKey ? `Generated ${path}.` : `Seeded ${path} from a template (no model configured).` }
}

export interface RefineResult {
  ok: boolean
  path: string
  content: string
  message: string
  test?: { ok: boolean; stdout: string; stderr: string; error?: string }
}

/** AI-edit one skill file from an instruction; re-test .ts in the sandbox. */
export async function refineSkillFile(skill: SkillRecord, path: string, instruction: string): Promise<RefineResult> {
  const current = (await readSkillFile(skill.id, path)) ?? ''
  const isCode = path.endsWith('.ts')
  if (!config.apiKey) {
    return { ok: false, path, content: current, message: 'No model configured — edit the file directly and Save.' }
  }
  const system = isCode
    ? 'You edit ONE portable-JS tool file (console.log only, no imports/Node APIs) that reads globalThis.__INPUT__ and logs a JSON result. Apply the instruction. Output ONLY the new code, no fences.'
    : 'You edit ONE markdown skill file. Apply the instruction, keeping it tight and well-structured. Output ONLY the markdown, no fences.'
  let next: string
  try {
    const c = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [`File: ${path}`, '', 'Current content:', current || '(empty)', '', `Instruction: ${instruction}`].join('\n') },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_completion_tokens: 1800,
    }, { timeout: 20_000, maxRetries: 0 })
    next = (c.choices[0]?.message?.content ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  } catch (err) {
    return { ok: false, path, content: current, message: `Refine failed: ${String((err as Error)?.message ?? err)}` }
  }
  if (!next) return { ok: false, path, content: current, message: 'Model returned empty content.' }

  if (isCode) {
    const test = await getSandboxDriver().runCode(`globalThis.__INPUT__ = {};\n${next}`, { timeoutMs: 15_000 })
    if (!test.ok) {
      return { ok: false, path, content: current, message: `New code failed in the sandbox: ${test.error ?? test.stderr}`, test }
    }
    await writeSkillFile(skill.id, path, next)
    if (path === 'skill.md') { skill.readme = next; await saveSkill(skill) }
    return { ok: true, path, content: next, message: `Updated ${path}, re-tested in the sandbox.`, test }
  }
  await writeSkillFile(skill.id, path, next)
  if (path === 'skill.md') { skill.readme = next; await saveSkill(skill) }
  return { ok: true, path, content: next, message: `Updated ${path}.` }
}

export interface TestResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

/** Run a skill script in the sandbox with optional input. */
export async function testSkillScript(skill: SkillRecord, path: string, input: Record<string, unknown>): Promise<TestResult> {
  const code = await readSkillFile(skill.id, path)
  if (code == null) return { ok: false, stdout: '', stderr: '', error: `no such file: ${path}` }
  const wrapped = `globalThis.__INPUT__ = ${JSON.stringify(input ?? {})};\n${code}`
  const run = await getSandboxDriver().runCode(wrapped, { timeoutMs: 15_000 })
  return { ok: run.ok, stdout: run.stdout.slice(0, 4000), stderr: run.stderr.slice(0, 2000), error: run.error }
}

/* ── Install a standalone skill onto an agent (miniapp) ── */

export interface InstallResult {
  ok: boolean
  message: string
  skillId?: string
}

/** Build a MiniappSkill instance from an authored skill, copying its skill.md +
 *  tool scripts into the agent folder. Does NOT mutate record.skills (caller does). */
export async function buildSkillInstance(skill: SkillRecord, record: MiniappRecord): Promise<MiniappSkill> {
  const slug = skill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'
  await writeAgentFile(record.id, `skills/${slug}/skill.md`, skill.readme)
  for (const tool of skill.tools) {
    const path = toolScriptPath(tool)
    if (!path) continue
    const code = await readSkillFile(skill.id, path)
    if (code != null) await writeAgentFile(record.id, path, code)
  }
  return {
    id: 'sk-' + Math.random().toString(36).slice(2, 8),
    name: skill.name,
    category: skill.category,
    description: skill.description,
    source: 'generated',
    kind: 'custom',
    status: 'active',
    tools: skill.tools,
    credentials: skill.credentials,
    credentialsFilled: [],
    config: { fromSkillId: skill.id, file: `skills/${slug}/skill.md` },
  }
}

/** Attach a copy of the skill (contract + tool scripts) to a miniapp's skills[]. */
export async function installSkillOntoMiniapp(skill: SkillRecord, record: MiniappRecord): Promise<InstallResult> {
  const instance = await buildSkillInstance(skill, record)
  // Replace any prior copy of this skill AND any same-named capability the agent
  // already had (e.g. an auto-planned "qq_mailbox" when installing "QQ Mailbox"),
  // so installing an authored skill collapses overlapping duplicates instead of
  // stacking a fourth email skill.
  const normName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = normName(skill.name)
  record.skills = [
    ...(record.skills ?? []).filter((s) => s.config?.fromSkillId !== skill.id && normName(s.name) !== target),
    instance,
  ]
  await saveRecord(record)
  return { ok: true, message: `Installed ${skill.name} onto ${record.draft?.name ?? record.manifest?.name ?? 'the agent'}.`, skillId: instance.id }
}

/** Load a skill and (re)seed its files — used right after create/update. */
export async function syncSkillFiles(id: string): Promise<SkillRecord | null> {
  const skill = await loadSkill(id)
  if (!skill) return null
  await ensureToolScripts(skill)
  skill.status = await computeStatus(skill)
  await saveSkill(skill)
  return skill
}

export { SKILL_TEMPLATES }
