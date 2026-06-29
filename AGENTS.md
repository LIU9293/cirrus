# Series Agent Guidelines

This repository is evolving from a Mini App Canvas prototype into a platform for
managing **Skills** and **Agents**. Use this file as the project compass when
planning or implementing product work.

## Product Goal

Series should help users create, inspect, configure, share, install, and run
agents and the skills those agents depend on.

The long-term product focus is:

1. Skill management: make skills explicit, inspectable, testable, shareable, and
   installable.
2. Agent management: make agents easy to define, equip with skills, configure,
   run, and reuse across runtimes.
3. Visual creation and maintenance: let users see and edit what an agent or skill
   actually contains instead of treating prompts and tools as opaque text.

Mini App Canvas remains useful as one possible agent surface, but it is no
longer the center of the product. Do not over-optimize new work around miniapp
generation unless the task explicitly asks for it. Prefer changes that improve
the Skill and Agent management model.

## Platform Positioning (Open Control Plane)

The platform is an **open control plane for skills and agents**: it manages,
connects, and orchestrates — it does not have to own the compute. By default a
user can **bring their own model** (LLM endpoint + key) and **their own sandbox**
(E2B / Daytona / …) and run everything on their own backends. The platform's
value is management, composition, a community registry, and orchestration — a
**manager + connector**, not the runtime owner.

Hosted model and hosted sandbox are an optional, paid convenience tier offered
later, never a requirement. Therefore: design every compute-touching feature so
it resolves the **acting user's** configuration first and treats the platform's
own model/sandbox as a fallback default.

## Information Architecture

There are two surfaces.

**Community (discovery)** — `/skills` and `/agents` show ONLY public / shared
skills and agents. They are a registry, not a workspace: browse is open (login
optional), installing or forking into a workspace requires login. A user's own
skills/agents must NOT appear here.

**Dashboard (the user's workspace)** — everything the user owns, under
`/dashboard/*`:

- **Skills** — the user's authored skills.
- **Agents** — the user's agents.
- **Bots** — reusable bot connectors (Telegram/Discord/…).
- **Runtimes** — running homes that compose agents + a model + a sandbox + bots.
- **Model** — the user's LLM connection configs.
- **Sandbox** — the user's sandbox/compute connection configs.
- **Settings** — profile, avatar, account.

### Connection Resources (Model, Sandbox, Bot)

Model, Sandbox, and Bot are **user-level, reusable connection resources**. Each
holds a secret the platform stores but never returns to the client.

- **Model config** — `{ name, endpoint, apiKey (secret), model }`. A user may have
  **several**; one is the **default** (used for studio/authoring LLM calls that
  are not tied to a runtime — clarify, plan, draft, refine, skill chat).
- **Sandbox config** — `{ name, provider (e2b | daytona | …), apiKey (secret), … }`.
  Same shape: several allowed, one default (used for studio testing).
- **Bot** — `{ name, platform, token (secret) }`. Created in the dashboard and
  **attached** to a runtime (pick from your bots, do not paste tokens inline).
  A bot binds to **at most one active runtime** at a time (single-consumer
  long-poll reality).

### Runtime Composition

A **Runtime** composes: selected agents + one Model config + one Sandbox config +
zero or more attached Bots. Each runtime may select **different** model/sandbox
configs; if none is selected it inherits the user's default, and if the user has
none it falls back to the platform default. Triggers (cron) and channels (bots)
stay runtime-level — they are not skills.

## Bring-Your-Own Compute — resolution order

Wherever the platform calls an LLM or a sandbox, resolve in this order:

1. The **runtime's selected** config (for runtime operations), or the **user's
   default** config (for studio/authoring operations).
2. The **platform default** model/sandbox — a shared, rate-limited fallback so a
   new user can start with nothing configured.
3. (Future) a paid hosted tier.

Implementation implications:

- There is no single global LLM client for user-facing work. Server code resolves
  a per-user / per-runtime client+model through a resolver (e.g. `llmFor(userId)`
  / `llmForRuntime(runtime)`), threaded through every call site. The current
  global `backend/src/agent/client.ts` becomes the platform-default fallback only.
- The sandbox driver is likewise resolved per user/runtime (add a Daytona driver
  alongside the existing e2b/local drivers).
- User model/sandbox/bot keys are secrets: store in a user-scoped secret store,
  never return raw values, mask in the UI.
- A user's model must support tool/function-calling for skill planning and tool
  use; surface this requirement in the Model page.

### Runtime Image (portable sandbox environment)

The runtime environment (the six community-agent CLIs) is a **single public OCI
image** — `backend/runtime-image/Dockerfile`, `config.runtimeImage`. This is the
one source of truth, because a custom E2B template / Daytona snapshot is private
to the org that built it, but users bring their **own** sandbox keys (a different
org) that can't see it. A public image is the portable unit both providers pull
regardless of whose key is used:

- **Daytona** — `create({ image: runtimeImage })` pulls it directly at create.
- **E2B** — the template is built FROM it (`Template.fromImage`, see
  `scripts/buildRuntimeTemplate.ts`); referenced by name as `runtimeSandboxTemplate`.

`sandbox/runtimeSandbox.ts` is provider-agnostic: `resolveTarget()` picks provider
+ key from the request's BYO sandbox → platform E2B env, and provision / run /
status / kill dispatch by provider. `sandboxKind` is `e2b | daytona | local`;
non-`local` means "real sandbox."

> **Known follow-up:** a runtime is provisioned with whatever sandbox the request
> resolved (owner default at create time). If a user later points the runtime at a
> *different* sandbox connection via the compute PATCH, the existing persistent
> sandbox is **not** re-provisioned — changing a runtime's sandbox should kill the
> old sandbox and provision a new one (then reinstall agents).

### Build Order

1. Dashboard shell + IA split (move "My skills/agents" off the community pages)
   and a user-scoped settings/secret store.
2. Model (BYO LLM) configs + the `llmFor` resolver threaded through call sites.
3. Sandbox configs (E2B now; add a Daytona driver) selectable per runtime.
4. Bots as a dashboard resource, attachable to a runtime.
5. Community publish / fork polish.

## Core Definitions

### Agent

An Agent is a reusable runtime unit made of:

- identity and purpose (`agent.md`, the agent README/system instructions),
- installed Skills,
- per-runtime configuration and secrets for those Skills,
- optional surfaces such as chat, API, bot integrations, or Mini App Canvas,
- runtime state, memory, logs, and scheduled/background work.

An Agent should be understandable without opening generated UI code. The user
should be able to answer: what is this agent for, which skills can it call, what
is configured, what is missing, and where can it run?

### Skill

A Skill is a self-contained capability package that can be installed into an
Agent. It should follow a shape close to Vercel AI SDK tool conventions:

- `name`: stable, human-readable identifier.
- `description`: what capability the skill gives the agent.
- `skill.md`: usage guidance, constraints, examples, and operating
  notes for the agent and the creator.
- `tools[]`: tool-call definitions the agent can invoke.
- `parameters` / input schema: JSON-schema-like contract for each tool call.
- implementation: built-in handler, script entrypoint, or no-code instruction.
- `configuration`: non-secret install-time or runtime settings.
- `secrets`: sensitive settings such as API keys or tokens.
- tests/examples: sample inputs and expected behavior where possible.

Skill contracts must be shareable without leaking user-specific values. The
contract declares which configuration and secrets are needed; installation or
runtime binding supplies the actual values.

## Skill Capability Types

Every skill detail view should make the implementation type visible. Users
should not have to guess whether a capability is executable code or just
guidance for the agent.

### Code-backed Tools

These are real callable tools implemented by code:

- platform built-in handler, for example `builtin: "gmail_search"`;
- custom script entrypoint, for example `entry: "gmail_search.ts"`;
- generated or uploaded implementation.

The UI should show:

- tool name, description, and input schema,
- which handler or script implements it,
- source code when available and safe to show,
- test controls and recent test results,
- runtime call logs or last execution status when available.

### Instruction-only Capabilities

These are README-driven capabilities with no executable tool implementation.
They teach the agent how to do something using reasoning, conversation, or other
installed tools.

The UI should label them clearly as instruction-only. They can still be valuable,
but they should not appear as deterministic callable tools. Users should see the
README section that defines the behavior and any dependencies on other tools.

### Hybrid Skills

Many useful skills are hybrid: a README explains policy and workflow, while one
or more tools provide executable access to external systems. Treat the README as
the operating manual and the tools as the callable interface.

## Configuration and Secrets

Configurations are non-secret values, such as base URLs, default repositories,
feature toggles, table names, or user preferences.

Secrets are sensitive values, such as API keys, access tokens, passwords, and
private credentials.

Rules:

- Never bake secret values into a shareable Skill or Agent definition.
- A shared Skill declares required secrets; the installing user supplies them.
- Runtime-specific bindings should override agent defaults so the same shared
  agent can run in different contexts.
- The UI may show whether a secret is configured, but not the value.
- Tool execution receives resolved settings through the platform, not by asking
  the agent model to remember secrets.

## Skill Visualization Requirements

When building Skill management UI, prioritize direct inspection over abstract
cards. A good Skill page should show:

- README / skill instructions.
- Tools list with schemas and implementation type.
- Script tree or implementation files.
- Configurations and secrets, separated and clearly labeled.
- Install status and readiness status.
- Test runner for code-backed tools.
- Dependencies on other skills or external services.
- Version/source information when available.

For each tool, show whether it is:

- built-in platform code,
- custom script code,
- generated code,
- external API wrapper,
- instruction-only/no-code.

## Agent Visualization Requirements

When building Agent management UI, show the agent as a composition of skills and
runtime bindings, not just as a chat box or miniapp.

The agent page should make these visible:

- agent identity and `agent.md`,
- installed skills and readiness,
- missing configuration/secrets,
- active runtimes and runtime-specific bindings,
- available surfaces: chat, API, bot, Mini App Canvas,
- logs of skill calls and failures,
- scheduled/background jobs,
- publish/share/install state.

## Current Architecture Notes

The repository still contains older naming and prototype concepts:

- `Cirrus`, `Terr`, and `Series` may appear together. Treat Series as the current
  product direction unless the task is explicitly about legacy naming.
- `MiniappRecord` currently stores agent-like records, skills, messages, and
  optional miniapp HTML.
- `shared/terr_skill_contract.md` contains the current Skill contract.
- `shared/protocol.ts` contains the TypeScript model for `MiniappSkill`,
  `PlatformSkill`, tool calls, settings, and creation phases.
- `backend/src/skills/*` contains Skill planning, library, settings, and service
  logic.
- `frontend/src/wizard/AgentCanvas.tsx` contains the current visual creation and
  management flow.
- `miniapp-runtime` is a generated-surface runtime; it should not dominate future
  Skill/Agent management work.

## Engineering Priorities

When choosing implementation direction:

1. Prefer explicit Skill/Agent data models over implicit prompt-only behavior.
2. Preserve shareability: contracts travel; user values bind at install/runtime.
3. Make readiness inspectable: missing config, missing secrets, failing tests, and
   instruction-only limitations should be visible.
4. Use the same tool-call contract for built-in and custom skills.
5. Avoid creating fake skills for things the base agent can already do through
   reasoning. Skills should represent real external capability, durable data, or
   reusable operating procedure.
6. Treat scheduling, channels, and runtimes as agent/runtime configuration unless
   a task explicitly defines them as skills.
7. Keep Mini App Canvas as an optional surface, not the main product abstraction.

## Documentation Expectations

When changing Skill or Agent behavior, update the relevant docs or contracts:

- `AGENTS.md` for product direction and cross-cutting definitions.
- `shared/terr_skill_contract.md` for the formal Skill contract.
- `shared/protocol.ts` for canonical TypeScript model changes.
- `README.md` if setup, architecture, or top-level product framing changes.

Do not let implementation drift create multiple incompatible meanings for
"Skill", "tool", "configuration", "secret", "agent", or "runtime".
