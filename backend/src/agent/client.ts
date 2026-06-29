import OpenAI from 'openai'
import { config } from '../config.ts'

export const openai = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
  // Don't let an unreachable/slow relay hang requests for the SDK's 10-minute
  // default; callers that want graceful fallbacks catch the timeout.
  timeout: 45_000,
  maxRetries: 1,
})
