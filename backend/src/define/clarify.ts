import type { OpenAI } from 'openai'
import { openai } from '../agent/client.ts'
import { config } from '../config.ts'
import type { ChatTurn } from '../agent/developerAgent.ts'
import { developerSkillPrompt } from '../agent/developerSkills.ts'

// The Define-step concept agent. It interviews the creator until there's a
// COMPLETE agent-native app concept, then hands back a name + goal. An
// agent-native app = instructions + skills (data/tools/procedures) + triggers +
// a surface. If a key piece is missing, it asks ONE focused question.

export interface ClarifyResult {
  ready: boolean
  /** Next clarifying question (when ready === false). */
  question?: string
  /** Final concept (when ready === true). */
  name?: string
  goal?: string
}

const respondTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'respond',
    description: 'Either ask the next clarifying question, or declare the concept ready with a name + goal.',
    parameters: {
      type: 'object',
      properties: {
        ready: { type: 'boolean', description: 'true only when the concept is complete enough to plan & build.' },
        question: { type: 'string', description: 'One concise clarifying question (when ready=false).' },
        name: { type: 'string', description: 'Short app name (when ready=true).' },
        goal: { type: 'string', description: 'A one-paragraph goal capturing the full concept (when ready=true).' },
      },
      required: ['ready'],
    },
  },
}

export async function clarifyConcept(history: ChatTurn[], context = ''): Promise<ClarifyResult> {
  const system = [
    developerSkillPrompt('requirements_onboarding'),
    'An agent-native app = an agent (instructions/persona) that drives capabilities:',
    'data sources, tools, procedures (skills), triggers/schedules, and a surface (canvas / chat / API).',
    '',
    context.trim()
      ? [
          'Current requirements context from the product UI:',
          context.trim(),
          '',
          'When the creator says "this requirement", "the requirement", "这个需求", or similar, they mean the current requirements context above.',
          'Discuss the requirement directly. If they ask for suggestions, give concise product/agent-design suggestions first, then ask at most one focused follow-up question if needed.',
        ].join('\n')
      : '',
    '',
    'Interview the creator. If the idea is vague or missing a key dimension — what it actually does,',
    'where its data comes from, when/how it runs (on demand vs scheduled vs event), and what the user sees —',
    'ask ONE focused question at a time (ready=false, question). Do not ask more than needed; 1-3 questions is typical.',
    'When you have a complete picture, call respond with ready=true, a short name, and a one-paragraph goal that',
    'captures what it does + its data + its trigger + its surface. Keep the goal concrete and buildable.',
    'Always call the respond tool.',
  ].join('\n')

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...history.map((t) => ({ role: t.role, content: t.content }) as OpenAI.Chat.Completions.ChatCompletionMessageParam),
  ]

  try {
    const c = await openai.chat.completions.create({
      model: config.model,
      messages,
      tools: [respondTool],
      tool_choice: { type: 'function', function: { name: 'respond' } },
      max_completion_tokens: 800,
    })
    const call = c.choices[0]?.message?.tool_calls?.[0]
    const args = call?.type === 'function' && call.function.arguments ? JSON.parse(call.function.arguments) : {}
    if (args?.ready) {
      return { ready: true, name: String(args.name ?? '').trim(), goal: String(args.goal ?? '').trim() }
    }
    return { ready: false, question: String(args?.question ?? 'Can you tell me a bit more about what it should do?') }
  } catch (err) {
    return { ready: false, question: `(couldn't reach the model: ${String((err as Error)?.message ?? err)}) — try again?` }
  }
}
