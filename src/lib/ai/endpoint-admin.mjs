// Admin side of the AI endpoints (NIAS-59): status per purpose for the admin page, save/reset
// and a connection test. API keys never leave the server — the page only gets the stored hint.
// Dependency-free with injected Supabase client (service role) and fetch, so it runs under
// node:test; the API routes in src/app/api/admin/ai-endpoints only wire it up.

import {
  AI_ENDPOINTS_TABLE,
  AI_PURPOSES,
  AiEndpointError,
  MASTER_KEY_ENV,
  apiKeyHint,
  decryptApiKey,
  encryptApiKey,
  getEnvAiEndpoints,
  isAiPurpose,
  validateEndpointInput,
} from './endpoints.mjs'
import { OPENROUTER_BASE_URL } from '../cron/openrouter-config.mjs'

export const CONNECTION_TEST_TIMEOUT_MS = 10_000

/**
 * Display state per purpose (in AI_PURPOSES order): the stored endpoint, or the environment
 * default. Returns `{ endpoints, error }`; on a read error the list shows the defaults and
 * `error` is set, so the page still renders.
 */
export async function listEndpointStatus(supabase, env = process.env) {
  const defaults = getEnvAiEndpoints(env)
  const { data, error } = await supabase
    .from(AI_ENDPOINTS_TABLE)
    .select('purpose, name, base_url, model, api_key_encrypted, api_key_hint, updated_at')
  const rows = new Map((data ?? []).map((row) => [row.purpose, row]))

  const endpoints = AI_PURPOSES.map((purpose) => {
    const row = rows.get(purpose)
    if (!row) {
      const fallback = defaults[purpose]
      return {
        purpose, source: 'env', name: fallback.name, baseUrl: fallback.baseURL, model: fallback.model,
        hasApiKey: Boolean(fallback.apiKey), apiKeyHint: null, updatedAt: null,
      }
    }
    return {
      purpose, source: 'database', name: row.name, baseUrl: row.base_url, model: row.model,
      hasApiKey: Boolean(row.api_key_encrypted), apiKeyHint: row.api_key_hint, updatedAt: row.updated_at,
    }
  })
  return { endpoints, error: error ? error.message : null }
}

/**
 * Saves the endpoint of one purpose. `apiKey` empty keeps the stored key (a new row starts
 * keyless), `clearApiKey: true` stores none, a new key is encrypted with
 * AI_ENDPOINTS_ENCRYPTION_KEY.
 * Returns `{ ok: true }` or `{ ok: false, status, code, fields? }`.
 */
export async function saveEndpoint(supabase, input, env = process.env) {
  const validated = validateEndpointInput(input)
  if (!validated.ok) return { ok: false, status: 400, code: 'invalid', fields: Object.keys(validated.errors) }
  const { purpose, name, baseUrl, model, apiKey } = validated.value

  const row = { purpose, name, base_url: baseUrl, model }
  if (apiKey) {
    if (!env[MASTER_KEY_ENV]) return { ok: false, status: 500, code: 'masterKeyMissing' }
    try {
      row.api_key_encrypted = encryptApiKey(apiKey, { masterKey: env[MASTER_KEY_ENV], purpose })
    } catch {
      return { ok: false, status: 500, code: 'masterKeyInvalid' }
    }
    row.api_key_hint = apiKeyHint(apiKey)
  } else if (input.clearApiKey === true) {
    row.api_key_encrypted = null
    row.api_key_hint = null
  } else if (baseUrl === OPENROUTER_BASE_URL) {
    // Without a new key the stored key stays. A new OpenRouter row would start keyless and
    // break the purpose (the env key is not copied), so it needs the key entered.
    const { data, error } = await supabase.from(AI_ENDPOINTS_TABLE).select('purpose').eq('purpose', purpose).maybeSingle()
    if (error) return { ok: false, status: 500, code: 'saveFailed' }
    if (!data) return { ok: false, status: 400, code: 'invalid', fields: ['apiKey'] }
  }

  const { error } = await supabase.from(AI_ENDPOINTS_TABLE).upsert(row, { onConflict: 'purpose' })
  if (error) return { ok: false, status: 500, code: 'saveFailed' }
  return { ok: true }
}

/** Removes the endpoint of one purpose, so it falls back to the environment default. */
export async function resetEndpoint(supabase, purpose) {
  if (!isAiPurpose(purpose)) return { ok: false, status: 400, code: 'invalid', fields: ['purpose'] }
  const { error } = await supabase.from(AI_ENDPOINTS_TABLE).delete().eq('purpose', purpose)
  if (error) return { ok: false, status: 500, code: 'saveFailed' }
  return { ok: true }
}

/**
 * Tests the entered endpoint with `GET <baseUrl>/models`. An empty key field uses the stored
 * key of that purpose only if the base URL is unchanged — a stored key is never sent to a new
 * host. Redirects are not followed (the bearer must not travel on). Returns
 * `{ ok: true, status, modelFound }` (`modelFound` null when the server lists no models) or
 * `{ ok: false, code, status?, detail? }`; `detail` never contains the key.
 */
export async function testEndpointConnection(supabase, input, { env = process.env, fetchImpl = fetch, timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = {}) {
  const validated = validateEndpointInput(input)
  if (!validated.ok) return { ok: false, code: 'invalid', fields: Object.keys(validated.errors) }
  const { purpose, baseUrl, model } = validated.value

  let apiKey = validated.value.apiKey
  if (!apiKey && input.clearApiKey !== true) {
    try {
      apiKey = await storedKeyForUrl(supabase, purpose, baseUrl, env)
    } catch (err) {
      return { ok: false, code: err instanceof AiEndpointError ? 'storedKeyUnreadable' : 'testFailed' }
    }
  }

  let response
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return { ok: false, code: timedOut ? 'timeout' : 'unreachable', detail: redact(errorText(err), apiKey) }
  }

  if (response.status >= 300 && response.status < 400) return { ok: false, code: 'redirect', status: response.status }
  if (response.status === 401 || response.status === 403) return { ok: false, code: 'unauthorized', status: response.status }
  if (!response.ok) return { ok: false, code: 'httpError', status: response.status }

  let modelFound = null
  try {
    const body = await response.json()
    if (Array.isArray(body?.data)) modelFound = body.data.some((entry) => entry?.id === model)
  } catch {}
  return { ok: true, status: response.status, modelFound }
}

async function storedKeyForUrl(supabase, purpose, baseUrl, env) {
  const { data, error } = await supabase
    .from(AI_ENDPOINTS_TABLE)
    .select('base_url, api_key_encrypted')
    .eq('purpose', purpose)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data?.api_key_encrypted && data.base_url === baseUrl) {
    return decryptApiKey(data.api_key_encrypted, { masterKey: env[MASTER_KEY_ENV], purpose })
  }
  if (!data) {
    // No stored endpoint: the environment default (OpenRouter) is in use — reuse its key only
    // for its own URL.
    const fallback = getEnvAiEndpoints(env)[purpose]
    if (fallback.apiKey && fallback.baseURL === baseUrl) return fallback.apiKey
  }
  return null
}

function errorText(err) {
  const cause = err?.cause?.code || err?.cause?.message
  return [err?.message, cause].filter(Boolean).join(': ').slice(0, 200)
}

function redact(text, secret) {
  return secret ? text.split(secret).join('***') : text
}
