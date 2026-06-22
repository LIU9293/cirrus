import OpenAI from 'openai'
import { config } from '../config.ts'

export const openai = new OpenAI({
  baseURL: config.baseURL,
  apiKey: config.apiKey,
})
