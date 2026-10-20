import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiClients } from '../../worker/ai-clients.mjs'

function endpoint(purpose, overrides = {}) {
  return { purpose, source: 'env', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key', model: `${purpose}-model`, ...overrides }
}

function setup(initial) {
  let endpoints = initial
  const created = []
  const logs = []
  const ai = createAiClients({
    getEndpoints: async () => endpoints,
    createClient: (options) => {
      const client = {
        options,
        audio: { transcriptions: { create: async ({ model }) => ({ text: `${options.baseURL}|${model}` }) } },
      }
      created.push(client)
      return client
    },
    log: (...args) => logs.push(args),
  })
  return { ai, created, logs, setEndpoints: (next) => { endpoints = next } }
}

test('vor dem ersten refresh gibt es keinen Client', () => {
  const { ai } = setup({})
  assert.throws(() => ai.textGeneration(), /text_generation ist noch nicht geladen/)
  assert.throws(() => ai.transcribeChunk(Buffer.from('x'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'b' }), /transcription/)
})

test('baut je Zweck einen Client und nutzt ihn für Transkription und Text', async () => {
  const { ai, created, logs } = setup({
    transcription: endpoint('transcription', { source: 'database', name: 'Parakeet', baseURL: 'http://ki:8000/v1', apiKey: 'sk-p' }),
    text_generation: endpoint('text_generation'),
  })
  await ai.refresh()

  assert.deepEqual(created.map((c) => c.options), [
    { baseURL: 'http://ki:8000/v1', apiKey: 'sk-p' },
    { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
  ])
  assert.equal(await ai.transcribeChunk(Buffer.from('audio'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'episode' }), 'http://ki:8000/v1|transcription-model')
  assert.deepEqual(ai.textGeneration(), { client: created[1], model: 'text_generation-model' })
  assert.deepEqual(logs[0], ['info', 'ai_endpoint_active', { purpose: 'transcription', source: 'database', name: 'Parakeet', model: 'transcription-model', host: 'ki:8000' }])
  assert.ok(!JSON.stringify(logs).includes('sk-p') && !JSON.stringify(logs).includes('or-key'))
})

test('refresh baut nur geänderte Endpunkte neu', async () => {
  const text = endpoint('text_generation')
  const { ai, created, logs, setEndpoints } = setup({ transcription: endpoint('transcription'), text_generation: text })
  await ai.refresh()
  await ai.refresh()
  assert.equal(created.length, 2)

  setEndpoints({ transcription: endpoint('transcription', { apiKey: 'rotated' }), text_generation: { ...text } })
  await ai.refresh()
  assert.equal(created.length, 3)
  assert.deepEqual(created[2].options.apiKey, 'rotated')
  assert.equal(ai.textGeneration().client, created[1])

  setEndpoints({ transcription: endpoint('transcription', { apiKey: 'rotated' }), text_generation: { ...text, model: 'neu' } })
  await ai.refresh()
  assert.equal(created.length, 4)
  assert.equal(ai.textGeneration().model, 'neu')
  assert.equal(logs.length, 4)
})

test('fehlgeschlagener refresh lässt die bisherigen Clients aktiv', async () => {
  let fail = false
  const ai = createAiClients({
    getEndpoints: async () => {
      if (fail) throw new Error('db down')
      return { transcription: endpoint('transcription'), text_generation: endpoint('text_generation') }
    },
    createClient: (options) => ({ options }),
  })
  await ai.refresh()
  fail = true
  await assert.rejects(ai.refresh(), /db down/)
  assert.equal(ai.textGeneration().model, 'text_generation-model')
})
