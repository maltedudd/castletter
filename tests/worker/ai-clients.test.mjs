import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiClients } from '../../worker/ai-clients.mjs'

function endpoint(purpose, overrides = {}) {
  return { purpose, slot: 'primary', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key', model: `${purpose}-model`, ...overrides }
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
        calls: [],
        audio: { transcriptions: { create: async ({ model }) => {
          if (options.baseURL.includes('down')) throw Object.assign(new Error(`${options.baseURL} down`), { status: 503 })
          return { text: `${options.baseURL}|${model}` }
        } } },
        chat: { completions: { create: async (request) => {
          client.calls.push(request)
          if (options.baseURL.includes('down')) throw new Error('ECONNREFUSED')
          return { choices: [{ message: { content: `${options.baseURL}|${request.model}` } }] }
        } } },
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
    transcription: endpoint('transcription', { name: 'Parakeet', baseURL: 'http://ki:8000/v1', apiKey: 'sk-p' }),
    text_generation: endpoint('text_generation'),
  })
  await ai.refresh()

  assert.deepEqual(created.map((c) => c.options), [
    { baseURL: 'http://ki:8000/v1', apiKey: 'sk-p' },
    { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
  ])
  assert.equal(await ai.transcribeChunk(Buffer.from('audio'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'episode' }), 'http://ki:8000/v1|transcription-model')
  assert.deepEqual(ai.textGeneration(), { client: created[1], model: 'text_generation-model' })
  assert.deepEqual(logs[0], ['info', 'ai_endpoint_active', { purpose: 'transcription', slot: 'primary', name: 'Parakeet', model: 'transcription-model', host: 'ki:8000' }])
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

test('Transkription: Fehler des Primären → Fallback, ohne Fallback der Fehler', async () => {
  const fallback = endpoint('transcription', { slot: 'fallback', name: 'Whisper', model: 'whisper', apiKey: 'sk-f' })
  const { ai, created, logs, setEndpoints } = setup({
    transcription: { ...endpoint('transcription', { name: 'Parakeet', baseURL: 'http://down:8091/v1' }), fallback },
    text_generation: endpoint('text_generation'),
  })
  await ai.refresh()
  assert.deepEqual(created.map((c) => c.options.baseURL), ['http://down:8091/v1', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'])
  assert.deepEqual(logs.map(([, msg, info]) => [msg, info.purpose, info.slot]), [
    ['ai_endpoint_active', 'transcription', 'primary'],
    ['ai_endpoint_active', 'transcription', 'fallback'],
    ['ai_endpoint_active', 'text_generation', 'primary'],
  ])

  const format = { contentType: 'audio/mpeg', ext: 'mp3', basename: 'episode' }
  assert.equal(await ai.transcribeChunk(Buffer.from('audio'), format), 'https://openrouter.ai/api/v1|whisper')
  assert.equal(logs.at(-1)[1], 'ai_endpoint_fallback')
  assert.ok(!JSON.stringify(logs).includes('sk-f'))

  // Fallback removed in the admin area: rebuilt, the error surfaces again.
  setEndpoints({
    transcription: { ...endpoint('transcription', { name: 'Parakeet', baseURL: 'http://down:8091/v1' }), fallback: null },
    text_generation: endpoint('text_generation'),
  })
  await ai.refresh()
  await assert.rejects(ai.transcribeChunk(Buffer.from('audio'), format), /down:8091\/v1 down/)
})

test('Text: Fallback mit eigenem Modell und Gemini-Optionen nur für Gemini', async () => {
  const { ai, created } = setup({
    transcription: endpoint('transcription'),
    text_generation: {
      ...endpoint('text_generation', { baseURL: 'http://down:8080/v1', model: 'qwen' }),
      fallback: endpoint('text_generation', { slot: 'fallback', model: 'google/gemini-2.5-flash' }),
    },
  })
  await ai.refresh()
  const { client, model } = ai.textGeneration()
  assert.equal(model, 'qwen')
  const completion = await client.chat.completions.create({ model, max_tokens: 3000, temperature: 0.7, messages: [] })
  assert.equal(completion.choices[0].message.content, 'https://openrouter.ai/api/v1|google/gemini-2.5-flash')
  const [down, fallback] = [created[1], created[2]]
  assert.equal(down.calls[0].model, 'qwen')
  assert.equal('reasoning' in down.calls[0], false)
  assert.deepEqual(fallback.calls[0].reasoning, { effort: 'none' })
})

test('Zweck ohne Endpunkt: einmal ai_endpoint_missing, klare Fehlermeldung, nach Eintrag wieder aktiv', async () => {
  const { ai, logs, setEndpoints } = setup({ transcription: null, text_generation: endpoint('text_generation') })
  await ai.refresh()
  await ai.refresh()
  assert.deepEqual(logs.filter(([, msg]) => msg === 'ai_endpoint_missing'), [['warn', 'ai_endpoint_missing', { purpose: 'transcription' }]])
  assert.throws(
    () => ai.transcribeChunk(Buffer.from('audio'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'e' }),
    /Kein KI-Endpunkt für transcription hinterlegt/
  )
  assert.equal(ai.textGeneration().model, 'text_generation-model')

  setEndpoints({ transcription: endpoint('transcription', { name: 'Parakeet' }), text_generation: endpoint('text_generation') })
  await ai.refresh()
  assert.equal(await ai.transcribeChunk(Buffer.from('audio'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'e' }), 'https://openrouter.ai/api/v1|transcription-model')

  setEndpoints({ transcription: null, text_generation: endpoint('text_generation') })
  await ai.refresh()
  assert.equal(logs.filter(([, msg]) => msg === 'ai_endpoint_missing').length, 2)
})
