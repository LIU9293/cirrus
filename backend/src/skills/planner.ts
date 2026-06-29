import type { OpenAI } from 'openai'
import { openai, llmModel } from '../agent/client.ts'
import { config } from '../config.ts'
import type {
  SkillCategory,
  SkillDevelopMethod,
  SkillPlan,
  SkillPlanItem,
} from '../../../shared/protocol.ts'
import { PLATFORM_SKILLS, findPlatformSkill, matchPlatformSkill } from './library.ts'

// The skill planner: given what the creator wants the miniapp to do, work out
// the FULL set of skills it needs, then split them into:
//   - matches in the platform library (auto-addable), and
//   - gaps the platform doesn't have (the user must build → generate/integrate/upload).

const CATEGORIES: SkillCategory[] = ['data', 'tool', 'connector', 'trigger', 'ai']

const planTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'propose_plan',
    description: 'Propose the full list of skills the miniapp needs to achieve the goal.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'One entry per distinct capability the app needs. Usually 2-6.',
          items: {
            type: 'object',
            properties: {
              capability: { type: 'string', description: 'The capability in plain words.' },
              name: { type: 'string', description: 'A short skill name.' },
              category: { type: 'string', enum: CATEGORIES },
              reason: { type: 'string', description: 'Why the app needs it (one line).' },
              platformSkillId: {
                type: 'string',
                description:
                  'The id of the matching platform skill from the provided library, or empty string "" if the platform does not have it.',
              },
              connectProvider: {
                type: 'string',
                description:
                  'If this capability connects to an external ACCOUNT the user must authorize (e.g. "gmail", "slack", "notion"), put the provider id here; else "".',
              },
            },
            required: ['capability', 'name', 'category', 'reason', 'platformSkillId'],
          },
        },
      },
      required: ['items'],
    },
  },
}

function suggestMethods(category: SkillCategory): SkillDevelopMethod[] {
  switch (category) {
    case 'data':
      return ['upload', 'generate']
    case 'connector':
      return ['integrate']
    case 'trigger':
      return ['integrate', 'generate']
    default:
      return ['generate', 'integrate']
  }
}

function normalizeItem(raw: any): SkillPlanItem {
  const category: SkillCategory = CATEGORIES.includes(raw?.category) ? raw.category : 'tool'
  const connectProvider =
    typeof raw?.connectProvider === 'string' && raw.connectProvider.trim() ? raw.connectProvider.trim().toLowerCase() : null
  // A connection to an external account. Prefer a built-in skill for that provider
  // (it ships the credentials + tool calls); otherwise it's a custom skill to build.
  if (connectProvider) {
    const builtin = findPlatformSkill(connectProvider) ?? matchPlatformSkill(connectProvider)
    return {
      capability: String(raw?.capability ?? raw?.name ?? 'Connect'),
      name: String(raw?.name ?? builtin?.name ?? connectProvider),
      category: builtin?.category ?? 'connector',
      reason: String(raw?.reason ?? ''),
      platformSkillId: builtin?.id ?? null,
      connectProvider,
      ...(builtin ? {} : { suggestedMethods: ['generate', 'integrate'] }),
    }
  }
  const rawId = typeof raw?.platformSkillId === 'string' ? raw.platformSkillId.trim() : ''
  // Trust the model's id only if it exists; otherwise try a keyword match as a
  // safety net before declaring it a gap.
  const matched =
    (rawId && findPlatformSkill(rawId)) ||
    matchPlatformSkill(`${raw?.capability ?? ''} ${raw?.name ?? ''}`)
  const platformSkillId = matched ? matched.id : null
  return {
    capability: String(raw?.capability ?? raw?.name ?? 'Capability'),
    name: String(raw?.name ?? matched?.name ?? 'Skill'),
    category: matched?.category ?? category,
    reason: String(raw?.reason ?? ''),
    platformSkillId,
    ...(platformSkillId ? {} : { suggestedMethods: suggestMethods(category) }),
  }
}

function needsPersistentDatabase(text: string): boolean {
  return /digest|scan|history|record|store|persist|database|db|analytics|analysis|trend|log|处理结果|记录|存储|数据库|分析|趋势|扫描|摘要/i.test(text)
}

function ensurePersistenceSkill(items: SkillPlanItem[], goal: string): SkillPlanItem[] {
  if (!needsPersistentDatabase(goal)) return items
  if (items.some((item) => item.platformSkillId === 'database')) return items
  const database = findPlatformSkill('database')
  if (!database) return items
  return [
    ...items,
    {
      capability: database.description,
      name: database.name,
      category: database.category,
      reason: 'Persist scan results, analysis snapshots, and agent operation history.',
      platformSkillId: database.id,
    },
  ]
}

export async function planSkills(goal: string, name?: string): Promise<SkillPlan> {
  const system = [
    'You are the Cirrus skill planner. Given what a creator wants their miniapp to do,',
    'list the FEW skills (capabilities) it truly needs. Prefer the SMALLEST set — usually 2 to 4.',
    '',
    'CONSOLIDATE aggressively: group everything that talks to ONE external service into a SINGLE',
    'skill (e.g. all Gmail reading/sending/labeling = ONE "gmail" skill, not separate fetch/classify/send).',
    '',
    'Do NOT create a skill for anything the agent already does with its OWN LLM reasoning —',
    'classifying, summarizing, generating/explaining/rewriting text, ranking, judging. The runtime agent',
    'does those natively; they are NOT skills. Only create a skill for things the agent CANNOT do alone:',
    '  • external data sources / databases (persisting & querying records),',
    '  • connections to external accounts/services (these need the user to authorize),',
    '  • genuinely external tools (web search, image gen, HTTP APIs).',
    '',
    'A skill is a real CAPABILITY (an ability the agent gains). The following are NOT skills — never',
    'propose them; they are configured separately on the RUNTIME, not here:',
    '  • SCHEDULING / cron / "run every hour" / "daily digest at 8am" / recurring runs → a runtime TRIGGER.',
    '  • inbound events / webhooks → a runtime TRIGGER.',
    '  • NOTIFYING / alerting / "send me a summary" / push / delivering output to the user or a channel',
    '    (Slack/email/Discord) → a runtime OUTPUT CHANNEL (a connected bot).',
    'So for "every morning email me a digest of my inbox", the schedule and notification are runtime config,',
    'but the agent still needs database when it must persist scan results, analysis snapshots, trends,',
    'or operation history.',
    '',
    'For each skill: if a platform library skill fits, set platformSkillId to its id (else ""). Do NOT invent ids.',
    'If the skill connects to an external account the user must authorize, set connectProvider (e.g. "gmail"); else "".',
    'Do not list pure UI/dashboards as skills.',
    '',
    'Platform Skills Library:',
    ...PLATFORM_SKILLS.map((s) => `- ${s.id} (${s.category}): ${s.description}`),
  ].join('\n')

  const user = [name ? `Miniapp: ${name}` : '', `Goal: ${goal}`, '', 'Call propose_plan with the skills it needs.']
    .filter(Boolean)
    .join('\n')

  try {
    const completion = await openai.chat.completions.create({
      model: llmModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools: [planTool],
      tool_choice: { type: 'function', function: { name: 'propose_plan' } },
      max_completion_tokens: 2000,
    })
    const call = completion.choices[0]?.message?.tool_calls?.[0]
    const args = call?.type === 'function' && call.function.arguments ? JSON.parse(call.function.arguments) : {}
    const items = Array.isArray(args?.items) ? args.items.map(normalizeItem) : []
    return { items: ensurePersistenceSkill(items, goal) }
  } catch {
    // Deterministic fallback: keyword-match the goal against the library so the
    // flow still works if the model/relay is unavailable.
    const matched = matchPlatformSkill(goal)
    const items: SkillPlanItem[] = matched
      ? [
          {
            capability: matched.description,
            name: matched.name,
            category: matched.category,
            reason: 'Matched from your goal.',
            platformSkillId: matched.id,
          },
        ]
      : []
    return { items: ensurePersistenceSkill(items, goal) }
  }
}
