// AI endpoints per purpose (NIAS-58): base URL, model and API key of the OpenAI-compatible
// server used for transcription and for text generation are stored in Supabase
// (`ai_endpoints`, one row per purpose) instead of being fixed in code. A purpose without a row
// keeps the previous environment behaviour (OpenRouter + OPENROUTER_*). API keys are stored
// AES-256-GCM-encrypted with AI_ENDPOINTS_ENCRYPTION_KEY. Dependency-free (node:crypto only),
// shared by the Vercel routes, the admin area and the Docker worker.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getOpenRouterConfig, OPENROUTER_BASE_URL } from '../cron/openrouter-config.mjs'

export const AI_ENDPOINTS_TABLE = 'ai_endpoints'
export const AI_PURPOSES = ['transcription', 'text_generation']
export const MASTER_KEY_ENV = 'AI_ENDPOINTS_ENCRYPTION_KEY'
export const DEFAULT_CACHE_TTL_MS = 60_000
// The OpenAI SDK insists on an API key; keyless local servers ignore this bearer.
export const KEYLESS_API_KEY = 'not-needed'

// Same limits as the CHECK constraints in 20261020_create_ai_endpoints.sql.
export const LIMITS = { name: 100, baseUrl: 500, model: 200, apiKey: 1000 }

const CIPHER = 'aes-256-gcm'
const CIPHERTEXT_VERSION = 'v1'
const IV_BYTES = 12
// PostgREST: table not in the schema cache / Postgres: undefined_table.
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])

/** Configuration error whose message never contains key material. */
export class AiEndpointError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AiEndpointError'
  }
}

export function isAiPurpose(value) {
  return AI_PURPOSES.includes(value)
}

/** Decodes the 32-byte master key (base64, e.g. `openssl rand -base64 32`). */
export function parseMasterKey(raw) {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) throw new AiEndpointError(`${MASTER_KEY_ENV} muss 32 Byte lang sein`)
    return raw
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AiEndpointError(`${MASTER_KEY_ENV} fehlt`)
  }
  const value = raw.trim()
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : null
  if (!key || key.length !== 32) {
    throw new AiEndpointError(`${MASTER_KEY_ENV} muss 32 Byte als Base64 sein (openssl rand -base64 32)`)
  }
  return key
}

/**
 * Encrypts an API key for one purpose as `v1:<iv>:<tag>:<ciphertext>` (base64 parts). The
 * purpose is authenticated data, so a ciphertext copied into another row fails to decrypt.
 */
export function encryptApiKey(apiKey, { masterKey, purpose }) {
  assertPurpose(purpose)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, parseMasterKey(masterKey), iv)
  cipher.setAAD(Buffer.from(purpose))
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return [CIPHERTEXT_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':')
}

export function decryptApiKey(stored, { masterKey, purpose }) {
  assertPurpose(purpose)
  const key = parseMasterKey(masterKey)
  const parts = typeof stored === 'string' ? stored.split(':') : []
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new AiEndpointError(`API-Key für ${purpose} hat ein unbekanntes Format`)
  }
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, 'base64'))
  try {
    const decipher = createDecipheriv(CIPHER, key, iv)
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new AiEndpointError(`API-Key für ${purpose} lässt sich nicht entschlüsseln (${MASTER_KEY_ENV} geändert?)`)
  }
}

/** Last four characters for display (`…a1b2`); never more of the key. */
export function apiKeyHint(apiKey) {
  if (!apiKey) return null
  return apiKey.length > 8 ? `…${apiKey.slice(-4)}` : '…'
}

/**
 * Validates admin input for one endpoint. `apiKey` may be omitted/empty (keyless server, or
 * "keep the stored key" when editing — the caller decides). Returns `{ ok: true, value }` with
 * trimmed values and the base URL without trailing slashes, or `{ ok: false, errors }` keyed by field.
 */
export function validateEndpointInput(input) {
  const errors = {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')

  const purpose = text(input?.purpose)
  if (!isAiPurpose(purpose)) errors.purpose = 'Unbekannter Zweck'

  const name = text(input?.name)
  if (name.length === 0 || name.length > LIMITS.name) errors.name = `Name muss 1–${LIMITS.name} Zeichen lang sein`

  const model = text(input?.model)
  if (model.length === 0 || model.length > LIMITS.model) errors.model = `Modell muss 1–${LIMITS.model} Zeichen lang sein`

  const baseUrl = normalizeBaseUrl(text(input?.baseUrl))
  if (!baseUrl) errors.baseUrl = 'Base-URL muss eine http(s)-URL ohne Zugangsdaten, Query oder Fragment sein'

  const apiKey = text(input?.apiKey)
  if (apiKey.length > LIMITS.apiKey || /\s/.test(apiKey)) errors.apiKey = 'API-Key ist ungültig'

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { purpose, name, baseUrl, model, apiKey: apiKey || null } }
}

function normalizeBaseUrl(raw) {
  if (raw.length === 0 || raw.length > LIMITS.baseUrl) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return null
  }
  return url.toString().replace(/\/+$/, '')
}

/** The previous, environment-only configuration (OpenRouter) for each purpose. */
export function getEnvAiEndpoints(env = process.env) {
  const openrouter = getOpenRouterConfig(env)
  const fromEnv = (purpose, model) => ({
    purpose,
    source: 'env',
    name: 'OpenRouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey: openrouter.client.apiKey,
    model,
  })
  return {
    transcription: fromEnv('transcription', openrouter.transcriptionModel),
    text_generation: fromEnv('text_generation', openrouter.newsletterModel),
  }
}

/**
 * Reads the stored endpoints and returns `{ transcription, text_generation }`, each
 * `{ purpose, source: 'database' | 'env', name, baseURL, apiKey, model }`. A purpose without a
 * row — or a database without the table yet — falls back to the environment. Any other read
 * or decryption failure throws an AiEndpointError, never with key material in it.
 */
export async function resolveAiEndpoints({ supabase, env = process.env }) {
  const endpoints = getEnvAiEndpoints(env)

  const { data, error } = await supabase
    .from(AI_ENDPOINTS_TABLE)
    .select('purpose, name, base_url, model, api_key_encrypted')
  if (error) {
    if (MISSING_TABLE_CODES.has(error.code)) return endpoints
    throw new AiEndpointError(`KI-Endpunkte konnten nicht gelesen werden: ${error.message}`)
  }

  for (const row of data ?? []) {
    if (!isAiPurpose(row.purpose)) continue
    endpoints[row.purpose] = {
      purpose: row.purpose,
      source: 'database',
      name: row.name,
      baseURL: row.base_url,
      apiKey: row.api_key_encrypted
        ? decryptApiKey(row.api_key_encrypted, { masterKey: env[MASTER_KEY_ENV], purpose: row.purpose })
        : KEYLESS_API_KEY,
      model: row.model,
    }
  }
  return endpoints
}

/**
 * Cached `resolveAiEndpoints` for long-running processes: re-reads at most every `ttlMs`, so
 * admin changes apply without a restart. If a refresh fails after a successful read, the last
 * known endpoints stay in use (logged as a warning) until the next attempt after `ttlMs`.
 */
export function createAiEndpointResolver({ supabase, env = process.env, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now, log = () => {} }) {
  let cached = null
  let loadedAt = 0
  return async function getAiEndpoints() {
    if (cached && now() - loadedAt < ttlMs) return cached
    try {
      cached = await resolveAiEndpoints({ supabase, env })
    } catch (err) {
      if (!cached) throw err
      log('warn', 'ai_endpoints_refresh_failed', { error: err instanceof Error ? err.message : String(err) })
    }
    loadedAt = now()
    return cached
  }
}

/** Options for `new OpenAI(...)`. */
export function toClientOptions(endpoint) {
  return { baseURL: endpoint.baseURL, apiKey: endpoint.apiKey }
}

/** Loggable summary of an endpoint — host instead of the full URL, never the key. */
export function describeAiEndpoint(endpoint) {
  let host = null
  try {
    host = new URL(endpoint.baseURL).host
  } catch {}
  return { purpose: endpoint.purpose, source: endpoint.source, name: endpoint.name, model: endpoint.model, host }
}

function assertPurpose(purpose) {
  if (!isAiPurpose(purpose)) throw new AiEndpointError(`Unbekannter Zweck: ${purpose}`)
}
