// shared/protocol.ts
//
// The agent-native miniapp SPEC ("规范"). This is the contract that:
//   - the miniapp-developer-agent must produce (a MiniappManifest + React source),
//   - the host (frontend) enforces and renders,
//   - the runtime agent reads when it answers miniapp actions.
//
// A miniapp is a single self-contained React app rendered inside a sandboxed
// iframe. It never talks to the network directly for app logic; instead it talks
// to the host through `window.CirrusUI` (see shared/bridge.ts). The two things a
// miniapp can do through the bridge are:
//   1. read + persist a typed STATE MODEL (host-owned, survives reload), and
//   2. invoke ACTIONS — either a built-in state mutation or an AGENT action that
//      routes to a runtime agent which can patch the state back.
//
// That is what makes a miniapp "agent native": its buttons can call the agent,
// and the agent answers by mutating the same state the UI renders from.

export const MINIAPP_PROTOCOL = 'terr.app_frame.v1'

/** Built-in action every miniapp can call to persist a shallow patch of state. */
export const SET_STATE_ACTION = 'terr.set_state'

export type StateFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array'

export interface StateField {
  name: string
  type: StateFieldType
  description?: string
}

/** Host-owned, persisted state. The miniapp renders from it and patches it. */
export interface StateModel {
  /** Stable id, e.g. "todo". */
  id: string
  description?: string
  /** Declared top-level fields (documentation + light validation). */
  fields: StateField[]
  /** Initial value pushed to the frame on first mount. */
  initial: Record<string, unknown>
}

export type ActionKind =
  /** Host merges `payload.patch` into the state model. No agent involved. */
  | 'mutate_state'
  /** Routes to the runtime agent, which may patch state and/or return a message. */
  | 'agent'

export interface ActionSpec {
  /** Stable id the miniapp calls via CirrusUI.action(id, payload). */
  id: string
  kind: ActionKind
  description: string
  /**
   * For kind:"agent" — the instruction template handed to the runtime agent.
   * The payload is appended as JSON, plus the current state, plus the manifest.
   */
  agentInstruction?: string
  /** Human-facing JSON-ish shape of the payload, for the agent's reference. */
  payloadExample?: Record<string, unknown>
}

export interface MiniappManifest {
  /** kebab-case id, also the build/workspace folder name. */
  id: string
  name: string
  description: string
  stateModel: StateModel
  actions: ActionSpec[]
}

/** Result of an action, returned through the bridge to the miniapp. */
export interface ActionResult {
  ok: boolean
  status: string
  code: string
  message: string
  retryable: boolean
  actionId: string
  stateVersion?: number
}

/** Lifecycle of a miniapp record on the backend. */
export type MiniappStatus = 'draft' | 'building' | 'ready' | 'error' | 'frozen'

export interface DeveloperChatActivity {
  kind: 'tool' | 'build' | 'error' | 'status'
  text: string
  ok?: boolean
}

/** A button an agent offers the user via ask_user. `value` is sent back as the
 *  user's reply when clicked; `label` is shown. */
export interface ChatChoice {
  label: string
  value: string
}

/** An image an agent sends to the user via send_image. */
export interface ChatImage {
  url: string
  alt?: string
}

export interface DeveloperChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** Optional hidden prompt text used for agent history when UI content omits metadata. */
  agentContent?: string
  content: string
  durationMs?: number
  activities?: DeveloperChatActivity[]
  selectionAttachment?: {
    imageUrl?: string
    label: string
  }
  /** ask_user: buttons offered to the user. */
  choices?: ChatChoice[]
  /** ask_user: whether the user may also type a free-text answer. */
  allowFreeText?: boolean
  /** send_image: images the agent attached to this message. */
  images?: ChatImage[]
}

/**
 * The guided creation flow a creator walks through:
 *   define   — name + goal (identity)
 *   skills   — capabilities the agent gets (data libraries, AI generators, …)
 *   surface  — build the canvas UI (or stay headless)
 *   publish  — review + freeze
 *   done     — flow complete; the app lives in the studio
 */
export type CreationPhase = 'define' | 'skills' | 'surface' | 'publish' | 'done'

/** Coarse grouping for skills, used in the catalog and planner. */
export type SkillCategory = 'data' | 'tool' | 'connector' | 'trigger' | 'ai'

/**
 * A single tool call a skill exposes to the runtime agent. Its `parameters`
 * (JSON Schema) is THE standard contract the agent calls/tests against — the
 * same for built-in and custom skills. See shared/terr_skill_contract.md.
 */
export interface SkillToolCall {
  /** Function name the agent calls, e.g. "gmail_search". */
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters?: Record<string, unknown>
  /** For custom skills: the script file under the skill that implements it. */
  entry?: string
  /** For built-in skills: the platform handler key that implements it. */
  builtin?: string
}

/**
 * One configurable SETTING a skill declares. This is the *contract* (what the
 * skill needs) — it travels with the skill/agent and is shareable. The actual
 * *values* are bound per runtime×agent (see RuntimeAgentBindings), never baked
 * into the shared agent. A credential is just a setting with `secret: true`:
 * secret values are stored in a secrets file off the shared agent and never
 * returned to the client/model; non-secret values ride in the runtime binding.
 */
export interface SkillSetting {
  /** Stable key, e.g. "app_password". */
  key: string
  label: string
  /** Render hint for the settings form. */
  type?: 'text' | 'password' | 'select' | 'textarea' | 'number' | 'boolean'
  options?: { label: string; value: string }[]
  /** Defaults to true. Optional fields can be left blank without blocking readiness. */
  required?: boolean
  /** Masked in the UI, stored in secrets, never returned to client/model. */
  secret?: boolean
  /** Non-secret default shipped with the skill (used until a binding overrides it). */
  default?: unknown
  placeholder?: string
}

/** @deprecated Use SkillSetting — a credential is a setting with `secret: true`. */
export type SkillCredentialField = SkillSetting

/** Whether a skill ships with the platform or was built by the creator. */
export type SkillKind = 'builtin' | 'custom'

/** A skill the platform offers out of the box (the Skills Library). */
export interface PlatformSkill {
  /** Stable catalog id, e.g. "web_search". */
  id: string
  name: string
  category: SkillCategory
  description: string
  /** Keywords the planner matches a capability against. */
  keywords?: string[]
  /** Adding it needs the user to connect/authenticate something. */
  requiresSetup?: boolean
  /** The tool calls this built-in skill exposes (the standard contract). */
  tools?: SkillToolCall[]
  /** Credentials the user must configure when adding it. */
  credentials?: SkillCredentialField[]
  /** Default instance config copied when this platform skill is attached. */
  config?: Record<string, unknown>
}

/** Where a skill instance on a miniapp came from. */
export type SkillSource =
  /** Added straight from the platform library. */
  | 'library'
  /** Authored by the AI (code runs in the sandbox). */
  | 'generated'
  /** Wired to an external API / data source the user provides. */
  | 'integration'

/** Lifecycle of a skill instance. */
export type SkillStatus =
  /** Ready to use. */
  | 'active'
  /** Planned but the platform doesn't have it — needs the user to build it. */
  | 'needs_dev'
  /** Generated/integrated and being set up. */
  | 'building'

/** How a missing (not-in-library) skill gets built. */
export type SkillDevelopMethod =
  /** Let the AI generate the skill's code (runs in the sandbox). */
  | 'generate'
  /** Connect an external API / service / data source. */
  | 'integrate'
  /** Upload a dataset that becomes a readable library. */
  | 'upload'

/** A skill attached to a specific miniapp. */
export interface MiniappSkill {
  /** Stable id within the app. */
  id: string
  name: string
  category: SkillCategory
  description?: string
  source: SkillSource
  status: SkillStatus
  /** Set when source === 'library'. */
  platformSkillId?: string
  /** Whether this skill ships with the platform or was built by the creator. */
  kind?: SkillKind
  /** The tool calls this skill exposes to the agent (the standard contract). */
  tools?: SkillToolCall[]
  /** Credentials the user configures for this skill. */
  credentials?: SkillCredentialField[]
  /** Which credential keys are currently filled (secrets live in the agent folder). */
  credentialsFilled?: string[]
  /** Chosen build method for a 'needs_dev' skill. */
  developMethod?: SkillDevelopMethod
  /** Freeform config: endpoint + auth ref, dataset id, generated code ref, … */
  config?: Record<string, unknown>
}

/** One capability the planner decided the app needs. */
export interface SkillPlanItem {
  /** The capability in plain words, e.g. "access a vocabulary library". */
  capability: string
  /** Proposed skill name + category. */
  name: string
  category: SkillCategory
  /** Why the app needs it. */
  reason: string
  /** Matched platform skill id, or null when the platform doesn't have it. */
  platformSkillId: string | null
  /** Set when this capability connects to an external account that needs the
   *  user's authorization (e.g. "gmail"). Becomes a connector skill with auth. */
  connectProvider?: string | null
  /** For missing skills: suggested build methods, best first. */
  suggestedMethods?: SkillDevelopMethod[]
}

/** Result of analysing a goal into the full set of skills it needs. */
export interface SkillPlan {
  items: SkillPlanItem[]
}

/** Captured during the Define step, before a manifest exists. */
export interface MiniappDraft {
  name?: string
  goal?: string
}

/** A signed-in user (Google-backed). Stored server-side. */
export interface User {
  id: string
  /** Google's stable subject id; the unique key for matching on login. */
  googleSub: string
  email: string
  name?: string
  picture?: string
  createdAt: string
  updatedAt: string
}

/** The safe subset of a user returned to the client. */
export interface AuthUser {
  id: string
  email: string
  name?: string
  picture?: string
}

export interface MiniappRecord {
  id: string
  /** The user who owns this agent. My-agents are private to their owner. */
  ownerId: string
  /** Reserved for future "publish to community"; defaults to private. */
  visibility?: 'private' | 'public'
  manifest: MiniappManifest | null
  status: MiniappStatus
  /** Built single-file HTML (no bridge yet — the host injects it). */
  html: string | null
  /** Persisted state model value (the live, host-owned state). */
  state: Record<string, unknown>
  stateVersion: number
  buildError: string | null
  /** Whether the miniapp source is frozen (固化) and no longer editable. */
  frozen: boolean
  /** Where the creator is in the guided Define→Skills→Surface→Publish flow. */
  creationPhase?: CreationPhase
  /** Identity captured in the Define step (before a manifest is set). */
  draft?: MiniappDraft
  /** Skills added in the Skills step. */
  skills?: MiniappSkill[]
  /** Persisted developer chat for reconstructing how this miniapp was built. */
  messages: DeveloperChatMessage[]
  /** Persisted live-user chat with this miniapp's runtime agent. */
  liveMessages: DeveloperChatMessage[]
  /** The Define-step onboarding conversation with the concept agent. */
  defineMessages?: DeveloperChatMessage[]
  updatedAt: string
}

export interface CanvasElementSelection {
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/* ───────── Runtimes ─────────
 * A Runtime is a running home for one or more agents, backed by a real E2B
 * sandbox. The user interacts with the runtime as the unit: chat with it, view
 * a hosted miniapp, and connect bots to reach it from chat platforms. */

export type RuntimeStatus =
  | 'provisioning' // sandbox is being created
  | 'running' // backed by a live E2B sandbox
  | 'paused' // backed by a paused E2B sandbox
  | 'local' // no E2B available — runs in degraded local mode
  | 'error' // provisioning failed
  | 'stopped'

export type BotPlatform = 'slack' | 'discord' | 'lark'

export interface RuntimeBot {
  id: string
  platform: BotPlatform
  label: string
  connectedAt: string
  /** Stored server-side only; redacted from API responses. */
  token?: string
  /** Whether a token was provided (sent to the client instead of the token). */
  hasToken?: boolean
}

/** A reference to an agent placed in a runtime. `miniappId` is set for the
 *  user's own agents; community agents are referenced by name only. */
export type RuntimeAgentModelMode =
  /** Use Cirrus's platform LLM settings. This is the only fully implemented mode today. */
  | 'platform'
  /** User supplies an OpenAI-compatible endpoint + API key. Skeleton only for now. */
  | 'custom_llm_api'
  /** User authorizes a subscription-backed product/CLI inside the runtime. Skeleton only for now. */
  | 'subscription_auth'

export interface RuntimeAgentModelConfig {
  mode: RuntimeAgentModelMode
  platformModel?: string
  customEndpoint?: string
  customApiKeySet?: boolean
  subscriptionProvider?: 'codex' | 'claude_code' | 'opencode' | string
  authStatus?: 'not_configured' | 'pending' | 'authorized' | 'error'
}

export type RuntimeAgentInstallStatus = 'not_installed' | 'installing' | 'ready' | 'failed' | 'not_supported'

export interface RuntimeAgentInstallation {
  status: RuntimeAgentInstallStatus
  adapter?: string
  version?: string
  installedAt?: string
  error?: string | null
  logs?: string[]
}

/** Per-skill setting values bound for one agent inside one runtime. Non-secret
 *  values live here (in the runtime record); secret values live in a secrets file
 *  off the shared agent and only their keys are listed in `secretsFilled`. */
export interface RuntimeAgentSkillBinding {
  /** Non-secret setting values overriding the skill/agent defaults. */
  config?: Record<string, unknown>
  /** Which secret setting keys are filled (the values are stored on disk). */
  secretsFilled?: string[]
}

/** All skill setting bindings for one agent in one runtime, keyed by the skill's
 *  binding key (platformSkillId when built-in, else the skill instance id). */
export interface RuntimeAgentBindings {
  skills?: Record<string, RuntimeAgentSkillBinding>
}

export interface RuntimeAgentRef {
  key: string
  name: string
  source: 'own' | 'community'
  miniappId?: string
  modelConfig?: RuntimeAgentModelConfig
  installation?: RuntimeAgentInstallation
  capabilities?: string[]
  /** Per-runtime configuration: this agent's skill settings/credentials in THIS
   *  runtime. Lets the same shared agent be configured differently per runtime. */
  bindings?: RuntimeAgentBindings
}

export interface RuntimeRecord {
  id: string
  /** The user who owns this runtime. Runtimes are private to their owner. */
  ownerId: string
  name: string
  agents: RuntimeAgentRef[]
  status: RuntimeStatus
  /** E2B sandbox id when running, else null. */
  sandboxId: string | null
  sandboxKind: 'e2b' | 'local'
  sandboxError?: string | null
  bots: RuntimeBot[]
  messages: DeveloperChatMessage[]
  createdAt: string
  updatedAt: string
}

/** A scheduled task: on its cron schedule, `message` is sent to an agent in the
 *  runtime exactly as if a user typed it into the runtime chat. */
export interface CronJob {
  id: string
  runtimeId: string
  ownerId: string
  /** Short human label for the job. */
  name: string
  /** Standard 5-field cron expression (minute hour day-of-month month day-of-week). */
  schedule: string
  /** The message delivered to the agent when the job fires. */
  message: string
  /** Which agent to address (RuntimeAgentRef.key). Null = let the runtime route it. */
  targetAgentKey?: string | null
  enabled: boolean
  lastRunAt?: string | null
  /** Outcome summary of the most recent run (assistant reply, truncated). */
  lastRunStatus?: string | null
  nextRunAt?: string | null
  createdAt: string
  updatedAt: string
}
