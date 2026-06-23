# Terr Miniapp Studio (prototype)

A standalone prototype of the **full agent-native miniapp lifecycle**: chat with a
developer agent → it authors a React miniapp → builds it to a single self-contained
HTML file → renders it live in a sandboxed canvas → you (and the agent) interact with
it through a communication **bridge**. Freeze (固化) a miniapp when you're happy.

It reuses two things from the main Terr app:
- the **JS bridge** (`shared/bridge.ts`, copied verbatim from
  `frontend/src/new-ui/chat/appFrameBridge.ts`) — the `window.TerrUI` channel + CSP +
  sandboxed `srcdoc` model, and
- the **single-file build** approach (Vite + `vite-plugin-singlefile`, the modern
  equivalent of the esbuild artifact pipeline) so a whole React+Tailwind app inlines
  into one HTML doc with zero external requests.

## Layout

```
shared/
  protocol.ts        # THE SPEC: MiniappManifest, StateModel, ActionSpec, MiniappRecord
  bridge.ts          # reused TerrUI host<->frame bridge (CSP, srcdoc, postMessage)
backend/             # Node + Express + OpenAI SDK (points at the relay; model gpt-5.5)
  src/agent/         # miniapp-developer-agent (tool loop) + runtime agent (action handler)
  src/build/         # copies agent source into the runtime template, runs vite build
  src/store.ts       # file-backed miniapp records + source files
miniapp-runtime/     # the Vite/React/Tailwind template the agent's code is built in
  src/terrui.tsx     # miniapp-side SDK: useTerrState / useTerr / useAgentAction / useAutoResize
  src/app/App.tsx     # the agent overwrites this (default-exported component)
frontend/            # Vite + React + Tailwind host; chat uses AI Elements (elements.ai-sdk.dev)
  src/lib/useMiniappHost.ts  # host side of the bridge (action routing + state push)
  src/canvas/        # the iframe canvas
  src/chat/          # the developer-agent chat
```

## The spec ("规范")

A miniapp is a single React app sandboxed in an iframe. Its only channel out is
`window.TerrUI`, surfaced via the `@/terrui` SDK. It declares a **manifest**:

- `stateModel` — a host-owned, persisted JSON state (fields + initial value). The UI
  renders from it (`useTerrState`) and patches it (`useTerr().setState`).
- `actions` — either `mutate_state` (host merges a patch) or **`agent`** (routes to a
  runtime agent that can patch the state). The `agent` kind is what makes a miniapp
  *agent-native*: a button calls the agent, the agent mutates shared state, the UI
  re-renders. See `backend/src/agent/spec.ts` for the full authoring contract.

## Data flow

```
create:  chat ──SSE──> developer-agent loop ──tools──> set_manifest / write_files / build
                                                             │
                                              vite build (single-file HTML) ──> record.html
render:  record.html ──buildTerrAppFrameSrcDoc()──> sandboxed <iframe srcdoc>  (window.TerrUI injected)
use:     iframe button ─postMessage→ host (useMiniappHost) ─HTTP→ /actions ─→ runtime agent
              patches state ─→ host pushes state ─postMessage→ iframe re-renders
```

## Run it

```sh
npm run install:all          # installs backend, frontend, miniapp-runtime

cp backend/.env.example backend/.env   # then set OPENAI_API_KEY (relay key) — already templated
# backend defaults: OPENAI_BASE_URL=https://ai-relay.chainbot.io/v1, MINIAPP_MODEL=gpt-5.5, PORT=3000

npm run dev                  # backend on :3000, frontend on Vite default :5173 (frontend proxies /api)
# open http://localhost:5173
```

Then: type "Build a todo list with a button that asks the agent to suggest starter
tasks", watch it build into the canvas, type a goal, and click the agent button.

## Notes / next steps

- The agent currently authors a single `app/App.tsx`; the contract already supports
  multiple files under `app/`.
- Tailwind v4 auto-detection ignores `.gitignore`d paths, so the runtime CSS uses an
  explicit `@source "./app/**/*"` (the agent's dir is gitignored). Don't remove it.
- Validation is light (manifest shape + build success). The main Terr `appauthoring`
  validate/repair contract is the natural place to harden this.
