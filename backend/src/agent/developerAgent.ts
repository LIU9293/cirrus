import type { AgentEvent as PiAgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Model, Usage } from '@earendil-works/pi-ai'
import { resolve } from 'node:path'
import { config } from '../config.ts'
import { MINIAPP_SPEC } from './spec.ts'
import { buildMiniapp } from '../build/buildMiniapp.ts'
import {
  applyManifest,
  clearSourceFiles,
  readSourceFiles,
  saveRecord,
  writeSourceFiles,
  type SourceFile,
} from '../store.ts'
import { requestCanvasScreenshot } from '../canvasScreenshot.ts'
import { findPlatformSkill } from '../skills/library.ts'
import type { MiniappManifest, MiniappRecord, MiniappStyle } from '../../../shared/protocol.ts'
import { developerSkillPrompt, developerSkillsCatalogPrompt } from './developerSkills.ts'

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'tool_call'; name: string; summary: string }
  | { type: 'tool_result'; name: string; ok: boolean; detail?: string }
  | { type: 'assistant'; text: string }
  | { type: 'message'; text: string }
  | { type: 'canvas_screenshot_request'; requestId: string }
  | { type: 'build'; ok: boolean; error?: string }
  | { type: 'record'; record: MiniappRecord }
  | { type: 'choices'; choices: { label: string; value: string }[]; allowFreeText?: boolean }
  | { type: 'image'; url: string; alt?: string }
  | { type: 'done'; durationMs?: number }
  | { type: 'error'; message: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

type Emit = (event: AgentEvent) => void

const SKILLS_DIR = resolve(config.repoRoot, 'backend', 'skills')

const STYLE_GUIDANCE: Record<MiniappStyle, string> = {
  default: 'The creator chose the "Default" style — follow the Default (Terr look) section: shadcn-like primitives styled to Terr\'s warm, editorial Fantastic Planet system.',
  modern: 'The creator chose the "Modern" style — follow the Modern section: expressive reactbits/Aceternity-inspired motion and polish, reproduced by hand in React + Tailwind (no imports).',
  custom: 'The creator chose the "Custom" style — follow the Custom section: defer to the creator\'s prompt for look and feel; give only the most basic shadcn-like primitives.',
}

/** The single always-applied design skill. The instruction is built per build so
 *  it names the creator's selected style and points the builder at the matching
 *  section of the skill. */
function appliedDesignSkill(style: MiniappStyle) {
  return {
    name: 'frontend-developer-skill',
    instruction: [
      'Apply this skill to the current miniapp build. Respect the runtime boundary: React + Tailwind + CirrusUI only — never import npm packages.',
      STYLE_GUIDANCE[style],
    ].join(' '),
  }
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function makeModel(): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: config.baseURL,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8000,
    compat: {
      maxTokensField: 'max_completion_tokens',
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsUsageInStreaming: false,
    },
  }
}

async function buildSystemPrompt(record: MiniappRecord, emit: Emit): Promise<string> {
  const style: MiniappStyle = record.draft?.style ?? 'default'
  const skillContext = await loadSkillContext(emit, style)
  return [
    developerSkillPrompt('miniapp_builder'),
    developerSkillsCatalogPrompt(),
    '',
    'Follow the spec exactly. Always end by calling the finish tool after a successful build.',
    'When visual quality, layout, or styling matters, call screenshot_canvas after building to inspect the rendered canvas before you summarize.',
    '',
    MINIAPP_SPEC,
    '',
    skillContext,
    '',
    describeRuntimeSkills(record),
    '',
    `Current miniapp id: ${record.id}. Status: ${record.status}.`,
    record.manifest ? `An existing manifest is present (name: ${record.manifest.name}). You may revise it.` : 'No manifest yet.',
  ]
    .filter(Boolean)
    .join('\n')
}

// Tell the builder which runtime skills this app has, so it wires the UI to call
// them via `agent` actions instead of hardcoding data a skill should provide.
function describeRuntimeSkills(record: MiniappRecord): string {
  const active = (record.skills ?? []).filter((s) => s.status === 'active')
  if (!active.length) return ''
  const lines = active.map((s) => {
    const id = s.source === 'library' ? s.platformSkillId ?? 'library' : s.source
    const plat = s.platformSkillId ? findPlatformSkill(s.platformSkillId) : undefined
    return `- ${s.name} (${id}): ${plat?.description ?? s.description ?? ''}`
  })
  return [
    "## This miniapp's SKILLS (runtime capabilities)",
    'Its kind:"agent" actions route to a runtime agent that can call these skills as tools:',
    ...lines,
    '',
    'Build the app to USE these skills: declare `agent` actions whose agentInstruction tells the runtime agent',
    'which skill to use and what to write into state. Do NOT hardcode data that a skill provides — e.g. if there',
    'is a dataset/library or text-generation skill, fetch that content through an `agent` action at runtime',
    '(a button → useAgentAction → the runtime agent calls the skill → patches state → the UI renders it),',
    'instead of baking a static list into the source.',
  ].join('\n')
}

async function loadSkillContext(emit: Emit, style: MiniappStyle): Promise<string> {
  emit({ type: 'status', text: 'Loading developer skills...' })
  const [{ formatSkillInvocation, formatSkillsForSystemPrompt, loadSkills }, { NodeExecutionEnv }] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-agent-core/node'),
  ])
  const env = new NodeExecutionEnv({ cwd: config.repoRoot, shellEnv: process.env })
  try {
    const { skills, diagnostics } = await loadSkills(env, SKILLS_DIR)
    const warnings = diagnostics.map((d) => `- ${d.path}: ${d.message}`)
    for (const diagnostic of diagnostics) {
      emit({ type: 'status', text: `Skill warning: ${diagnostic.message}` })
    }
    const visibleSkills = formatSkillsForSystemPrompt(skills)
    const appliedSkillInvocations = []
    for (const item of [appliedDesignSkill(style)]) {
      const skill = skills.find((candidate) => candidate.name === item.name)
      if (!skill) {
        emit({ type: 'status', text: `Skill not found: ${item.name}` })
        continue
      }
      emit({ type: 'status', text: `Using skill: ${skill.name} (style: ${style})` })
      appliedSkillInvocations.push(formatSkillInvocation(skill, item.instruction))
    }
    return [
      warnings.length ? `Skill loading warnings:\n${warnings.join('\n')}` : '',
      visibleSkills,
      ...appliedSkillInvocations,
    ]
      .filter(Boolean)
      .join('\n\n')
  } finally {
    await env.cleanup()
  }
}

function validateManifest(input: unknown): MiniappManifest {
  const m = input as Partial<MiniappManifest>
  if (!m || typeof m !== 'object') throw new Error('manifest must be an object')
  if (!m.id || !m.name) throw new Error('manifest.id and manifest.name are required')
  const sm = m.stateModel as MiniappManifest['stateModel'] | undefined
  if (!sm || typeof sm !== 'object') throw new Error('manifest.stateModel is required')
  if (!sm.id) throw new Error('manifest.stateModel.id is required')
  if (!Array.isArray(sm.fields)) throw new Error('manifest.stateModel.fields must be an array')
  if (!sm.initial || typeof sm.initial !== 'object') throw new Error('manifest.stateModel.initial must be an object')
  const actions = Array.isArray(m.actions) ? m.actions : []
  for (const a of actions) {
    if (!a.id || !a.kind) throw new Error('each action needs id and kind')
    if (a.kind === 'agent' && !a.agentInstruction) {
      throw new Error(`agent action "${a.id}" needs an agentInstruction`)
    }
  }
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? '',
    stateModel: sm,
    actions,
  }
}

export async function runDeveloperAgent(
  record: MiniappRecord,
  history: ChatTurn[],
  emit: Emit,
): Promise<MiniappRecord> {
  const model = makeModel()
  const userTurn = history.at(-1)
  if (!userTurn || userTurn.role !== 'user') {
    emit({ type: 'error', message: 'Developer agent needs a final user message.' })
    emit({ type: 'done' })
    return record
  }

  const runState = { wroteThisRun: false }
  const [{ Agent }, { Type }] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
  ])
  const agent = new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(record, emit),
      model,
      thinkingLevel: 'off',
      tools: makeDeveloperTools(Type, record, emit, runState),
      messages: history.slice(0, -1).map((turn, index) => turnToAgentMessage(turn, model, index)),
    },
    getApiKey: () => config.apiKey,
    toolExecution: 'sequential',
    sessionId: record.id,
    maxRetryDelayMs: 60000,
  })

  agent.subscribe((event) => handlePiEvent(event, emit))

  try {
    await agent.prompt({
      role: 'user',
      content: [{ type: 'text', text: userTurn.content }],
      timestamp: Date.now(),
    })
  } catch (err) {
    emit({ type: 'error', message: `Pi agent failed: ${String((err as Error)?.message ?? err)}` })
  }

  emit({ type: 'done' })
  return record
}

function turnToAgentMessage(turn: ChatTurn, model: Model<'openai-completions'>, index: number): AgentMessage {
  const timestamp = Date.now() - Math.max(1, 1000 * (index + 1))
  if (turn.role === 'user') {
    return {
      role: 'user',
      content: [{ type: 'text', text: turn.content }],
      timestamp,
    }
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text: turn.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  }
}

function handlePiEvent(event: PiAgentEvent, emit: Emit) {
  if (event.type !== 'message_end') return
  const message = event.message
  if (message.role !== 'assistant') return
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    emit({ type: 'error', message: message.errorMessage ?? `Assistant stopped with ${message.stopReason}` })
    return
  }
  const text = assistantText(message)
  if (text) emit({ type: 'assistant', text })
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
}

function toolResult(payload: unknown, terminate = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    details: payload,
    terminate,
  }
}

function imageToolResult(payload: unknown, imageUrl: string) {
  const image = dataUrlToImageContent(imageUrl)
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload) },
      ...(image ? [image] : []),
    ],
    details: payload,
  } as any
}

function dataUrlToImageContent(imageUrl: string) {
  const match = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) return null
  return {
    type: 'image' as const,
    data: match[2],
    mimeType: match[1],
  }
}

function makeDeveloperTools(
  Type: typeof import('@earendil-works/pi-ai').Type,
  record: MiniappRecord,
  emit: Emit,
  runState: { wroteThisRun: boolean },
): AgentTool[] {
  return [
    {
      name: 'set_manifest',
      label: 'Set manifest',
      description:
        'Declare or replace the miniapp manifest: id, name, description, the state model, and actions. Call this before writing files.',
      parameters: Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          description: Type.String(),
          stateModel: Type.Object(
            {
              id: Type.String(),
              description: Type.Optional(Type.String()),
              fields: Type.Array(
                Type.Object({
                  name: Type.String(),
                  type: Type.String(),
                  description: Type.Optional(Type.String()),
                }),
              ),
              initial: Type.Record(Type.String(), Type.Any()),
            },
            { additionalProperties: true },
          ),
          actions: Type.Array(
            Type.Object(
              {
                id: Type.String(),
                kind: Type.String(),
                description: Type.String(),
                agentInstruction: Type.Optional(Type.String()),
                payloadExample: Type.Optional(Type.Record(Type.String(), Type.Any())),
              },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as any
        emit({ type: 'tool_call', name: 'set_manifest', summary: `Setting manifest "${args?.name ?? args?.id ?? ''}"` })
        try {
          const manifest = validateManifest(args)
          applyManifest(record, manifest)
          record.status = 'draft'
          saveRecord(record)
          emit({ type: 'tool_result', name: 'set_manifest', ok: true })
          emit({ type: 'record', record })
          return toolResult({ ok: true, manifest })
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          emit({ type: 'tool_result', name: 'set_manifest', ok: false, detail: message })
          return toolResult({ ok: false, error: message })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'write_files',
      label: 'Write files',
      description:
        'Write miniapp source files. Paths are rooted at the runtime src dir; the entry must be app/App.tsx with a default-exported React component.',
      parameters: Type.Object({
        files: Type.Array(
          Type.Object({
            path: Type.String(),
            content: Type.String(),
          }),
        ),
      }),
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as any
        const files = (args?.files ?? []) as SourceFile[]
        const paths = files.map((f) => f.path).join(', ')
        emit({ type: 'tool_call', name: 'write_files', summary: `Writing ${files.length} file(s): ${paths}` })
        try {
          if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array')
          if (!runState.wroteThisRun) {
            clearSourceFiles(record.id)
            runState.wroteThisRun = true
          }
          writeSourceFiles(record.id, files)
          emit({ type: 'tool_result', name: 'write_files', ok: true })
          return toolResult({ ok: true, written: files.map((f) => f.path) })
        } catch (err) {
          const message = String((err as Error)?.message ?? err)
          emit({ type: 'tool_result', name: 'write_files', ok: false, detail: message })
          return toolResult({ ok: false, error: message })
        }
      },
      executionMode: 'sequential',
    },
    {
      name: 'read_files',
      label: 'Read files',
      description: 'Read back the current miniapp source files.',
      parameters: Type.Object({}),
      execute: async () => {
        emit({ type: 'tool_call', name: 'read_files', summary: 'Reading current source files' })
        const files = readSourceFiles(record.id)
        emit({ type: 'tool_result', name: 'read_files', ok: true })
        return toolResult({ ok: true, files })
      },
      executionMode: 'sequential',
    },
    {
      name: 'screenshot_canvas',
      label: 'Screenshot canvas',
      description:
        'Capture the current rendered miniapp canvas as an image for visual review. Use this after building or changing UI when layout, typography, spacing, color, or visual polish matters.',
      parameters: Type.Object({}),
      execute: async () => {
        emit({ type: 'tool_call', name: 'screenshot_canvas', summary: 'Capturing canvas screenshot for visual review' })
        const result = await requestCanvasScreenshot(record.id, emit)
        if (result.ok && result.imageUrl) {
          emit({ type: 'tool_result', name: 'screenshot_canvas', ok: true })
          return imageToolResult(
            {
              ok: true,
              message: 'Canvas screenshot captured. Review the attached image for visual quality before deciding whether to revise files.',
            },
            result.imageUrl,
          )
        }
        const message = result.error ?? 'Canvas screenshot failed.'
        emit({ type: 'tool_result', name: 'screenshot_canvas', ok: false, detail: message })
        return toolResult({ ok: false, error: message })
      },
      executionMode: 'sequential',
    },
    {
      name: 'build',
      label: 'Build',
      description: 'Build the miniapp into a single self-contained HTML file. Returns success or the build error log.',
      parameters: Type.Object({}),
      execute: async () => {
        emit({ type: 'tool_call', name: 'build', summary: 'Building the miniapp...' })
        record.status = 'building'
        saveRecord(record)
        const result = await buildMiniapp(record.id)
        if (result.ok && result.html) {
          record.html = result.html
          record.status = 'ready'
          record.buildError = null
          saveRecord(record)
          emit({ type: 'build', ok: true })
          emit({ type: 'tool_result', name: 'build', ok: true })
          emit({ type: 'record', record })
          return toolResult({ ok: true, message: 'Build succeeded. The miniapp is live in the canvas.' })
        }
        record.status = 'error'
        record.buildError = result.error ?? 'Unknown build error'
        saveRecord(record)
        emit({ type: 'build', ok: false, error: record.buildError })
        emit({ type: 'tool_result', name: 'build', ok: false, detail: 'build failed' })
        emit({ type: 'record', record })
        return toolResult({ ok: false, error: record.buildError })
      },
      executionMode: 'sequential',
    },
    {
      name: 'finish',
      label: 'Finish',
      description: 'Finish the task. Provide a short summary of what you built for the user.',
      parameters: Type.Object({
        summary: Type.String(),
      }),
      execute: async (_toolCallId, rawArgs) => {
        const args = rawArgs as any
        emit({ type: 'tool_call', name: 'finish', summary: 'Finishing up' })
        const summary = String(args?.summary ?? 'Done.')
        emit({ type: 'assistant', text: summary })
        return toolResult({ ok: true }, true)
      },
      executionMode: 'sequential',
    },
  ]
}
