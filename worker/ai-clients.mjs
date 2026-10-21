// Current AI client per purpose for the worker (NIAS-58). `refresh()` runs before every
// pipeline pass and rebuilds a client only when its endpoint changed, so endpoints edited in
// the admin area apply without a restart. Within one pass (e.g. all chunks of an episode)
// the endpoint stays the same. A stored fallback endpoint (NIAS-62) is tried per request when
// the primary one fails.

import { AI_PURPOSES, describeAiEndpoint, toClientOptions } from '../src/lib/ai/endpoints.mjs'
import { createFallbackChatClient, withFallback } from '../src/lib/ai/fallback.mjs'
import { withNewsletterModel } from '../src/lib/cron/newsletter-request.mjs'
import { createOpenRouterChunkTranscriber } from '../src/lib/transcription/audio-transcriber.mjs'

/**
 * `getEndpoints()` resolves `{ transcription, text_generation }` (see createAiEndpointResolver),
 * `createClient(options)` builds an OpenAI-compatible client.
 */
export function createAiClients({ getEndpoints, createClient, log = () => {} }) {
  const current = {}

  const attemptFor = (endpoint) => {
    log('info', 'ai_endpoint_active', describeAiEndpoint(endpoint))
    return { endpoint, client: createClient(toClientOptions(endpoint)) }
  }

  async function refresh() {
    const endpoints = await getEndpoints()
    for (const purpose of AI_PURPOSES) {
      const { fallback, ...endpoint } = endpoints[purpose]
      const signature = JSON.stringify([endpoint, fallback ?? null].map((e) => e && [e.baseURL, e.apiKey, e.model]))
      if (current[purpose]?.signature === signature) continue
      current[purpose] = { signature, primary: attemptFor(endpoint), fallback: fallback ? attemptFor(fallback) : null }
    }
  }

  function get(purpose) {
    if (!current[purpose]) throw new Error(`KI-Endpunkt für ${purpose} ist noch nicht geladen`)
    return current[purpose]
  }

  return {
    refresh,
    /** `transcribeChunk` contract of audio-file.mjs, against the current transcription endpoint. */
    transcribeChunk(audioBuffer, format) {
      const { primary, fallback } = get('transcription')
      return withFallback(
        primary,
        fallback,
        ({ endpoint, client }) => createOpenRouterChunkTranscriber(client, endpoint.model)(audioBuffer, format),
        log
      )
    },
    /** `{ client, model }` of the current text generation endpoint, falling back per request. */
    textGeneration() {
      const { primary, fallback } = get('text_generation')
      return {
        client: createFallbackChatClient(primary, fallback, { prepare: withNewsletterModel, log }),
        model: primary.endpoint.model,
      }
    },
  }
}
