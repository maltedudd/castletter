// Current AI client per purpose for the worker (NIAS-58). `refresh()` runs before every
// pipeline pass and rebuilds a client only when its endpoint changed, so endpoints edited in
// the admin area apply without a restart. Within one pass (e.g. all chunks of an episode)
// the endpoint stays the same.

import { AI_PURPOSES, describeAiEndpoint, toClientOptions } from '../src/lib/ai/endpoints.mjs'
import { createOpenRouterChunkTranscriber } from '../src/lib/transcription/audio-transcriber.mjs'

/**
 * `getEndpoints()` resolves `{ transcription, text_generation }` (see createAiEndpointResolver),
 * `createClient(options)` builds an OpenAI-compatible client.
 */
export function createAiClients({ getEndpoints, createClient, log = () => {} }) {
  const current = {}

  async function refresh() {
    const endpoints = await getEndpoints()
    for (const purpose of AI_PURPOSES) {
      const endpoint = endpoints[purpose]
      const signature = JSON.stringify([endpoint.baseURL, endpoint.apiKey, endpoint.model])
      if (current[purpose]?.signature === signature) continue
      current[purpose] = { signature, endpoint, client: createClient(toClientOptions(endpoint)) }
      log('info', 'ai_endpoint_active', describeAiEndpoint(endpoint))
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
      const { client, endpoint } = get('transcription')
      return createOpenRouterChunkTranscriber(client, endpoint.model)(audioBuffer, format)
    },
    /** `{ client, model }` of the current text generation endpoint. */
    textGeneration() {
      const { client, endpoint } = get('text_generation')
      return { client, model: endpoint.model }
    },
  }
}
