// Registers the public Cirrus runtime image (runtime-image/Dockerfile) as an E2B
// template, so E2B runtimes start with all six community-agent CLIs present.
//
// The image is the single source of truth (see runtime-image/Dockerfile). Daytona
// pulls it directly; E2B needs it wrapped as a template — that's all this does now.
//
//   1. Build & push the public image first:
//        docker build -t ghcr.io/liu9293/cirrus-runtime:latest backend/runtime-image
//        docker push  ghcr.io/liu9293/cirrus-runtime:latest
//   2. Then register it as the E2B template:
//        E2B_API_KEY=... node --import tsx src/scripts/buildRuntimeTemplate.ts
//
// On success it prints the template name/id — wire that into RUNTIME_SANDBOX_TEMPLATE
// (config.ts default is already `cirrus-runtime`).
import { Template, defaultBuildLogger } from 'e2b'
import { config } from '../config.ts'

export const RUNTIME_TEMPLATE_NAME = 'cirrus-runtime'

async function main() {
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required to build a template.')

  // Build the E2B template straight from the public image — no per-CLI install
  // steps here anymore; they live in runtime-image/Dockerfile (one source of truth).
  // For a private registry, pass { username, password } as the second arg.
  const template = Template().fromImage(config.runtimeImage)

  const info = await Template.build(template, RUNTIME_TEMPLATE_NAME, {
    apiKey: process.env.E2B_API_KEY,
    domain: process.env.E2B_DOMAIN,
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger({ minLevel: 'info' }),
  })

  console.log('\n✅ Template built from', config.runtimeImage, '→', JSON.stringify(info, null, 2))
  console.log(`\nNext: set RUNTIME_SANDBOX_TEMPLATE="${info.name ?? RUNTIME_TEMPLATE_NAME}" (default already wired in config).`)
}

main().catch((err) => {
  console.error('❌ Template build failed:', err?.message ?? err)
  process.exit(1)
})
