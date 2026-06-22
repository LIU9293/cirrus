# Terr Skill Contract

This is the single contract every Terr **skill** follows — whether it ships with the
platform (built-in) or is built by a creator (custom). Because both follow the same
shape, the Terr agent (pi-agent today, Hermes/Eve later) **calls and tests them the
same way**, and the workspace renders them the same way.

## 1. What a skill is

A skill is a self-contained capability, expressed as **markdown + scripts**:

```
skills/<skill_id>/
  skill.md            # the manifest + how-to. Frontmatter declares credentials + tools.
  <tool>.ts           # one script per tool call (custom skills implement here)
```

Built-in skills ship their implementation inside the platform, but still expose the
**same `skill.md` manifest**, so the agent and the UI see one uniform shape.

A skill is NOT a bare "connection". A connection (an authorized external account) is
just a skill that happens to declare `credentials` — it still exposes concrete
`tools` the agent can call. There is no separate "connector" concept.

## 2. The manifest (frontmatter of `skill.md`)

```yaml
id: gmail
name: Gmail
summary: Read and act on the user's Gmail inbox.
kind: builtin            # builtin | custom
credentials:             # what the user must configure WHEN ADDING the skill
  - key: email
    label: Gmail address
  - key: app_password
    label: App Password (16 chars)
    secret: true         # masked in the UI, stored in the agent's secrets, never shown to the model
tools:                   # the tool calls this skill exposes to the agent
  - name: gmail_search
    description: Search the inbox and return matching messages.
    parameters:          # JSON Schema — THE standard contract the agent calls with
      type: object
      properties:
        query: { type: string }
        limit: { type: number }
    entry: gmail_search.ts   # which script implements it (custom skills only)
```

## 3. The calling convention (how the agent invokes a tool)

1. Each `tools[]` entry is registered with the agent as a function tool
   `{ name, description, parameters }`. This is identical for built-in and custom skills.
2. The agent calls `name(args)`, where `args` validates against `parameters`.
3. The platform runs the tool's implementation, **injecting the configured
   credentials** so the agent never sees secrets:
   - `globalThis.__INPUT__`        = the call arguments (`args`)
   - `globalThis.__CREDENTIALS__`  = the skill's configured credential values
4. The implementation returns JSON: `{ ok: boolean, ...result }`. That JSON is the
   tool result handed back to the agent. `ok: false` with an `error` string signals failure.

So the standard contract for ANY tool is:

```
(args matching `parameters`, + injected credentials) -> { ok, ...result }
```

## 4. Credentials & readiness

- A skill with `credentials` must have them filled before its tools can run. The user
  fills them in the skill's detail panel; secret fields are written to the agent's
  secrets and never returned to the client or the model.
- A skill is **ready** when (a) every required credential is filled and (b) each tool's
  test returns `ok: true`. The workspace shows this status per skill and per tool.

## 5. Testing

Every tool is testable in isolation. The workspace runs the tool with sample
`__INPUT__` (and the configured credentials) in the sandbox and shows the returned
JSON. This is the same path the agent uses, so "it tests green" means "the agent can
call it."

## 6. Building a custom skill

When the platform doesn't have a capability, the creator builds a custom skill that
follows THIS contract — by describing it to the AI, which authors `skill.md` (manifest)
and the `<tool>.ts` scripts. The creator can also add/edit a skill by hand. Either way
the result exposes the same standard contract and is called/tested exactly like a
built-in skill.
