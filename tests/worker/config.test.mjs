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
  assert.equal(config.downloadTimeoutMs, 600_000)
  assert.equal(config.transcodeTimeoutMs, 600_000)
  assert.equal(config.ffmpegPath, 'ffmpeg')
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

test('newsletter pipeline is off unless explicitly enabled', () => {
  assert.equal(loadWorkerConfig({ ...REQUIRED, RESEND_API_KEY: 're' }).newsletters, null)
})

test('enabled newsletter pipeline requires RESEND_API_KEY and APP_URL', () => {
  assert.throws(
    () => loadWorkerConfig({ ...REQUIRED, WORKER_NEWSLETTERS_ENABLED: 'true' }),
    (err) => err.message === 'Fehlende Umgebungsvariablen: RESEND_API_KEY, APP_URL'
  )

  const config = loadWorkerConfig({
    ...REQUIRED,
    WORKER_NEWSLETTERS_ENABLED: 'true',
    RESEND_API_KEY: 're',
    NEXT_PUBLIC_APP_URL: 'https://castletter.example/',
  })
  assert.deepEqual(config.newsletters, {
    resendApiKey: 're',
    fromEmail: 'castletter.io <newsletter@castletter.io>',
    settingsUrl: 'https://castletter.example/settings',
  })
  assert.equal(config.openrouter.newsletterModel, 'google/gemini-2.5-flash')
})

test('feed check is off by default and runs every 30 minutes when enabled', () => {
  assert.equal(loadWorkerConfig(REQUIRED).feedCheckIntervalMs, null)
  assert.equal(loadWorkerConfig({ ...REQUIRED, WORKER_FEED_CHECK_ENABLED: 'true' }).feedCheckIntervalMs, 30 * 60 * 1000)
  assert.equal(
    loadWorkerConfig({ ...REQUIRED, WORKER_FEED_CHECK_ENABLED: 'true', FEED_CHECK_INTERVAL_MINUTES: '15' }).feedCheckIntervalMs,
    15 * 60 * 1000
  )
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, WORKER_FEED_CHECK_ENABLED: 'true', FEED_CHECK_INTERVAL_MINUTES: '0' }), /FEED_CHECK_INTERVAL_MINUTES/)
})

test('YouTube transcription defaults and overrides', () => {
  assert.deepEqual(loadWorkerConfig(REQUIRED).youtube, {
    ytDlpPath: 'yt-dlp',
    downloadTimeoutMs: 600_000,
    captionLanguages: ['de', 'en'],
  })
  assert.deepEqual(
    loadWorkerConfig({
      ...REQUIRED,
      YTDLP_PATH: '/opt/yt-dlp/bin/yt-dlp',
      YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS: '300',
      YOUTUBE_CAPTION_LANGUAGES: 'en, de-DE, ;rm',
    }).youtube,
    { ytDlpPath: '/opt/yt-dlp/bin/yt-dlp', downloadTimeoutMs: 300_000, captionLanguages: ['en', 'de-DE'] }
  )
})

test('YouTube download timeout must stay inside the transcription lease', () => {
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS: '900' }), /höchstens 840/)
})

test('download and transcode timeouts are configurable but must stay inside the lease', () => {
  const config = loadWorkerConfig({
    ...REQUIRED,
    TRANSCRIPTION_DOWNLOAD_TIMEOUT_SECONDS: '300',
    TRANSCRIPTION_TRANSCODE_TIMEOUT_SECONDS: '200',
    FFMPEG_PATH: '/usr/local/bin/ffmpeg',
  })
  assert.deepEqual([config.downloadTimeoutMs, config.transcodeTimeoutMs, config.ffmpegPath], [300_000, 200_000, '/usr/local/bin/ffmpeg'])
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, TRANSCRIPTION_DOWNLOAD_TIMEOUT_SECONDS: '900' }), /TRANSCRIPTION_DOWNLOAD_TIMEOUT_SECONDS darf höchstens 840/)
  assert.throws(() => loadWorkerConfig({ ...REQUIRED, TRANSCRIPTION_TRANSCODE_TIMEOUT_SECONDS: '841' }), /TRANSCRIPTION_TRANSCODE_TIMEOUT_SECONDS/)
})
