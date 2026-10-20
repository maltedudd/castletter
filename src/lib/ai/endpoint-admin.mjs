// Admin side of the AI endpoints (NIAS-59): status per purpose for the admin page, save/delete
// and a connection test, each for the primary or the optional fallback slot (NIAS-62). There
// is no default from the environment (NIAS-63). API keys never leave the server — the page only
// gets the stored hint.
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
  isAiPurpose,
  isAiSlot,
  validateEndpointInput,
} from './endpoints.mjs'

export const CONNECTION_TEST_TIMEOUT_MS = 10_000

/**
 * Display state per purpose (in AI_PURPOSES order): `{ purpose, primary, fallback }`, each the
 * stored endpoint or null (null primary: the purpose is not set up). Returns
 * `{ endpoints, error }`; on a read error both are null and `error` is set, so the page still
 * renders.
 */
export async function listEndpointStatus(supabase) {
  const { data, error } = await supabase
    .from(AI_ENDPOINTS_TABLE)
    .select('purpose, slot, name, base_url, model, api_key_encrypted, api_key_hint, updated_at')
  const rows = new Map((data ?? []).map((row) => [`${row.purpose}:${row.slot}`, row]))
  const status = (purpose, slot) => {
    const row = rows.get(`${purpose}:${slot}`)
    if (!row) return null
    return {
      purpose, slot, name: row.name, baseUrl: row.base_url, model: row.model,
      hasApiKey: Boolean(row.api_key_encrypted), apiKeyHint: row.api_key_hint, updatedAt: row.updated_at,
    }
  }

  const endpoints = AI_PURPOSES.map((purpose) => ({ purpose, primary: status(purpose, 'primary'), fallback: status(purpose, 'fallback') }))
  return { endpoints, error: error ? error.message : null }
}

/**
 * Saves the endpoint of one purpose and slot. `apiKey` empty keeps the stored key (a new row
 * starts keyless), `clearApiKey: true` stores none, a new key is encrypted with
 * AI_ENDPOINTS_ENCRYPTION_KEY. A fallback needs a stored primary endpoint of its purpose.
 * Returns `{ ok: true }` or `{ ok: false, status, code, fields? }`.
 */
export async function saveEndpoint(supabase, input, env = process.env) {
  const validated = validateEndpointInput(input)
  if (!validated.ok) return { ok: false, status: 400, code: 'invalid', fields: Object.keys(validated.errors) }
  const { purpose, slot, name, baseUrl, model, apiKey } = validated.value

  if (slot === 'fallback') {
    const { data, error } = await supabase
      .from(AI_ENDPOINTS_TABLE)
      .select('purpose')
      .eq('purpose', purpose)
      .eq('slot', 'primary')
      .maybeSingle()
    if (error) return { ok: false, status: 500, code: 'saveFailed' }
    if (!data) return { ok: false, status: 400, code: 'primaryMissing' }
  }

  const row = { purpose, slot, name, base_url: baseUrl, model }
  if (apiKey) {
    if (!env[MASTER_KEY_ENV]) return { ok: false, status: 500, code: 'masterKeyMissing' }
    try {
      row.api_key_encrypted = encryptApiKey(apiKey, { masterKey: env[MASTER_KEY_ENV], purpose, slot })
    } catch {
      return { ok: false, status: 500, code: 'masterKeyInvalid' }
    }
    row.api_key_hint = apiKeyHint(apiKey)
  } else if (input.clearApiKey === true) {
    row.api_key_encrypted = null
    row.api_key_hint = null
  }

  const { error } = await supabase.from(AI_ENDPOINTS_TABLE).upsert(row, { onConflict: 'purpose,slot' })
  if (error) return { ok: false, status: 500, code: 'saveFailed' }
  return { ok: true }
}

/**
 * Deletes the endpoint of one purpose and slot. Deleting the primary endpoint deletes the
 * fallback too and leaves the purpose not set up; deleting the fallback keeps the primary.
 */
export async function deleteEndpoint(supabase, purpose, slot = 'primary') {
  if (!isAiPurpose(purpose)) return { ok: false, status: 400, code: 'invalid', fields: ['purpose'] }
  if (!isAiSlot(slot)) return { ok: false, status: 400, code: 'invalid', fields: ['slot'] }
  let query = supabase.from(AI_ENDPOINTS_TABLE).delete().eq('purpose', purpose)
  if (slot === 'fallback') query = query.eq('slot', 'fallback')
  const { error } = await query
  if (error) return { ok: false, status: 500, code: 'saveFailed' }
  return { ok: true }
}

/**
 * Tests the entered endpoint with `GET <baseUrl>/models`. An empty key field uses the stored
 * key of that purpose and slot only if the base URL is unchanged — a stored key is never sent
 * to a new host. Redirects are not followed (the bearer must not travel on). Returns
 * `{ ok: true, status, modelFound }` (`modelFound` null when the server lists no models) or
 * `{ ok: false, code, status?, detail? }`; `detail` never contains the key.
 */
export async function testEndpointConnection(supabase, input, { env = process.env, fetchImpl = fetch, timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = {}) {
  const validated = validateEndpointInput(input)
  if (!validated.ok) return { ok: false, code: 'invalid', fields: Object.keys(validated.errors) }
  const { purpose, slot, baseUrl, model } = validated.value

  let apiKey = validated.value.apiKey
  if (!apiKey && input.clearApiKey !== true) {
    try {
      apiKey = await storedKeyForUrl(supabase, purpose, slot, baseUrl, env)
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

async function storedKeyForUrl(supabase, purpose, slot, baseUrl, env) {
  const { data, error } = await supabase
    .from(AI_ENDPOINTS_TABLE)
    .select('base_url, api_key_encrypted')
    .eq('purpose', purpose)
    .eq('slot', slot)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (data?.api_key_encrypted && data.base_url === baseUrl) {
    return decryptApiKey(data.api_key_encrypted, { masterKey: env[MASTER_KEY_ENV], purpose, slot })
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
