import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  AiEndpointError,
  KEYLESS_API_KEY,
  apiKeyHint,
  createAiEndpointResolver,
  decryptApiKey,
  describeAiEndpoint,
  encryptApiKey,
  getEnvAiEndpoints,
  parseMasterKey,
  resolveAiEndpoints,
  toClientOptions,
  validateEndpointInput,
} from '../../src/lib/ai/endpoints.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const MASTER = randomBytes(32).toString('base64')
const ENV = { OPENROUTER_API_KEY: 'or-key', AI_ENDPOINTS_ENCRYPTION_KEY: MASTER }

function failingSupabase(error) {
  return { from: () => ({ select: async () => ({ data: null, error }) }) }
}

function storedRow(overrides = {}) {
  const purpose = overrides.purpose ?? 'transcription'
  return {
    purpose,
    name: 'Parakeet lokal',
    base_url: 'http://ki-maschine:8000/v1',
    model: 'parakeet-tdt-0.6b-v3',
    api_key_encrypted: encryptApiKey('sk-parakeet-123456', { masterKey: MASTER, purpose }),
    ...overrides,
  }
}

test('Master-Key: 32 Byte Base64, sonst sprechender Fehler ohne Wert', () => {
  assert.equal(parseMasterKey(MASTER).length, 32)
  assert.equal(parseMasterKey(` ${MASTER}\n`).length, 32)
  for (const bad of [undefined, '', 'zu-kurz', randomBytes(16).toString('base64'), 'ä'.repeat(44)]) {
    assert.throws(() => parseMasterKey(bad), AiEndpointError)
  }
  assert.throws(() => parseMasterKey('geheimer-wert'), (err) => !err.message.includes('geheimer-wert'))
})

test('API-Key: Roundtrip, zufälliger IV, an den Zweck gebunden', () => {
  const a = encryptApiKey('sk-test', { masterKey: MASTER, purpose: 'transcription' })
  const b = encryptApiKey('sk-test', { masterKey: MASTER, purpose: 'transcription' })
  assert.match(a, /^v1:[^:]+:[^:]+:[^:]+$/)
  assert.notEqual(a, b)
  assert.ok(!a.includes('sk-test'))
  assert.equal(decryptApiKey(a, { masterKey: MASTER, purpose: 'transcription' }), 'sk-test')
  assert.throws(() => decryptApiKey(a, { masterKey: MASTER, purpose: 'text_generation' }), AiEndpointError)
})

test('API-Key: falscher Master-Key, Manipulation und Fremdformat schlagen fehl', () => {
  const stored = encryptApiKey('sk-test', { masterKey: MASTER, purpose: 'transcription' })
  const other = randomBytes(32).toString('base64')
  assert.throws(() => decryptApiKey(stored, { masterKey: other, purpose: 'transcription' }), /nicht entschlüsseln/)

  const parts = stored.split(':')
  const flipped = Buffer.from(parts[3], 'base64')
  flipped[0] ^= 1
  const tampered = [...parts.slice(0, 3), flipped.toString('base64')].join(':')
  assert.throws(() => decryptApiKey(tampered, { masterKey: MASTER, purpose: 'transcription' }), AiEndpointError)
  assert.throws(() => decryptApiKey('sk-klartext', { masterKey: MASTER, purpose: 'transcription' }), /unbekanntes Format/)
  assert.throws(() => encryptApiKey('x', { masterKey: MASTER, purpose: 'chat' }), /Unbekannter Zweck/)
})

test('apiKeyHint zeigt höchstens die letzten vier Zeichen', () => {
  assert.equal(apiKeyHint('sk-or-v1-abcdef1234'), '…1234')
  assert.equal(apiKeyHint('kurz'), '…')
  assert.equal(apiKeyHint(null), null)
})

test('validateEndpointInput trimmt, normalisiert die URL und erlaubt fehlenden Key', () => {
  assert.deepEqual(
    validateEndpointInput({ purpose: 'transcription', name: ' Parakeet ', baseUrl: 'http://192.168.0.20:8000/v1/', model: ' parakeet ', apiKey: '' }),
    { ok: true, value: { purpose: 'transcription', name: 'Parakeet', baseUrl: 'http://192.168.0.20:8000/v1', model: 'parakeet', apiKey: null } }
  )
  assert.equal(validateEndpointInput({ purpose: 'text_generation', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: ' sk-1 ' }).value.apiKey, 'sk-1')
})

test('validateEndpointInput meldet jedes ungültige Feld', () => {
  const result = validateEndpointInput({ purpose: 'chat', name: '', baseUrl: 'ftp://host', model: 'x'.repeat(201), apiKey: 'a b' })
  assert.equal(result.ok, false)
  assert.deepEqual(Object.keys(result.errors).sort(), ['apiKey', 'baseUrl', 'model', 'name', 'purpose'])

  for (const baseUrl of ['', 'kein-url', 'https://user:pw@host/v1', 'https://host/v1?x=1', 'https://host/v1#a', `https://h/${'a'.repeat(500)}`]) {
    assert.ok(validateEndpointInput({ purpose: 'transcription', name: 'n', model: 'm', baseUrl }).errors?.baseUrl, baseUrl)
  }
  assert.equal(validateEndpointInput(null).ok, false)
})

test('ohne gespeicherte Endpunkte gilt das bisherige OpenRouter-Env-Verhalten', async () => {
  const endpoints = await resolveAiEndpoints({ supabase: makeFakeSupabase({ ai_endpoints: [] }), env: { OPENROUTER_API_KEY: 'or-key' } })
  assert.deepEqual(endpoints, getEnvAiEndpoints({ OPENROUTER_API_KEY: 'or-key' }))
  assert.deepEqual(endpoints.transcription, {
    purpose: 'transcription', source: 'env', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key', model: 'openai/whisper-large-v3',
  })
  assert.equal(endpoints.text_generation.model, 'google/gemini-2.5-flash')
  assert.equal(getEnvAiEndpoints({ OPENROUTER_MODEL: 'x/y' }).text_generation.model, 'x/y')
})

test('ein gespeicherter Endpunkt ersetzt nur seinen Zweck', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [storedRow(), { purpose: 'unbekannt', name: 'x', base_url: 'http://x', model: 'm', api_key_encrypted: null }] })
  const endpoints = await resolveAiEndpoints({ supabase, env: ENV })
  assert.deepEqual(endpoints.transcription, {
    purpose: 'transcription', source: 'database', name: 'Parakeet lokal', baseURL: 'http://ki-maschine:8000/v1', apiKey: 'sk-parakeet-123456', model: 'parakeet-tdt-0.6b-v3',
  })
  assert.equal(endpoints.text_generation.source, 'env')
  assert.deepEqual(Object.keys(endpoints).sort(), ['text_generation', 'transcription'])
})

test('Endpunkt ohne Key nutzt den Platzhalter und braucht keinen Master-Key', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [storedRow({ purpose: 'text_generation', api_key_encrypted: null })] })
  const endpoints = await resolveAiEndpoints({ supabase, env: { OPENROUTER_API_KEY: 'or-key' } })
  assert.equal(endpoints.text_generation.apiKey, KEYLESS_API_KEY)
})

test('gespeicherter Key ohne oder mit falschem Master-Key: Fehler ohne Key-Werte', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [storedRow()] })
  await assert.rejects(resolveAiEndpoints({ supabase, env: { OPENROUTER_API_KEY: 'or-key' } }), /AI_ENDPOINTS_ENCRYPTION_KEY fehlt/)
  await assert.rejects(
    resolveAiEndpoints({ supabase, env: { ...ENV, AI_ENDPOINTS_ENCRYPTION_KEY: randomBytes(32).toString('base64') } }),
    (err) => err instanceof AiEndpointError && !err.message.includes('sk-parakeet') && !err.message.includes(MASTER)
  )
})

test('fehlende Tabelle (Migration noch offen) fällt auf Env zurück, andere Fehler nicht', async () => {
  for (const code of ['PGRST205', '42P01']) {
    const endpoints = await resolveAiEndpoints({ supabase: failingSupabase({ code, message: 'missing' }), env: ENV })
    assert.equal(endpoints.transcription.source, 'env')
  }
  await assert.rejects(
    resolveAiEndpoints({ supabase: failingSupabase({ code: '57014', message: 'timeout' }), env: ENV }),
    /KI-Endpunkte konnten nicht gelesen werden: timeout/
  )
})

test('Resolver cacht für die TTL und liest danach neu', async () => {
  let reads = 0
  const rows = []
  const supabase = { from: () => ({ select: async () => { reads += 1; return { data: rows, error: null } } }) }
  let clock = 0
  const get = createAiEndpointResolver({ supabase, env: ENV, ttlMs: 1000, now: () => clock })

  assert.equal((await get()).transcription.source, 'env')
  rows.push(storedRow())
  clock = 999
  assert.equal((await get()).transcription.source, 'env')
  assert.equal(reads, 1)
  clock = 1000
  assert.equal((await get()).transcription.source, 'database')
  assert.equal(reads, 2)
})

test('Resolver behält bei Lesefehler den letzten Stand, ohne Stand wirft er', async () => {
  let error = null
  const supabase = { from: () => ({ select: async () => (error ? { data: null, error } : { data: [storedRow()], error: null }) }) }
  const logs = []
  let clock = 0
  const get = createAiEndpointResolver({ supabase, env: ENV, ttlMs: 10, now: () => clock, log: (...args) => logs.push(args) })

  assert.equal((await get()).transcription.source, 'database')
  error = { code: 'XX000', message: 'down' }
  clock = 10
  assert.equal((await get()).transcription.source, 'database')
  assert.deepEqual(logs, [['warn', 'ai_endpoints_refresh_failed', { error: 'KI-Endpunkte konnten nicht gelesen werden: down' }]])

  const fresh = createAiEndpointResolver({ supabase, env: ENV })
  await assert.rejects(fresh(), /down/)
})

test('toClientOptions und describeAiEndpoint geben den Key nur an den Client', () => {
  const endpoint = { purpose: 'transcription', source: 'database', name: 'P', baseURL: 'http://host:8000/v1', apiKey: 'sk-geheim', model: 'm' }
  assert.deepEqual(toClientOptions(endpoint), { baseURL: 'http://host:8000/v1', apiKey: 'sk-geheim' })
  const described = describeAiEndpoint(endpoint)
  assert.deepEqual(described, { purpose: 'transcription', source: 'database', name: 'P', model: 'm', host: 'host:8000' })
  assert.ok(!JSON.stringify(described).includes('sk-geheim'))
})
