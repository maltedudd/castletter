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

/** The same request for another model (NIAS-62 fallback), with that model's own options. */
export function withNewsletterModel(options, model) {
  const { model: _model, reasoning: _reasoning, messages, ...rest } = options
  return { ...rest, ...buildNewsletterCompletionOptions(model, messages) }
}
