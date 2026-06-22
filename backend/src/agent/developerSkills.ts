export type DeveloperAgentSkillId =
  | 'requirements_onboarding'
  | 'agent_spec_planner'
  | 'skill_planner'
  | 'skill_contract_editor'
  | 'surface_designer'
  | 'miniapp_builder'
  | 'miniapp_debugger'
  | 'runtime_tester'
  | 'publish_reviewer'

export interface DeveloperAgentSkill {
  id: DeveloperAgentSkillId
  name: string
  purpose: string
  system: string[]
}

export const DEVELOPER_AGENT_SKILLS: Record<DeveloperAgentSkillId, DeveloperAgentSkill> = {
  requirements_onboarding: {
    id: 'requirements_onboarding',
    name: 'requirements_onboarding',
    purpose: 'Clarify and summarize the creator requirements before planning/building.',
    system: [
      'Developer skill: requirements_onboarding.',
      'Help the creator define an agent-native app before it is built.',
      'Focus on the agent purpose, data sources, triggers/schedules, capabilities, and surfaces.',
      'Ask one focused question at a time unless the creator asks for suggestions.',
    ],
  },
  agent_spec_planner: {
    id: 'agent_spec_planner',
    name: 'agent_spec_planner',
    purpose: 'Convert requirements into an agent specification: purpose, skills, surfaces, actions, state.',
    system: [
      'Developer skill: agent_spec_planner.',
      'Turn requirements into a concrete agent specification with purpose, capabilities, surfaces, runtime actions, and state shape.',
    ],
  },
  skill_planner: {
    id: 'skill_planner',
    name: 'skill_planner',
    purpose: 'Plan which platform or custom skills an agent needs.',
    system: [
      'Developer skill: skill_planner.',
      'Identify the minimal set of platform/custom skills the agent needs and explain why each capability is required.',
    ],
  },
  skill_contract_editor: {
    id: 'skill_contract_editor',
    name: 'skill_contract_editor',
    purpose: 'Edit one skill contract: README, tool calls, credentials, config, and status.',
    system: [
      'Developer skill: skill_contract_editor.',
      'Stay scoped to one skill. Use the full agent context only to explain how this skill fits with the purpose, other skills, and surfaces.',
      'When changing a skill, update only that current skill contract.',
    ],
  },
  surface_designer: {
    id: 'surface_designer',
    name: 'surface_designer',
    purpose: 'Design or refine one user-facing surface such as Chat or Mini App.',
    system: [
      'Developer skill: surface_designer.',
      'Stay scoped to one surface. Account for the agent purpose, all skills, and other surfaces.',
      'Discuss surface behavior, UX, state, actions, and how the surface should use the agent skills.',
    ],
  },
  miniapp_builder: {
    id: 'miniapp_builder',
    name: 'miniapp_builder',
    purpose: 'Build the miniapp manifest/source and produce a working visual surface.',
    system: [
      'Developer skill: miniapp_builder.',
      'Build agent-native miniapps by setting manifest, writing source files, building, and finishing with a summary.',
      'Use runtime skills through agent actions instead of hardcoding data those skills provide.',
    ],
  },
  miniapp_debugger: {
    id: 'miniapp_debugger',
    name: 'miniapp_debugger',
    purpose: 'Debug miniapp build/runtime/UI issues and repair the source.',
    system: [
      'Developer skill: miniapp_debugger.',
      'Use build errors, screenshots, and runtime state to make the smallest source or manifest fix that restores the miniapp.',
    ],
  },
  runtime_tester: {
    id: 'runtime_tester',
    name: 'runtime_tester',
    purpose: 'Place an agent in a runtime, test actions/chat/skills, and report activity.',
    system: [
      'Developer skill: runtime_tester.',
      'Test the agent inside a runtime. Prefer sandbox-backed runtime paths and report which skills/tools were actually invoked.',
    ],
  },
  publish_reviewer: {
    id: 'publish_reviewer',
    name: 'publish_reviewer',
    purpose: 'Review readiness before publishing/updating an agent.',
    system: [
      'Developer skill: publish_reviewer.',
      'Check missing credentials, inactive skills, missing surfaces, unsafe actions, and validation gaps before publishing.',
    ],
  },
}

export function developerSkillPrompt(id: DeveloperAgentSkillId, scopedPrompt?: string): string {
  const skill = DEVELOPER_AGENT_SKILLS[id]
  return [
    'You are the Terr Developer Agent.',
    'You are one unified creator-side agent. Different Studio panels activate different Developer Agent skills and scoped context.',
    `Active Developer Agent skill: ${skill.name}.`,
    `Skill purpose: ${skill.purpose}`,
    ...skill.system,
    scopedPrompt ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function developerSkillsCatalogPrompt(): string {
  return [
    '## Developer Agent skills',
    ...Object.values(DEVELOPER_AGENT_SKILLS).map((skill) => `- ${skill.name}: ${skill.purpose}`),
  ].join('\n')
}
