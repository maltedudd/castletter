// Gemini 2.5 Flash spends the token budget on reasoning unless it is switched off.
export const GEMINI_FLASH_MODEL = 'google/gemini-2.5-flash'

/** Build the exact OpenRouter chat-completion options used for newsletters. */
export function buildNewsletterCompletionOptions(model, messages) {
  return {
    model,
    max_tokens: 3000,
    temperature: 0.7,
    ...(model === GEMINI_FLASH_MODEL ? { reasoning: { effort: 'none' } } : {}),
    messages,
  }
}

/** The same request for another model (NIAS-62 fallback), with that model's own options. */
export function withNewsletterModel(options, model) {
  const { model: _model, reasoning: _reasoning, messages, ...rest } = options
  return { ...rest, ...buildNewsletterCompletionOptions(model, messages) }
}
