import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the agent-authored miniapp into ONE self-contained index.html:
// React + Tailwind + the app code are all inlined. That single file is what the
// host wraps with the TerrUI bridge (shared/bridge.ts) and renders in a sandboxed
// iframe — so there are zero external requests, satisfying the iframe CSP.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 100000,
  },
  logLevel: 'silent',
})
