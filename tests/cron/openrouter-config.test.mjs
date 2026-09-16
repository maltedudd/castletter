import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OPENROUTER_BASE_URL,
  DEFAULT_NEWSLETTER_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  getOpenRouterConfig,
} from '../../src/lib/cron/openrouter-config.mjs'

test('uses the shared OpenRouter client configuration and default models', () => {
  assert.deepEqual(getOpenRouterConfig({ OPENROUTER_API_KEY: 'test-key' }), {
    client: {
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
    },
    newsletterModel: 'google/gemini-2.5-flash',
    transcriptionModel: 'openai/whisper-large-v3',
  })
  assert.equal(OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1')
  assert.equal(DEFAULT_NEWSLETTER_MODEL, 'google/gemini-2.5-flash')
  assert.equal(DEFAULT_TRANSCRIPTION_MODEL, 'openai/whisper-large-v3')
})

test('selects newsletter and transcription overrides independently', () => {
  assert.deepEqual(
    getOpenRouterConfig({
      OPENROUTER_API_KEY: 'another-key',
      OPENROUTER_MODEL: 'custom/newsletter',
      OPENROUTER_TRANSCRIPTION_MODEL: 'custom/transcription',
    }),
    {
      client: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'another-key',
      },
      newsletterModel: 'custom/newsletter',
      transcriptionModel: 'custom/transcription',
    }
  )

  assert.equal(
    getOpenRouterConfig({ OPENROUTER_MODEL: 'custom/newsletter' }).transcriptionModel,
    DEFAULT_TRANSCRIPTION_MODEL
  )
  assert.equal(
    getOpenRouterConfig({ OPENROUTER_TRANSCRIPTION_MODEL: 'custom/transcription' }).newsletterModel,
    DEFAULT_NEWSLETTER_MODEL
  )
})
