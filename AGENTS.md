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
