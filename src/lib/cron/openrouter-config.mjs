export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_NEWSLETTER_MODEL = 'google/gemini-2.5-flash'
export const DEFAULT_TRANSCRIPTION_MODEL = 'openai/whisper-large-v3'

/**
 * Keep OpenRouter client and model selection independent from framework and SDK code so
 * defaults and overrides can be verified without constructing a client or making requests.
 */
export function getOpenRouterConfig(env = process.env) {
  return {
    client: {
      baseURL: OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY,
    },
    newsletterModel: env.OPENROUTER_MODEL || DEFAULT_NEWSLETTER_MODEL,
    transcriptionModel: env.OPENROUTER_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
  }
}
