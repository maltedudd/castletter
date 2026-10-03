import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorkerConfig, DEFAULTS } from '../../worker/config.mjs'

const REQUIRED = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  OPENROUTER_API_KEY: 'or-key',
}

test('applies defaults when only the required secrets are set', () => {
  const config = loadWorkerConfig(REQUIRED)

  assert.equal(config.supabaseUrl, 'https://example.supabase.co')
  assert.equal(config.pollIntervalMs, DEFAULTS.pollIntervalSeconds * 1000)
  assert.equal(config.maxEpisodeAgeDays, 7)
  assert.equal(config.maxAttempts, 3)
  assert.equal(config.downloadTimeoutMs, 120_000)
  assert.equal(config.heartbeatUrl, null)
  assert.equal(config.openrouter.transcriptionModel, 'openai/whisper-large-v3')
})

test('accepts NEXT_PUBLIC_SUPABASE_URL so the app .env can be reused', () => {
  const { SUPABASE_URL, ...rest } = REQUIRED
  const config = loadWorkerConfig({ ...rest, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL })
  assert.equal(config.supabaseUrl, SUPABASE_URL)
})

test('reads overrides', () => {
  const config = loadWorkerConfig({
    ...REQUIRED,
    TRANSCRIPTION_POLL_INTERVAL_SECONDS: '30',
    TRANSCRIPTION_MAX_EPISODE_AGE_DAYS: '120',
    TRANSCRIPTION_MAX_ATTEMPTS: '5',
    TRANSCRIPTION_HEARTBEAT_URL: 'https://hooks.example/heartbeat',
    OPENROUTER_TRANSCRIPTION_MODEL: 'openai/gpt-4o-mini-transcribe',
  })

  assert.equal(config.pollIntervalMs, 30_000)
  assert.equal(config.maxEpisodeAgeDays, 120)
  assert.equal(config.maxAttempts, 5)
  assert.equal(config.heartbeatUrl, 'https://hooks.example/heartbeat')
  assert.equal(config.openrouter.transcriptionModel, 'openai/gpt-4o-mini-transcribe')
})

test('names missing secrets without echoing any values', () => {
  assert.throws(
    () => loadWorkerConfig({ SUPABASE_SERVICE_ROLE_KEY: 'geheim' }),
    (err) => err.message === 'Fehlende Umgebungsvariablen: SUPABASE_URL, OPENROUTER_API_KEY'
  )
})

test('rejects non-positive or non-integer numbers', () => {
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, TRANSCRIPTION_MAX_ATTEMPTS: '0' }), /TRANSCRIPTION_MAX_ATTEMPTS/)
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, TRANSCRIPTION_POLL_INTERVAL_SECONDS: 'abc' }), /POLL_INTERVAL/)
})
