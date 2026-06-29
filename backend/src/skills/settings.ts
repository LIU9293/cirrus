import { query } from '../db.ts'
import { readAgentFile, writeAgentFile } from '../agentfs.ts'
import { findPlatformSkill } from './library.ts'
import { isPlainObject, type MiniappRecord, type MiniappSkill, type SkillSetting } from '../../../shared/protocol.ts'

// Skill SETTINGS resolution. A skill DECLARES the settings it needs (the contract,
// shareable with the agent). The VALUES are bound per runtime×agent so the same
// shared agent can be configured differently in each runtime and by each user:
//
//   skill defaults  →  agent dev/default binding  →  runtime×agent binding   (last wins)
//
// Secret values (credentials) never live in the shared agent record. They are
// written to a secrets file: per-runtime when a runtime context is given, else the
// agent's own dev folder. Non-secret values ride in the runtime record binding.

export interface SkillBindingContext {
  record: MiniappRecord
  /** When set, settings resolve against this runtime's per-agent binding. */
  runtimeId?: string
  /** The RuntimeAgentRef.key this binding belongs to (e.g. "own:app-xxx"). */
  agentKey?: string
}

export interface ResolvedSkillSettings {
  /** Non-secret config: skill/agent defaults overlaid with the runtime binding. */
  config: Record<string, unknown>
  /** Full value bag (non-secret + secret) the tool layer reads, resolved for ctx. */
  credentials: Record<string, string>
}

/** The key a skill's settings/secrets are stored under (platform id when built-in). */
export function skillBindingKey(skill: MiniappSkill): string {
  return skill.platformSkillId ?? skill.id
}

/** The settings a skill declares — platform contract for library skills, else the
 *  skill's own declared settings. (`credentials` is the legacy field name.) */
export function declaredSettings(skill: MiniappSkill): SkillSetting[] {
  const platform = skill.platformSkillId ? findPlatformSkill(skill.platformSkillId) : undefined
  return (platform?.credentials ?? skill.credentials ?? []) as SkillSetting[]
}

const SAFE_KEY = /[^a-zA-Z0-9._-]+/g
function agentDirName(key: string): string {
  return key.replace(SAFE_KEY, '_')
}

/** runtime_files path key for a runtime×agent×skill secret blob. */
function runtimeSecretPath(agentKey: string, bindingKey: string): string {
  return `agents/${agentDirName(agentKey)}/secrets/${bindingKey}.json`
}

/** The agent's own (dev / default) secrets, stored in the agent folder (miniapp_files). */
async function readDevSecrets(record: MiniappRecord, bindingKey: string): Promise<Record<string, string>> {
  try {
    return JSON.parse((await readAgentFile(record.id, `secrets/${bindingKey}.json`)) ?? '{}')
  } catch {
    return {}
  }
}

async function readRuntimeSecrets(ctx: SkillBindingContext, bindingKey: string): Promise<Record<string, string>> {
  if (!ctx.runtimeId || !ctx.agentKey) return {}
  try {
    const { rows } = await query<{ content: string }>(
      'select content from runtime_files where runtime_id = $1 and path = $2',
      [ctx.runtimeId, runtimeSecretPath(ctx.agentKey, bindingKey)],
    )
    return rows[0] ? JSON.parse(rows[0].content) : {}
  } catch {
    return {}
  }
}

async function writeRuntimeSecrets(ctx: SkillBindingContext, bindingKey: string, secretObj: Record<string, string>): Promise<void> {
  await query(
    `insert into runtime_files (runtime_id, path, content, updated_at) values ($1, $2, $3, now())
     on conflict (runtime_id, path) do update set content = excluded.content, updated_at = now()`,
    [ctx.runtimeId, runtimeSecretPath(ctx.agentKey!, bindingKey), JSON.stringify(secretObj, null, 2)],
  )
}

/** The non-secret binding values stored on the runtime record for this agent+skill. */
async function runtimeBindingConfig(ctx: SkillBindingContext, bindingKey: string): Promise<Record<string, unknown>> {
  if (!ctx.runtimeId || !ctx.agentKey) return {}
  try {
    const { rows } = await query<{ data: { agents?: { key?: string; bindings?: { skills?: Record<string, { config?: unknown }> } }[] } }>(
      'select data from runtimes where id = $1',
      [ctx.runtimeId],
    )
    const agent = (rows[0]?.data?.agents ?? []).find((a) => a.key === ctx.agentKey)
    const cfg = agent?.bindings?.skills?.[bindingKey]?.config
    return isPlainObject(cfg) ? cfg : {}
  } catch {
    return {}
  }
}

function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = String(v)
  return out
}

/**
 * Resolve a skill's effective settings for this context. Secret values come from
 * the runtime secrets file (falling back to the agent's dev secrets so existing
 * single-user data keeps working); non-secret values layer skill/agent defaults
 * under the runtime binding.
 */
export async function resolveSkillSettings(ctx: SkillBindingContext, skill: MiniappSkill): Promise<ResolvedSkillSettings> {
  const bindingKey = skillBindingKey(skill)
  const platform = skill.platformSkillId ? findPlatformSkill(skill.platformSkillId) : undefined
  const declared = declaredSettings(skill)

  const settingDefaults: Record<string, unknown> = {}
  for (const s of declared) if (!s.secret && s.default !== undefined) settingDefaults[s.key] = s.default

  const bindingConfig = await runtimeBindingConfig(ctx, bindingKey)
  const config = {
    ...settingDefaults,
    ...(isPlainObject(platform?.config) ? platform!.config : {}),
    ...(isPlainObject(skill.config) ? skill.config : {}),
    ...bindingConfig,
  }

  // The value bag the tool layer reads (creds.base_url, creds.token, …) and the
  // settings form prefills from. The skill's declared non-secret defaults are the
  // lowest layer (so e.g. imap_host=imap.gmail.com shows up without re-typing);
  // dev/runtime bindings and secrets override them.
  const credentials: Record<string, string> = {
    ...stringifyValues(settingDefaults),
    ...(await readDevSecrets(ctx.record, bindingKey)),
    ...stringifyValues(bindingConfig),
    ...(await readRuntimeSecrets(ctx, bindingKey)),
  }

  return { config, credentials }
}

export interface WriteSettingsResult {
  secretsFilled: string[]
  /** Non-secret values to persist on the runtime record binding. */
  config: Record<string, unknown>
  /** Non-secret values safe to echo back to the client. */
  publicValues: Record<string, string>
}

/**
 * Persist setting values for a context. Secret values go to the secrets file
 * (runtime-scoped when ctx carries a runtime, else the agent dev folder); the
 * returned `config` holds the non-secret values for the caller to store on the
 * runtime binding (dev callers fold them into the dev secrets file instead).
 */
export async function writeSkillSettings(
  ctx: SkillBindingContext,
  skill: MiniappSkill,
  values: Record<string, unknown>,
): Promise<WriteSettingsResult> {
  const bindingKey = skillBindingKey(skill)
  const declared = declaredSettings(skill)
  const isRuntime = Boolean(ctx.runtimeId && ctx.agentKey)

  const secretObj: Record<string, string> = isRuntime
    ? await readRuntimeSecrets(ctx, bindingKey)
    : await readDevSecrets(ctx.record, bindingKey)
  const config: Record<string, unknown> = {}

  for (const s of declared) {
    const raw = values[s.key]
    if (raw === undefined) continue
    const v = String(raw ?? '').trim()
    if (!v) continue
    if (s.secret) secretObj[s.key] = v
    else config[s.key] = v
  }

  if (isRuntime) {
    await writeRuntimeSecrets(ctx, bindingKey, secretObj)
  } else {
    // Dev/default binding: keep the legacy single secrets file with everything.
    const merged = { ...secretObj, ...stringifyValues(config) }
    await writeAgentFile(ctx.record.id, `secrets/${bindingKey}.json`, JSON.stringify(merged, null, 2))
  }

  const secretsFilled = declared.filter((s) => s.secret && secretObj[s.key]).map((s) => s.key)
  const publicValues: Record<string, string> = {}
  for (const s of declared) if (!s.secret && config[s.key]) publicValues[s.key] = String(config[s.key])
  return { secretsFilled, config, publicValues }
}

/** Which declared setting keys currently have a value, for readiness checks/echo. */
export async function settingsFilled(ctx: SkillBindingContext, skill: MiniappSkill): Promise<string[]> {
  const { credentials } = await resolveSkillSettings(ctx, skill)
  return declaredSettings(skill)
    .map((s) => s.key)
    .filter((k) => credentials[k])
}
