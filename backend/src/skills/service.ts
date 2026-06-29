import type { OpenAI } from 'openai'
import { openai } from '../agent/client.ts'
import { config } from '../config.ts'
import { saveRecord, loadRecord } from '../store.ts'
import { writeAgentFile, readAgentFile } from '../agentfs.ts'
import { getSandboxDriver } from '../sandbox/index.ts'
import { planSkills } from './planner.ts'
import { findPlatformSkill, matchPlatformSkill, PLATFORM_SKILLS } from './library.ts'
import { listSkills } from './store.ts'
import { buildSkillInstance } from './standalone.ts'
import { developerSkillPrompt } from '../agent/developerSkills.ts'
import type {
  MiniappRecord,
  MiniappSkill,
  SkillCategory,
  SkillCredentialField,
  SkillDevelopMethod,
  SkillPlan,
  SkillPlanItem,
  SkillRecord,
  SkillToolCall,
} from '../../../shared/protocol.ts'

const newSkillId = () => 'sk-' + Math.random().toString(36).slice(2, 8)

function planItemToSkill(item: SkillPlanItem): MiniappSkill {
  const platform = item.platformSkillId ? findPlatformSkill(item.platformSkillId) : undefined
  if (platform) {
    // A built-in skill: it ships its full contract (tool calls + credentials).
    return {
      id: newSkillId(),
      name: item.name || platform.name,
      category: platform.category,
      description: item.reason || platform.description,
      source: 'library',
      kind: 'builtin',
      status: 'active',
      platformSkillId: platform.id,
      tools: platform.tools ?? [],
      credentials: platform.credentials ?? [],
      credentialsFilled: [],
      config: platform.config ? { ...platform.config } : undefined,
    }
  }
  // Not in the library → a custom skill the creator builds to the same contract.
  return {
    id: newSkillId(),
    name: item.name,
    category: item.category,
    description: item.reason,
    source: 'generated',
    kind: 'custom',
    status: 'needs_dev',
    tools: [],
    credentials: [],
    config: { suggestedMethods: item.suggestedMethods ?? ['generate', 'integrate'] },
  }
}

export interface PlanResult {
  plan: SkillPlan
  skills: MiniappSkill[]
  autoAdded: number
  needsDev: number
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A planned capability matches an authored skill if the skill's (normalized) name
 *  equals or appears in the item's name/capability/provider. Lets "qq_mailbox" or a
 *  "manage QQ + Gmail email" capability resolve to the user's own "QQ Mailbox" skill. */
function matchAuthoredSkill(item: SkillPlanItem, authored: SkillRecord[]): SkillRecord | undefined {
  const keys = [item.name, item.capability, (item as { connectProvider?: string }).connectProvider]
    .filter((v): v is string => !!v)
    .map(normName)
  return authored.find((a) => {
    const an = normName(a.name)
    return an.length >= 3 && keys.some((k) => k === an || k.includes(an))
  })
}

/** Analyse the goal, attach the resulting skills to the record, and persist.
 *  Prefers the user's OWN authored skills over inventing library/custom ones, so
 *  authoring a skill and building an agent stay one connected flow. */
export async function planAndAttachSkills(record: MiniappRecord): Promise<PlanResult> {
  const goal = record.draft?.goal ?? record.manifest?.description ?? ''
  const name = record.draft?.name ?? record.manifest?.name
  const plan = await planSkills(goal, name)
  // Re-load the record after the (slow) planning call so we don't clobber a
  // creationPhase the user advanced to while planning was in flight.
  const fresh = (await loadRecord(record.id)) ?? record
  const authored = fresh.ownerId ? await listSkills(fresh.ownerId) : []

  const skills: MiniappSkill[] = []
  const usedAuthored = new Set<string>()
  for (const item of plan.items) {
    const match = matchAuthoredSkill(item, authored)
    if (match) {
      if (usedAuthored.has(match.id)) continue // a single authored skill covers this capability already
      usedAuthored.add(match.id)
      skills.push(await buildSkillInstance(match, fresh))
    } else {
      skills.push(planItemToSkill(item))
    }
  }

  fresh.skills = skills
  await saveRecord(fresh)
  record.skills = skills
  return {
    plan,
    skills,
    autoAdded: skills.filter((s) => s.status === 'active').length,
    needsDev: skills.filter((s) => s.status === 'needs_dev').length,
  }
}

const ANALYZE_CATEGORIES: SkillCategory[] = ['data', 'tool', 'connector', 'trigger', 'ai']

export interface AnalyzeSkillResult {
  skill: MiniappSkill
  summary: string
}

/** Turn a free-text "what skill I want" description into a drafted skill: a clean
 *  name, category, refined description, and an initial set of tool calls/credentials
 *  (its first version). If it matches a platform library skill, return that instead. */
export async function analyzeSkill(description: string): Promise<AnalyzeSkillResult> {
  const goal = description.trim()
  const fallbackName = goal.length > 36 ? goal.slice(0, 36) + '…' : goal || 'Custom skill'
  const draftTool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'draft_skill',
      description: 'Draft a single agent skill from the creator’s description.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short, clear skill name (2-4 words, Title Case).' },
          category: { type: 'string', enum: ANALYZE_CATEGORIES },
          description: { type: 'string', description: 'One or two sentences describing what the skill does.' },
          platformSkillId: {
            type: 'string',
            description: 'The id of the matching platform library skill, or "" if the platform has none.',
          },
          tools: {
            type: 'array',
            description: 'The initial tool calls this skill exposes (usually 1-3). Each is a concrete function the agent can call.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'snake_case function name.' },
                description: { type: 'string' },
                parameters: { type: 'object', description: 'JSON Schema for the tool arguments.' },
              },
              required: ['name', 'description'],
            },
          },
          credentials: {
            type: 'array',
            description: 'Any credentials/config the skill needs (API keys, endpoints). Omit if none.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                secret: { type: 'boolean' },
                type: { type: 'string', enum: ['text', 'password', 'select', 'textarea'] },
                placeholder: { type: 'string' },
                required: { type: 'boolean' },
              },
              required: ['key', 'label'],
            },
          },
          summary: { type: 'string', description: 'One short line on what you drafted and what to finish next.' },
        },
        required: ['name', 'category', 'description'],
      },
    },
  }

  const system = [
    'You are the Cirrus skill analyzer. The creator describes a capability they want their agent to have.',
    'Analyze it and draft ONE skill: a clear name, the right category, a refined description, and an initial',
    'set of concrete tool calls (its first version) plus any credentials it needs.',
    '',
    'If an existing platform library skill already covers it, set platformSkillId to that id and keep tools minimal',
    '(the library skill ships its own contract). Otherwise set platformSkillId to "" and draft 1-3 tool calls the',
    'agent would call to use this skill. Do NOT draft tools for things the agent already does with its own reasoning',
    '(summarizing, classifying, writing) — only for external data/services/APIs.',
    '',
    'Platform Skills Library:',
    ...PLATFORM_SKILLS.map((s) => `- ${s.id} (${s.category}): ${s.description}`),
  ].join('\n')

  try {
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Skill the creator wants:\n${goal}\n\nCall draft_skill.` },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: [draftTool],
      tool_choice: { type: 'function', function: { name: 'draft_skill' } },
      max_completion_tokens: 1200,
    })
    const call = completion.choices[0]?.message?.tool_calls?.[0]
    const args = (call?.type === 'function' && call.function.arguments ? JSON.parse(call.function.arguments) : {}) as Record<string, unknown>

    const rawId = typeof args.platformSkillId === 'string' ? args.platformSkillId.trim() : ''
    const matched = (rawId && findPlatformSkill(rawId)) || matchPlatformSkill(`${goal} ${String(args.name ?? '')}`)
    if (matched) {
      return {
        skill: {
          id: newSkillId(),
          name: String(args.name ?? matched.name) || matched.name,
          category: matched.category,
          description: String(args.description ?? matched.description) || matched.description,
          source: 'library',
          kind: 'builtin',
          status: 'active',
          platformSkillId: matched.id,
          tools: matched.tools ?? [],
          credentials: matched.credentials ?? [],
          credentialsFilled: [],
          config: matched.config ? { ...matched.config } : undefined,
        },
        summary: String(args.summary ?? `Matched the “${matched.name}” platform skill — ready to use once connected.`),
      }
    }

    const category: SkillCategory = ANALYZE_CATEGORIES.includes(args.category as SkillCategory) ? (args.category as SkillCategory) : 'tool'
    const tools = Array.isArray(args.tools) ? args.tools.map(sanitizeTool).filter((t): t is SkillToolCall => !!t) : []
    const credentials = Array.isArray(args.credentials)
      ? args.credentials.map(sanitizeCredential).filter((c): c is SkillCredentialField => !!c)
      : []
    return {
      skill: {
        id: newSkillId(),
        name: String(args.name ?? fallbackName) || fallbackName,
        category,
        description: String(args.description ?? goal) || goal,
        source: 'generated',
        kind: 'custom',
        status: 'needs_dev',
        tools,
        credentials,
        config: { suggestedMethods: ['generate', 'integrate'], draftedFrom: goal },
      },
      summary: String(args.summary ?? 'Drafted an initial version — generate the code to make it live.'),
    }
  } catch {
    // Relay/model unavailable: fall back to the old behavior so the flow still works.
    return {
      skill: {
        id: newSkillId(),
        name: fallbackName,
        category: 'tool',
        description: goal,
        source: 'generated',
        kind: 'custom',
        status: 'needs_dev',
        tools: [],
        credentials: [],
        config: { suggestedMethods: ['generate', 'integrate'], draftedFrom: goal },
      },
      summary: 'Created a draft from your description.',
    }
  }
}

export interface DevelopResult {
  ok: boolean
  skill?: MiniappSkill
  message: string
  test?: { stdout: string; stderr: string }
}

/** Build a missing skill via the chosen method. */
export async function developSkill(
  record: MiniappRecord,
  skillId: string,
  method: SkillDevelopMethod,
  input: Record<string, unknown>,
): Promise<DevelopResult> {
  const skill = (record.skills ?? []).find((s) => s.id === skillId)
  if (!skill) return { ok: false, message: `Unknown skill: ${skillId}` }

  skill.developMethod = method

  if (method === 'integrate') {
    skill.source = 'integration'
    skill.status = 'active'
    skill.config = { ...skill.config, endpoint: input.endpoint ?? '', auth: input.auth ?? '' }
    await saveRecord(record)
    return { ok: true, skill, message: `Connected ${skill.name}.` }
  }

  if (method === 'upload') {
    skill.source = 'library'
    skill.status = 'active'
    skill.config = { ...skill.config, dataset: input.dataset ?? input.data ?? null }
    await saveRecord(record)
    return { ok: true, skill, message: `${skill.name} dataset attached.` }
  }

  // method === 'generate' — author the skill's code and smoke-test it in the sandbox.
  skill.source = 'generated'
  skill.status = 'building'
  await saveRecord(record)

  const code = await generateSkillCode(skill.name, String(skill.description ?? skill.name), String(input.notes ?? ''))
  const driver = getSandboxDriver()
  const test = await driver.runCode(code, { timeoutMs: 15_000 })

  if (test.ok) {
    // Folder model: the tool's source of truth is a file under agent/tools/.
    const file = `tools/${skill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'tool'}.ts`
    await writeAgentFile(record.id, file, code)
    skill.status = 'active'
    skill.config = { ...skill.config, file, code, sandbox: driver.name, sample: test.stdout.slice(0, 2000) }
    await saveRecord(record)
    return { ok: true, skill, message: `Generated ${skill.name} → ${file}, verified in the ${driver.name} sandbox.`, test }
  }

  skill.status = 'needs_dev'
  skill.config = { ...skill.config, code, sandbox: driver.name, lastError: test.error ?? test.stderr }
  await saveRecord(record)
  return {
    ok: false,
    skill,
    message: `Generated code failed in the ${driver.name} sandbox: ${test.error ?? test.stderr}`,
    test,
  }
}

export interface RefineResult {
  ok: boolean
  path: string
  content: string
  message: string
  test?: { stdout: string; stderr: string }
}

/** Per-capability "refine with AI": rewrite a single agent file from an instruction.
 *  Code files (.ts) are re-tested in the sandbox; markdown (.md) is rewritten directly. */
export async function refineFile(record: MiniappRecord, path: string, instruction: string): Promise<RefineResult> {
  const current = await readAgentFile(record.id, path) ?? ''
  const isCode = path.endsWith('.ts')
  const system = isCode
    ? [
        'You edit ONE tool file: a portable JS snippet (plain JS, console.log only, no imports, no Node APIs)',
        'that implements the tool and runs a tiny self-test logging a JSON result. Apply the user instruction.',
        'Output ONLY the new code, no prose, no fences.',
      ].join('\n')
    : [
        'You edit ONE markdown file (an agent procedure/skill or instructions). Apply the user instruction,',
        'keeping it a tight, well-structured markdown doc. Output ONLY the new markdown, no fences.',
      ].join('\n')
  const user = [`File: ${path}`, '', 'Current content:', current || '(empty)', '', `Instruction: ${instruction}`].join('\n')

  let next: string
  try {
    const c = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_completion_tokens: 1800,
    })
    next = (c.choices[0]?.message?.content ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  } catch (err) {
    return { ok: false, path, content: current, message: `Refine failed: ${String((err as Error)?.message ?? err)}` }
  }
  if (!next) return { ok: false, path, content: current, message: 'Model returned empty content.' }

  if (isCode) {
    const test = await getSandboxDriver().runCode(next, { timeoutMs: 15_000 })
    if (!test.ok) {
      return { ok: false, path, content: current, message: `New code failed in the sandbox: ${test.error ?? test.stderr}`, test }
    }
    await writeAgentFile(record.id, path, next)
    await saveRecord(record)
    return { ok: true, path, content: next, message: `Updated ${path}, re-tested in the sandbox.`, test }
  }
  await writeAgentFile(record.id, path, next)
  await saveRecord(record)
  return { ok: true, path, content: next, message: `Updated ${path}.` }
}

export interface SkillChatResult {
  reply: string
  skill?: MiniappSkill
}

interface SkillContractUpdate {
  description?: string
  readme?: string
  addOrUpdateTools?: SkillToolCall[]
  removeToolNames?: string[]
  credentials?: SkillCredentialField[]
  status?: MiniappSkill['status']
  response?: string
}

function compact(value: unknown, max = 900): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function credentialLabels(skill: MiniappSkill): string {
  return (skill.credentials ?? [])
    .map((c) => {
      const f = c as { name?: string; label?: string; key?: string }
      const label = f.label ?? f.name ?? f.key ?? 'credential'
      const filled = skill.credentialsFilled?.includes(f.key ?? '') ? 'configured' : 'missing'
      return `${label} (${filled})`
    })
    .join(', ')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeTool(input: unknown): SkillToolCall | null {
  if (!isObject(input)) return null
  const name = String(input.name ?? '').trim()
  const description = String(input.description ?? '').trim()
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || !description) return null
  const tool: SkillToolCall = { name, description }
  if (isObject(input.parameters)) tool.parameters = input.parameters
  if (typeof input.entry === 'string' && input.entry.trim()) tool.entry = input.entry.trim()
  if (typeof input.builtin === 'string' && input.builtin.trim()) tool.builtin = input.builtin.trim()
  return tool
}

function sanitizeCredential(input: unknown): SkillCredentialField | null {
  if (!isObject(input)) return null
  const key = String(input.key ?? '').trim()
  const label = String(input.label ?? '').trim()
  if (!key || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || !label) return null
  return {
    key,
    label,
    ...(input.type === 'password' || input.type === 'select' || input.type === 'textarea' || input.type === 'text' ? { type: input.type } : {}),
    ...(Array.isArray(input.options)
      ? {
          options: input.options
            .filter(isObject)
            .map((o) => ({ label: String(o.label ?? o.value ?? ''), value: String(o.value ?? '') }))
            .filter((o) => o.label && o.value),
        }
      : {}),
    ...(input.required === false ? { required: false } : {}),
    secret: input.secret === true,
    ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
  }
}

function parseSkillContractUpdate(raw: string): SkillContractUpdate {
  const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
  const update: SkillContractUpdate = {}
  if (typeof parsed.description === 'string') update.description = parsed.description.trim()
  if (typeof parsed.readme === 'string') update.readme = parsed.readme.trim()
  if (Array.isArray(parsed.addOrUpdateTools)) update.addOrUpdateTools = parsed.addOrUpdateTools.map(sanitizeTool).filter((t): t is SkillToolCall => !!t)
  if (Array.isArray(parsed.removeToolNames)) update.removeToolNames = parsed.removeToolNames.map((n) => String(n).trim()).filter(Boolean)
  if (Array.isArray(parsed.credentials)) update.credentials = parsed.credentials.map(sanitizeCredential).filter((c): c is SkillCredentialField => !!c)
  if (parsed.status === 'active' || parsed.status === 'needs_dev' || parsed.status === 'building') update.status = parsed.status
  if (typeof parsed.response === 'string') update.response = parsed.response.trim()
  return update
}

async function applySkillContractUpdate(record: MiniappRecord, skillId: string, update: SkillContractUpdate): Promise<MiniappSkill | null> {
  const skills = record.skills ?? []
  const index = skills.findIndex((s) => s.id === skillId)
  if (index < 0) return null
  const current = skills[index]
  const tools = [...(current.tools ?? [])]
  const remove = new Set((update.removeToolNames ?? []).map((n) => n.toLowerCase()))
  const kept = tools.filter((tool) => !remove.has(tool.name.toLowerCase()))
  for (const next of update.addOrUpdateTools ?? []) {
    const existing = kept.findIndex((tool) => tool.name === next.name)
    if (existing >= 0) kept[existing] = { ...kept[existing], ...next }
    else kept.push(next)
  }
  const nextSkill: MiniappSkill = {
    ...current,
    ...(update.description ? { description: update.description } : {}),
    ...(update.status ? { status: update.status } : {}),
    tools: kept,
    ...(update.credentials ? { credentials: update.credentials } : {}),
    config: { ...(current.config ?? {}), contractEdited: true, updatedBySkillChatAt: new Date().toISOString() },
  }
  record.skills = skills.map((skill, i) => (i === index ? nextSkill : skill))
  if (update.readme) {
    const fileSlug = nextSkill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'
    await writeAgentFile(record.id, `skills/${fileSlug}/skill.md`, update.readme)
  }
  await saveRecord(record)
  return nextSkill
}

function agentCreationContext(
  record: MiniappRecord,
  current: { type: 'skill' | 'surface'; id: string },
): string {
  const name = record.draft?.name ?? record.manifest?.name ?? 'Untitled agent'
  const purpose = record.draft?.goal ?? record.manifest?.description ?? '(unspecified)'
  const skills = (record.skills ?? []).map((s) => {
    const marker = current.type === 'skill' && current.id === s.id ? ' [current]' : ''
    const tools = (s.tools ?? []).map((t) => t.name).join(', ') || 'none'
    const creds = credentialLabels(s) || 'none'
    return [
      `- ${s.name}${marker}`,
      `category=${s.category}`,
      `kind=${s.kind ?? s.source}`,
      `status=${s.status}`,
      s.platformSkillId ? `platform=${s.platformSkillId}` : '',
      `description=${compact(s.description, 220) || '(none)'}`,
      `tools=${tools}`,
      `credentials=${creds}`,
    ]
      .filter(Boolean)
      .join('; ')
  })

  const actions = (record.manifest?.actions ?? []).map((a) => a.id).join(', ') || 'none'
  const stateFields =
    (record.manifest?.stateModel?.fields ?? []).map((f) => f.name).join(', ') || Object.keys(record.state ?? {}).join(', ') || 'none'
  const surfaces = [
    `- Chat${current.type === 'surface' && current.id === 'chat' ? ' [current]' : ''}: runtime conversation surface for the agent.`,
    [
      `- Mini App${current.type === 'surface' && current.id === 'miniapp' ? ' [current]' : ''}:`,
      record.html ? 'built' : 'not built yet',
      `name=${record.manifest?.name ?? record.draft?.name ?? 'Mini App'}`,
      `description=${compact(record.manifest?.description ?? record.draft?.goal, 220) || '(none)'}`,
      `actions=${actions}`,
      `state=${stateFields}`,
    ].join(' '),
  ]

  return [
    `Agent name: ${name}`,
    `Agent purpose: ${purpose}`,
    '',
    'All skills:',
    skills.length ? skills.join('\n') : '- none yet',
    '',
    'All surfaces:',
    surfaces.join('\n'),
  ].join('\n')
}

/** A real, skill-scoped chat: answers the creator's questions about ONE skill,
 *  grounded in that skill's contract plus the rest of the agent context. */
export async function chatAboutSkill(
  record: MiniappRecord,
  skillId: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): Promise<SkillChatResult> {
  const skill = (record.skills ?? []).find((s) => s.id === skillId)
  if (!skill) return { reply: 'That skill no longer exists.' }
  const last = history.at(-1)
  if (!last || last.role !== 'user') return { reply: '' }

  const fileSlug = skill.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase().slice(0, 40) || 'skill'
  const readme = await readAgentFile(record.id, `skills/${fileSlug}/skill.md`) ?? ''
  const tools = (skill.tools ?? []).map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n')
  const platform = skill.platformSkillId ? findPlatformSkill(skill.platformSkillId) : undefined
  const creds = (skill.credentials ?? [])
    .map((c) => {
      const f = c as { name?: string; label?: string; key?: string }
      return `- ${f.label ?? f.name ?? f.key ?? 'credential'}`
    })
    .join('\n')

  const system = [
    developerSkillPrompt('skill_contract_editor'),
    `You are helping the creator refine ONE capability ("skill") of their agent "${record.draft?.name ?? record.manifest?.name ?? 'agent'}".`,
    'Stay scoped to the current skill. Use the rest of the agent context only to explain how this skill fits with the purpose, other skills, and surfaces.',
    '',
    `Full agent context:\n${agentCreationContext(record, { type: 'skill', id: skill.id })}`,
    '',
    `Skill: ${skill.name}`,
    `Category: ${skill.category} · ${skill.kind ?? 'custom'} · status: ${skill.status}`,
    `Description: ${skill.description ?? '(none)'}`,
    tools ? `Tool calls:\n${tools}` : 'Tool calls: (none yet)',
    `Current skill contract JSON:\n${compact({ tools: skill.tools ?? [], credentials: skill.credentials ?? [], config: skill.config ?? {} }, 2600)}`,
    platform ? `Platform default contract JSON:\n${compact({ tools: platform.tools ?? [], credentials: platform.credentials ?? [] }, 2600)}` : '',
    creds ? `Credentials it needs:\n${creds}` : '',
    readme ? `README:\n${readme.slice(0, 1500)}` : '',
    skill.platformSkillId === 'database'
      ? [
          'Database skill design rule:',
          'Each agent should define its database interface in this skill README using a fenced ```cirrus-db block.',
          'The interface should list tables, fields, primary keys, and what each table is for.',
          'The runtime tool define_database_interface stores the same interface in skill.config.databaseInterface and creates/updates tables.',
          'Prefer generic DB tool calls: define_database_interface, transform_records, create_records, query_records, update_records, delete_records, upsert_records.',
        ].join('\n')
      : '',
    '',
    'Answer the creator concretely and specifically about THIS skill — how it works, how to connect it,',
    "what it can/can't do, how to configure it. If they ask \"how do we connect X\", explain the real mechanism",
    '(e.g. OAuth, an API token, the credentials listed above).',
    '',
    'If the creator asks you to add, remove, rename, or update this skill capability/tool call/credentials/configuration,',
    'you MUST call update_current_skill_contract. Only update the current skill, not other skills or surfaces.',
    'When adding a tool for a built-in platform handler, preserve the matching builtin key when known.',
    'After updating, reply briefly with what changed and what the creator should test next.',
    'Be concise — under ~120 words. No markdown headings.',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      ...history.map((h) => ({ role: h.role, content: h.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
    ]
    const toolsSpec: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'update_current_skill_contract',
          description: 'Update the current skill contract: description, exposed tool calls, credentials, and status.',
          parameters: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Replacement skill description, if it should change.' },
              readme: { type: 'string', description: 'Replacement skill README/skill.md. For database skills, include the cirrus-db interface block here.' },
              addOrUpdateTools: {
                type: 'array',
                description: 'Tool calls to add or update by name. Include full name, description, parameters JSON schema, and builtin/entry when applicable.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    parameters: { type: 'object' },
                    entry: { type: 'string' },
                    builtin: { type: 'string' },
                  },
                  required: ['name', 'description'],
                },
              },
              removeToolNames: { type: 'array', items: { type: 'string' }, description: 'Tool names to remove from this skill.' },
              credentials: {
                type: 'array',
                description: 'Full replacement credential field list, only when credential requirements should change.',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    label: { type: 'string' },
                    secret: { type: 'boolean' },
                    type: { type: 'string', enum: ['text', 'password', 'select', 'textarea'] },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { label: { type: 'string' }, value: { type: 'string' } },
                        required: ['label', 'value'],
                      },
                    },
                    required: { type: 'boolean' },
                    placeholder: { type: 'string' },
                  },
                  required: ['key', 'label'],
                },
              },
              status: { type: 'string', enum: ['active', 'needs_dev', 'building'] },
              response: { type: 'string', description: 'Short user-facing reply after the update.' },
            },
          },
        },
      },
    ]
    const c = await openai.chat.completions.create({
      model: config.model,
      messages,
      tools: toolsSpec,
      tool_choice: 'auto',
      max_completion_tokens: 500,
    })
    const message = c.choices[0]?.message
    const toolCall = message?.tool_calls?.find((call) => call.function.name === 'update_current_skill_contract')
    if (toolCall) {
      const update = parseSkillContractUpdate(toolCall.function.arguments)
      const updatedSkill = await applySkillContractUpdate(record, skill.id, update)
      if (!updatedSkill) return { reply: 'I could not find that skill to update.' }
      const fallback = [
        `Updated ${updatedSkill.name}.`,
        update.addOrUpdateTools?.length ? `Tool calls changed: ${update.addOrUpdateTools.map((t) => t.name).join(', ')}.` : '',
        update.removeToolNames?.length ? `Removed: ${update.removeToolNames.join(', ')}.` : '',
        'You can test the updated tool calls from the left panel.',
      ]
        .filter(Boolean)
        .join(' ')
      return { reply: update.response || fallback, skill: updatedSkill }
    }
    return { reply: (message?.content ?? '').trim() || 'Could you say a bit more?' }
  } catch (err) {
    return { reply: `Sorry — I hit an error: ${String((err as Error)?.message ?? err)}` }
  }
}

/** Surface-scoped chat: discuss ONE user-facing surface, with full agent context
 *  available so the answer can account for purpose, skills, and other surfaces. */
export async function chatAboutSurface(
  record: MiniappRecord,
  surfaceId: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): Promise<SkillChatResult> {
  const normalized = surfaceId === 'chat' ? 'chat' : 'miniapp'
  const last = history.at(-1)
  if (!last || last.role !== 'user') return { reply: '' }

  const surface =
    normalized === 'chat'
      ? [
          'Surface: Chat',
          'Purpose: runtime conversation with the agent.',
          'Discuss conversation behavior, user prompts, confirmations, and how the agent should expose its skills through chat.',
        ].join('\n')
      : [
          'Surface: Mini App',
          `Status: ${record.html ? 'built' : 'not built yet'}`,
          `Manifest: ${compact(record.manifest, 1400) || '(none yet)'}`,
          `Has HTML: ${record.html ? 'yes' : 'no'}`,
          'Discuss the mini app UX, layout, state, actions, and how it should use the agent skills. Do not switch into generic build-agent chat.',
        ].join('\n')

  const system = [
    developerSkillPrompt('surface_designer'),
    `You are helping the creator refine ONE surface of their agent "${record.draft?.name ?? record.manifest?.name ?? 'agent'}".`,
    'Stay scoped to the current surface. Use the rest of the agent context to account for purpose, all skills, and other surfaces.',
    '',
    `Full agent context:\n${agentCreationContext(record, { type: 'surface', id: normalized })}`,
    '',
    surface,
    '',
    'Answer concretely about this surface. If the creator asks for a change, explain the intended surface behavior and requirements.',
    'Be concise - under ~140 words. No markdown headings.',
  ].join('\n')

  try {
    const c = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        ...history.map((h) => ({ role: h.role, content: h.content })),
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_completion_tokens: 600,
    })
    return { reply: (c.choices[0]?.message?.content ?? '').trim() || 'Could you say a bit more?' }
  } catch (err) {
    return { reply: `Sorry — I hit an error: ${String((err as Error)?.message ?? err)}` }
  }
}

async function generateSkillCode(name: string, description: string, notes: string): Promise<string> {
  const system = [
    'You write a single self-contained snippet of portable JavaScript that implements a skill,',
    'then runs a tiny self-test and console.log()s a JSON result.',
    'Use ONLY plain JS + console.log — no imports, no external packages, no Node-specific APIs',
    '(so it runs the same in a local Node process and an E2B JS sandbox).',
    'Output ONLY the code, no prose, no markdown fences.',
  ].join('\n')
  const user = [`Skill: ${name}`, `Does: ${description}`, notes ? `Notes: ${notes}` : '', 'Write the module.']
    .filter(Boolean)
    .join('\n')
  try {
    const completion = await openai.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_completion_tokens: 1500,
    })
    const raw = completion.choices[0]?.message?.content ?? ''
    return raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim() || 'console.log(JSON.stringify({ ok: true }))'
  } catch (err) {
    return `console.log(JSON.stringify({ ok: false, error: ${JSON.stringify(String((err as Error)?.message ?? err))} }))`
  }
}
