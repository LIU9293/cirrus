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

// Hermes & OpenClaw need Jupyter-safe installs (their default installers break the
// code-interpreter base): OpenClaw's installer upgrades system Node v20→v24 via
// NodeSource (which breaks envd/Jupyter), so we install its npm package directly
// on the existing Node instead. Hermes runs with --skip-setup so it stays in its
// own uv venv and skips the interactive gateway/browser stages. Best-effort: a
// failure only warns, so the template build still succeeds.
const HERMES_INSTALL = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/h.sh && bash /tmp/h.sh --skip-setup < /dev/null || echo "[warn] hermes install failed"'
// OpenClaw needs Node 24; its installer upgrades system Node via NodeSource, which
// breaks the code-interpreter base's Jupyter. Install Node 24 into an isolated
// prefix (/opt/node24, tarball — no apt, system Node 20 stays for Jupyter), install
// OpenClaw there, and expose a PATH wrapper that runs it with Node 24.
const OPENCLAW_INSTALL = [
  'ARCH=$(uname -m); case "$ARCH" in aarch64) NA=arm64;; *) NA=x64;; esac',
  'curl -fsSL https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-$NA.tar.xz -o /tmp/n24.tar.xz',
  'mkdir -p /opt/node24 && tar -xJf /tmp/n24.tar.xz -C /opt/node24 --strip-components=1',
  // Run npm WITH node24 on PATH so it installs into /opt/node24 (its own prefix),
  // not the system prefix — otherwise npm's `env node` shim picks up system node 20.
  'env PATH=/opt/node24/bin:$PATH /opt/node24/bin/npm install -g openclaw@latest',
  `printf '%s\\n' '#!/bin/bash' 'exec env PATH=/opt/node24/bin:$PATH /opt/node24/bin/openclaw "$@"' > /usr/local/bin/openclaw`,
  'chmod +x /usr/local/bin/openclaw',
].join(' && ') + ' || echo "[warn] openclaw install failed"'

async function main() {
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required to build a template.')

  // Installs run as root: the build's default user is `user`, which can't write
  // to /usr/lib/node_modules for `npm install -g`.
  const asRoot = { user: 'root' }
  const template = Template()
    .fromTemplate('code-interpreter-v1')
    .runCmd(`npm install -g ${NPM_CLIS}`, asRoot)
    .runCmd(HERMES_INSTALL, asRoot)
    .runCmd(OPENCLAW_INSTALL, asRoot)
    // Record what we baked in for debugging from inside the sandbox.
    .runCmd('for b in opencode claude codex pi hermes openclaw; do printf "%s: %s\\n" "$b" "$(command -v "$b" || echo MISSING)"; done > /home/user/.cirrus-clis.txt || true', asRoot)

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
