// Builds the custom E2B template used by every runtime sandbox, with all six
// community-agent CLIs baked in so sandboxes start with them present (zero
// per-install wait). Based on the code-interpreter base so `runCode` still works.
//
//   E2B_API_KEY=... node --import tsx src/scripts/buildRuntimeTemplate.ts
//
// On success it prints the built template name/id — wire that into
// RUNTIME_SANDBOX_TEMPLATE (config.ts / provisionRuntimeSandbox).
import { Template, defaultBuildLogger } from 'e2b'
import { config } from '../config.ts'

export const RUNTIME_TEMPLATE_NAME = 'cirrus-runtime'

// Reliable npm-published CLIs install as one step (fail the build if broken).
const NPM_CLIS = 'opencode-ai @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent'

// Hermes & OpenClaw are intentionally NOT baked in: their install scripts are
// invasive (OpenClaw upgrades Node v20→v24 + installs system build tools; Hermes
// pulls uv/Python), which breaks the code-interpreter base's Jupyter/envd and
// makes the template's readiness check time out. Set BAKE_INVASIVE_CLIS=1 to
// attempt them anyway. They otherwise fall back to per-runtime install.
const BAKE_INVASIVE = process.env.BAKE_INVASIVE_CLIS === '1'
const HERMES_INSTALL = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/h.sh && bash /tmp/h.sh < /dev/null || echo "[warn] hermes install failed"'
const OPENCLAW_INSTALL = "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh -o /tmp/c.sh && bash /tmp/c.sh < /dev/null || echo \"[warn] openclaw install failed\""

async function main() {
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required to build a template.')

  // Installs run as root: the build's default user is `user`, which can't write
  // to /usr/lib/node_modules for `npm install -g`.
  const asRoot = { user: 'root' }
  let template = Template()
    .fromTemplate('code-interpreter-v1')
    .runCmd(`npm install -g ${NPM_CLIS}`, asRoot)
  if (BAKE_INVASIVE) template = template.runCmd(HERMES_INSTALL, asRoot).runCmd(OPENCLAW_INSTALL, asRoot)
  // Record what we baked in for debugging from inside the sandbox.
  template = template.runCmd('for b in opencode claude codex pi hermes clawbot; do printf "%s: %s\\n" "$b" "$(command -v "$b" || echo MISSING)"; done > /home/user/.cirrus-clis.txt || true', asRoot)

  const info = await Template.build(template, RUNTIME_TEMPLATE_NAME, {
    apiKey: process.env.E2B_API_KEY,
    domain: process.env.E2B_DOMAIN,
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger({ minLevel: 'info' }),
  })

  console.log('\n✅ Template built:', JSON.stringify(info, null, 2))
  console.log(`\nNext: set RUNTIME_SANDBOX_TEMPLATE="${info.name ?? RUNTIME_TEMPLATE_NAME}" (default already wired in config).`)
  console.log('platform model (for reference):', config.model)
}

main().catch((err) => {
  console.error('❌ Template build failed:', err?.message ?? err)
  process.exit(1)
})
