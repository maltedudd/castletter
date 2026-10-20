import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { decryptApiKey, encryptApiKey } from '../../src/lib/ai/endpoints.mjs'
import { deleteEndpoint, listEndpointStatus, saveEndpoint, testEndpointConnection } from '../../src/lib/ai/endpoint-admin.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const MASTER = randomBytes(32).toString('base64')
const ENV = { OPENROUTER_API_KEY: 'sk-or-env-key', AI_ENDPOINTS_ENCRYPTION_KEY: MASTER }  // OPENROUTER_* must be ignored (NIAS-63)
const INPUT = { purpose: 'transcription', name: 'Parakeet', baseUrl: 'http://ki:8000/v1/', model: 'parakeet-v3', apiKey: 'sk-local-abcdef12' }

function storedTranscription(overrides = {}) {
  return {
    purpose: 'transcription', slot: 'primary', name: 'Parakeet', base_url: 'http://ki:8000/v1', model: 'parakeet-v3',
    api_key_encrypted: encryptApiKey('sk-local-abcdef12', { masterKey: MASTER, purpose: 'transcription' }),
    api_key_hint: '…ef12', updated_at: '2026-10-20T18:00:00Z', ...overrides,
  }
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { impl, calls }
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('Status: gespeicherter Endpunkt bzw. nicht eingerichtet, ohne Chiffrat oder Key', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [storedTranscription()] })
  const { endpoints, error } = await listEndpointStatus(supabase)
  assert.equal(error, null)
  assert.deepEqual(endpoints, [
    {
      purpose: 'transcription',
      primary: { purpose: 'transcription', slot: 'primary', name: 'Parakeet', baseUrl: 'http://ki:8000/v1', model: 'parakeet-v3', hasApiKey: true, apiKeyHint: '…ef12', updatedAt: '2026-10-20T18:00:00Z' },
      fallback: null,
    },
    { purpose: 'text_generation', primary: null, fallback: null },
  ])
  const serialized = JSON.stringify(endpoints)
  assert.ok(!serialized.includes('v1:') && !serialized.includes('sk-'))
})

test('Status: Fallback je Zweck', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [
    storedTranscription({ purpose: 'text_generation' }),
    storedTranscription({ purpose: 'text_generation', slot: 'fallback', name: 'Qwen', model: 'qwen', api_key_encrypted: null, api_key_hint: null }),
  ] })
  const { endpoints } = await listEndpointStatus(supabase)
  assert.equal(endpoints[0].fallback, null)
  assert.deepEqual(endpoints[1].fallback, {
    purpose: 'text_generation', slot: 'fallback', name: 'Qwen', baseUrl: 'http://ki:8000/v1', model: 'qwen', hasApiKey: false, apiKeyHint: null, updatedAt: '2026-10-20T18:00:00Z',
  })
})

test('Status bei Lesefehler: nicht eingerichtet plus Fehler', async () => {
  const supabase = { from: () => ({ select: async () => ({ data: null, error: { message: 'down' } }) }) }
  const { endpoints, error } = await listEndpointStatus(supabase)
  assert.equal(error, 'down')
  assert.deepEqual(endpoints.map((e) => [e.primary, e.fallback]), [[null, null], [null, null]])
})

test('Speichern: neuer Endpunkt mit verschlüsseltem Key und Hint', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  assert.deepEqual(await saveEndpoint(supabase, INPUT, ENV), { ok: true })
  const [row] = supabase.data.ai_endpoints
  assert.equal(row.base_url, 'http://ki:8000/v1')
  assert.equal(row.api_key_hint, '…ef12')
  assert.notEqual(row.api_key_encrypted, INPUT.apiKey)
  assert.equal(decryptApiKey(row.api_key_encrypted, { masterKey: MASTER, purpose: 'transcription' }), INPUT.apiKey)
  assert.deepEqual(supabase.writes[0].kind, 'upsert')
  assert.equal(row.slot, 'primary')
})

test('Speichern: Fallback als eigene Zeile mit eigenem, slotgebundenem Key', async () => {
  const stored = storedTranscription()
  const supabase = makeFakeSupabase({ ai_endpoints: [stored] })
  const fallback = { ...INPUT, slot: 'fallback', name: 'Whisper', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/whisper-large-v3', apiKey: 'sk-or-fallback-99' }
  assert.deepEqual(await saveEndpoint(supabase, fallback, ENV), { ok: true })
  assert.equal(supabase.data.ai_endpoints.length, 2)
  assert.deepEqual(supabase.data.ai_endpoints[0], stored)
  const row = supabase.data.ai_endpoints[1]
  assert.equal(row.slot, 'fallback')
  assert.equal(decryptApiKey(row.api_key_encrypted, { masterKey: MASTER, purpose: 'transcription', slot: 'fallback' }), 'sk-or-fallback-99')

  // Second save updates the fallback row only.
  assert.deepEqual(await saveEndpoint(supabase, { ...fallback, model: 'neu', apiKey: '' }, ENV), { ok: true })
  assert.deepEqual(supabase.data.ai_endpoints.map((r) => [r.slot, r.model]), [['primary', 'parakeet-v3'], ['fallback', 'neu']])
})

test('Speichern: Fallback nur mit gespeichertem Endpunkt; unbekannter Slot', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  const fallback = { ...INPUT, slot: 'fallback' }
  assert.deepEqual(await saveEndpoint(supabase, fallback, ENV), { ok: false, status: 400, code: 'primaryMissing' })
  assert.equal(supabase.data.ai_endpoints.length, 0)
  assert.deepEqual(await saveEndpoint(supabase, { ...fallback, slot: 'dritter' }, ENV), { ok: false, status: 400, code: 'invalid', fields: ['slot'] })
})

test('Speichern: leeres Key-Feld behält den Key, clearApiKey entfernt ihn', async () => {
  const stored = storedTranscription()
  const supabase = makeFakeSupabase({ ai_endpoints: [stored] })
  assert.deepEqual(await saveEndpoint(supabase, { ...INPUT, model: 'neu', apiKey: '' }, ENV), { ok: true })
  assert.equal(supabase.data.ai_endpoints[0].model, 'neu')
  assert.equal(supabase.data.ai_endpoints[0].api_key_encrypted, stored.api_key_encrypted)
  assert.ok(!('api_key_encrypted' in supabase.writes[0].payload))

  assert.deepEqual(await saveEndpoint(supabase, { ...INPUT, apiKey: '', clearApiKey: true }, ENV), { ok: true })
  assert.equal(supabase.data.ai_endpoints[0].api_key_encrypted, null)
  assert.equal(supabase.data.ai_endpoints[0].api_key_hint, null)
})

test('Speichern ohne Key braucht keinen Master-Key, mit Key schon', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  assert.deepEqual(await saveEndpoint(supabase, { ...INPUT, apiKey: '' }, {}), { ok: true })
  assert.deepEqual(await saveEndpoint(supabase, INPUT, {}), { ok: false, status: 500, code: 'masterKeyMissing' })
  assert.deepEqual(await saveEndpoint(supabase, INPUT, { AI_ENDPOINTS_ENCRYPTION_KEY: 'kaputt' }), { ok: false, status: 500, code: 'masterKeyInvalid' })
})

test('Speichern: Validierungsfehler als Feldliste, DB-Fehler als Code', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  assert.deepEqual(await saveEndpoint(supabase, { ...INPUT, baseUrl: 'ftp://x', model: '' }, ENV), { ok: false, status: 400, code: 'invalid', fields: ['model', 'baseUrl'] })
  assert.equal(supabase.writes.length, 0)
  const broken = { from: () => ({ upsert: async () => ({ error: { message: 'x' } }) }) }
  assert.deepEqual(await saveEndpoint(broken, INPUT, ENV), { ok: false, status: 500, code: 'saveFailed' })
})

test('Speichern: ein neuer Eintrag ohne Key wird ohne Key gespeichert, auch für OpenRouter', async () => {
  const openrouter = { purpose: 'text_generation', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y', apiKey: '' }
  const empty = makeFakeSupabase({ ai_endpoints: [] })
  assert.deepEqual(await saveEndpoint(empty, openrouter, ENV), { ok: true })
  assert.equal(empty.data.ai_endpoints[0].api_key_encrypted, undefined)
  assert.ok(!JSON.stringify(empty.data).includes('sk-or-env-key'))
})

test('Löschen: Endpunkt löscht den Fallback mit, Fallback allein lässt den Endpunkt', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [
    storedTranscription(),
    storedTranscription({ slot: 'fallback' }),
    storedTranscription({ purpose: 'text_generation', api_key_encrypted: null }),
    storedTranscription({ purpose: 'text_generation', slot: 'fallback', api_key_encrypted: null }),
  ] })
  assert.deepEqual(await deleteEndpoint(supabase, 'text_generation', 'fallback'), { ok: true })
  assert.deepEqual(supabase.data.ai_endpoints.map((r) => [r.purpose, r.slot]), [['transcription', 'primary'], ['transcription', 'fallback'], ['text_generation', 'primary']])
  assert.deepEqual(await deleteEndpoint(supabase, 'transcription'), { ok: true })
  assert.deepEqual(supabase.data.ai_endpoints.map((r) => [r.purpose, r.slot]), [['text_generation', 'primary']])
  assert.deepEqual(await deleteEndpoint(supabase, 'chat'), { ok: false, status: 400, code: 'invalid', fields: ['purpose'] })
  assert.deepEqual(await deleteEndpoint(supabase, 'transcription', 'dritter'), { ok: false, status: 400, code: 'invalid', fields: ['slot'] })
})

test('Verbindungstest: ok, Modell gefunden oder nicht, Bearer nur mit Key, keine Redirects', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  const ok = fakeFetch(() => jsonResponse(200, { data: [{ id: 'parakeet-v3' }] }))
  assert.deepEqual(await testEndpointConnection(supabase, INPUT, { env: ENV, fetchImpl: ok.impl }), { ok: true, status: 200, modelFound: true })
  assert.equal(ok.calls[0].url, 'http://ki:8000/v1/models')
  assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer sk-local-abcdef12')
  assert.equal(ok.calls[0].init.redirect, 'manual')

  const other = fakeFetch(() => jsonResponse(200, { data: [{ id: 'whisper' }] }))
  assert.equal((await testEndpointConnection(supabase, { ...INPUT, apiKey: '' }, { env: ENV, fetchImpl: other.impl })).modelFound, false)
  assert.deepEqual(other.calls[0].init.headers, {})

  const noList = fakeFetch(() => jsonResponse(200, { status: 'ok' }))
  assert.equal((await testEndpointConnection(supabase, INPUT, { env: ENV, fetchImpl: noList.impl })).modelFound, null)
})

test('Verbindungstest: HTTP-Fehler, Redirect, Timeout und Netzwerkfehler ohne Key im Text', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  const run = (handler) => testEndpointConnection(supabase, INPUT, { env: ENV, fetchImpl: fakeFetch(handler).impl })
  assert.deepEqual(await run(() => jsonResponse(401, {})), { ok: false, code: 'unauthorized', status: 401 })
  assert.deepEqual(await run(() => jsonResponse(503, {})), { ok: false, code: 'httpError', status: 503 })
  assert.deepEqual(await run(() => ({ ok: false, status: 302, json: async () => ({}) })), { ok: false, code: 'redirect', status: 302 })

  const timeout = await run(() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) })
  assert.equal(timeout.code, 'timeout')
  const failed = await run(() => { throw Object.assign(new Error('fetch failed for sk-local-abcdef12'), { cause: { code: 'ECONNREFUSED' } }) })
  assert.deepEqual(failed, { ok: false, code: 'unreachable', detail: 'fetch failed for ***: ECONNREFUSED' })
})

test('Verbindungstest: gespeicherter Key nur bei unveränderter Base-URL', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [storedTranscription()] })
  const same = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { ...INPUT, apiKey: '' }, { env: ENV, fetchImpl: same.impl })
  assert.equal(same.calls[0].init.headers.Authorization, 'Bearer sk-local-abcdef12')

  const moved = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { ...INPUT, baseUrl: 'https://fremd.example/v1', apiKey: '' }, { env: ENV, fetchImpl: moved.impl })
  assert.deepEqual(moved.calls[0].init.headers, {})

  const cleared = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { ...INPUT, apiKey: '', clearApiKey: true }, { env: ENV, fetchImpl: cleared.impl })
  assert.deepEqual(cleared.calls[0].init.headers, {})

  const unreadable = await testEndpointConnection(supabase, { ...INPUT, apiKey: '' }, { env: { AI_ENDPOINTS_ENCRYPTION_KEY: randomBytes(32).toString('base64') }, fetchImpl: same.impl })
  assert.deepEqual(unreadable, { ok: false, code: 'storedKeyUnreadable' })
})

test('Verbindungstest Fallback: nur der eigene gespeicherte Key, nie der primäre oder der Env-Key', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [
    storedTranscription(),
    storedTranscription({
      slot: 'fallback', base_url: 'http://backup:8000/v1',
      api_key_encrypted: encryptApiKey('sk-backup-777', { masterKey: MASTER, purpose: 'transcription', slot: 'fallback' }),
    }),
  ] })
  const own = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { ...INPUT, slot: 'fallback', baseUrl: 'http://backup:8000/v1', apiKey: '' }, { env: ENV, fetchImpl: own.impl })
  assert.equal(own.calls[0].init.headers.Authorization, 'Bearer sk-backup-777')

  const primaryUrl = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { ...INPUT, slot: 'fallback', apiKey: '' }, { env: ENV, fetchImpl: primaryUrl.impl })
  assert.deepEqual(primaryUrl.calls[0].init.headers, {})

  const openrouter = fakeFetch(() => jsonResponse(200, { data: [] }))
  const fresh = makeFakeSupabase({ ai_endpoints: [] })
  await testEndpointConnection(fresh, { purpose: 'text_generation', slot: 'fallback', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' }, { env: ENV, fetchImpl: openrouter.impl })
  assert.deepEqual(openrouter.calls[0].init.headers, {})
})

test('Verbindungstest ohne gespeicherten Endpunkt: nie ein Key aus der Env', async () => {
  const supabase = makeFakeSupabase({ ai_endpoints: [] })
  const openrouter = fakeFetch(() => jsonResponse(200, { data: [] }))
  await testEndpointConnection(supabase, { purpose: 'text_generation', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' }, { env: ENV, fetchImpl: openrouter.impl })
  assert.deepEqual(openrouter.calls[0].init.headers, {})
})

test('Verbindungstest validiert die Eingabe vor jedem Request', async () => {
  const calls = fakeFetch(() => jsonResponse(200, {}))
  const result = await testEndpointConnection(makeFakeSupabase({ ai_endpoints: [] }), { ...INPUT, baseUrl: 'javascript:alert(1)' }, { env: ENV, fetchImpl: calls.impl })
  assert.deepEqual(result, { ok: false, code: 'invalid', fields: ['baseUrl'] })
  assert.equal(calls.calls.length, 0)
})
