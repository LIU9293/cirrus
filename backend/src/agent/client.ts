import type OpenAI from 'openai'
import { currentLLM } from './llmContext.ts'

// `openai` is a proxy that forwards to the acting request's resolved client
// (see llmContext.ts). Existing `openai.chat.completions.create(...)` call sites
// keep working but now route to the user's own model when configured, else the
// platform default. Pair `model: llmModel()` with each call (was config.model).
export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_target, prop) {
    const client = currentLLM().client as unknown as Record<string | symbol, unknown>
    const value = client[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value
  },
})

/** The model id the current request should use (user's resolved → platform default). */
export function llmModel(): string {
  return currentLLM().model
}
