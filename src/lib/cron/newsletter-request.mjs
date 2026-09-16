import { DEFAULT_NEWSLETTER_MODEL } from './openrouter-config.mjs'

/** Build the exact OpenRouter chat-completion options used for newsletters. */
export function buildNewsletterCompletionOptions(model, messages) {
  return {
    model,
    max_tokens: 3000,
    temperature: 0.7,
    ...(model === DEFAULT_NEWSLETTER_MODEL ? { reasoning: { effort: 'none' } } : {}),
    messages,
  }
}
