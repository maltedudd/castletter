// Fallback between the endpoints of one purpose (NIAS-62): the primary endpoint is tried
// first; if it fails — any error — and a fallback endpoint is stored, the same request is
// repeated once against the fallback. Without a fallback the primary client is used as is,
// so nothing changes for purposes that have none. Logs never contain API keys.

import { describeAiEndpoint } from './endpoints.mjs'

/** Raised for a chat completion without text, so it counts as a failure of that endpoint. */
export class EmptyCompletionError extends Error {
  constructor(endpoint) {
    super(`${endpoint.name} lieferte keine Textantwort`)
    this.name = 'EmptyCompletionError'
  }
}

/**
 * Runs `run({ endpoint, client })` against the primary attempt and, if that throws and a
 * fallback attempt exists, against the fallback (logged as `ai_endpoint_fallback`). If the
 * fallback fails too, its error is thrown with the primary error appended (status kept).
 * Each attempt is `{ endpoint, client }`.
 */
export async function withFallback(primary, fallback, run, log = () => {}) {
  try {
    return await run(primary)
  } catch (err) {
    if (!fallback) throw err
    log('warn', 'ai_endpoint_fallback', {
      purpose: primary.endpoint.purpose,
      from: describeAiEndpoint(primary.endpoint),
      to: describeAiEndpoint(fallback.endpoint),
      error: errorMessage(err),
    })
    try {
      return await run(fallback)
    } catch (fallbackErr) {
      const combined = new Error(`${errorMessage(fallbackErr)} (Fallback nach Fehler von ${primary.endpoint.name}: ${errorMessage(err)})`, { cause: fallbackErr })
      combined.status = fallbackErr?.status
      throw combined
    }
  }
}

/**
 * OpenAI-compatible chat client over primary and fallback: `chat.completions.create(options)`
 * sends `prepare(options, model)` with each attempt's own model, so model-specific options
 * (e.g. Gemini's reasoning switch) match the endpoint. An empty primary answer counts as a
 * failure; an empty fallback answer is returned, so the caller treats it as before. Without a
 * fallback the primary client is returned unchanged.
 */
export function createFallbackChatClient(primary, fallback, { prepare = (options, model) => ({ ...options, model }), log } = {}) {
  if (!fallback) return primary.client
  const attempt = async (current, options, requestOptions) => {
    const completion = await current.client.chat.completions.create(prepare(options, current.endpoint.model), requestOptions)
    if (current === primary && !completion?.choices?.[0]?.message?.content) throw new EmptyCompletionError(current.endpoint)
    return completion
  }
  return {
    chat: {
      completions: {
        create: (options, requestOptions) =>
          withFallback(primary, fallback, (current) => attempt(current, options, requestOptions), log),
      },
    },
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
