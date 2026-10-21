// NIAS-62: fallback between the primary and the optional fallback endpoint of one purpose.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EmptyCompletionError, createFallbackChatClient, withFallback } from '../../src/lib/ai/fallback.mjs'

function attempt(name, slot, client = {}) {
  return {
    endpoint: { purpose: 'text_generation', slot, source: 'database', name, baseURL: `http://${name}:8080/v1`, apiKey: `sk-${name}`, model: `${name}-model` },
    client,
  }
}

function chatClient(answer) {
  const calls = []
  return {
    calls,
    chat: { completions: { create: async (options, requestOptions) => {
      calls.push({ options, requestOptions })
      if (answer instanceof Error) throw answer
      return { choices: [{ message: { content: answer } }] }
    } } },
  }
}

test('withFallback: Erfolg des Primären ruft den Fallback nicht auf', async () => {
  const seen = []
  const logs = []
  const result = await withFallback(attempt('a', 'primary'), attempt('b', 'fallback'), ({ endpoint }) => { seen.push(endpoint.name); return 'ok' }, (...args) => logs.push(args))
  assert.equal(result, 'ok')
  assert.deepEqual(seen, ['a'])
  assert.deepEqual(logs, [])
})

test('withFallback: jeder Fehler des Primären führt zum Fallback, geloggt ohne Key', async () => {
  const logs = []
  const result = await withFallback(
    attempt('a', 'primary'),
    attempt('b', 'fallback'),
    ({ endpoint }) => {
      if (endpoint.name === 'a') throw Object.assign(new Error('404 model not found'), { status: 404 })
      return 'vom Fallback'
    },
    (...args) => logs.push(args)
  )
  assert.equal(result, 'vom Fallback')
  assert.deepEqual(logs, [['warn', 'ai_endpoint_fallback', {
    purpose: 'text_generation',
    from: { purpose: 'text_generation', slot: 'primary', source: 'database', name: 'a', model: 'a-model', host: 'a:8080' },
    to: { purpose: 'text_generation', slot: 'fallback', source: 'database', name: 'b', model: 'b-model', host: 'b:8080' },
    error: '404 model not found',
  }]])
  assert.ok(!JSON.stringify(logs).includes('sk-'))
})

test('withFallback: ohne Fallback der Originalfehler, beide gescheitert der Fallback-Fehler mit Hinweis', async () => {
  const original = Object.assign(new Error('down'), { status: 503 })
  await assert.rejects(withFallback(attempt('a', 'primary'), null, () => { throw original }), (err) => err === original)

  await assert.rejects(
    withFallback(attempt('a', 'primary'), attempt('b', 'fallback'), ({ endpoint }) => {
      throw Object.assign(new Error(`${endpoint.name} kaputt`), { status: endpoint.name === 'a' ? 500 : 429 })
    }),
    (err) => err.message === 'b kaputt (Fallback nach Fehler von a: a kaputt)' && err.status === 429
  )
})

test('Chat-Client ohne Fallback ist der unveränderte primäre Client', () => {
  const primary = attempt('a', 'primary', chatClient('x'))
  assert.equal(createFallbackChatClient(primary, null), primary.client)
})

test('Chat-Client: Modell und modellabhängige Optionen je Versuch, Request-Optionen bleiben', async () => {
  const primary = attempt('a', 'primary', chatClient(new Error('ECONNREFUSED')))
  const fallback = attempt('b', 'fallback', chatClient('Antwort'))
  const prepare = (options, model) => ({ ...options, model, tuned: model === 'a-model' })
  const client = createFallbackChatClient(primary, fallback, { prepare })

  const completion = await client.chat.completions.create({ model: 'a-model', messages: [{ role: 'user', content: 'hi' }] }, { timeout: 5 })
  assert.equal(completion.choices[0].message.content, 'Antwort')
  assert.deepEqual(primary.client.calls[0], { options: { model: 'a-model', messages: [{ role: 'user', content: 'hi' }], tuned: true }, requestOptions: { timeout: 5 } })
  assert.deepEqual(fallback.client.calls[0], { options: { model: 'b-model', messages: [{ role: 'user', content: 'hi' }], tuned: false }, requestOptions: { timeout: 5 } })
})

test('Chat-Client: leere Antwort des Primären zählt als Fehler, leere Antwort des Fallbacks wird zurückgegeben', async () => {
  const logs = []
  const primary = attempt('a', 'primary', chatClient(''))
  const fallback = attempt('b', 'fallback', chatClient(''))
  const completion = await createFallbackChatClient(primary, fallback, { log: (...args) => logs.push(args) })
    .chat.completions.create({ model: 'a-model', messages: [] })
  assert.equal(completion.choices[0].message.content, '')
  assert.equal(fallback.client.calls.length, 1)
  assert.equal(logs[0][2].error, new EmptyCompletionError(primary.endpoint).message)
})
