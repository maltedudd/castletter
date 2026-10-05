import { getOpenRouterConfig } from '../src/lib/cron/openrouter-config.mjs'
import { TRANSCRIBING_LEASE_MS } from '../src/lib/cron/transcribe-ack.mjs'

export const DEFAULTS = {
  pollIntervalSeconds: 60,
  maxEpisodeAgeDays: 7,
  maxAttempts: 3,
  downloadTimeoutSeconds: 120,
  heartbeatFile: '/tmp/castletter-worker-heartbeat',
  fromEmail: 'castletter.io <newsletter@castletter.io>',
  feedCheckIntervalMinutes: 30,
  ytDlpPath: 'yt-dlp',
  youtubeDownloadTimeoutSeconds: 600,
  youtubeCaptionLanguages: ['de', 'en'],
}

// Each yt-dlp stage must finish well inside the transcription lease, which is only renewed
// between stages and chunks.
const MAX_YOUTUBE_TIMEOUT_SECONDS = Math.floor(TRANSCRIBING_LEASE_MS / 1000) - 60

/**
 * Reads the worker configuration from the environment. Throws with the names (never the
 * values) of missing secrets, so a misconfigured container fails fast and visibly.
 */
export function loadWorkerConfig(env = process.env) {
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  const openrouter = getOpenRouterConfig(env)

  const missing = []
  if (!supabaseUrl) missing.push('SUPABASE_URL')
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!openrouter.client.apiKey) missing.push('OPENROUTER_API_KEY')

  // Newsletter generation + sending is opt-in so the worker can be rolled out step by step.
  const newslettersEnabled = env.WORKER_NEWSLETTERS_ENABLED === 'true'
  const appUrl = env.APP_URL || env.NEXT_PUBLIC_APP_URL
  if (newslettersEnabled) {
    if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY')
    if (!appUrl) missing.push('APP_URL')
  }
  if (missing.length > 0) {
    throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(', ')}`)
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    openrouter,
    pollIntervalMs: positiveInt(env, 'TRANSCRIPTION_POLL_INTERVAL_SECONDS', DEFAULTS.pollIntervalSeconds) * 1000,
    maxEpisodeAgeDays: positiveInt(env, 'TRANSCRIPTION_MAX_EPISODE_AGE_DAYS', DEFAULTS.maxEpisodeAgeDays),
    maxAttempts: positiveInt(env, 'TRANSCRIPTION_MAX_ATTEMPTS', DEFAULTS.maxAttempts),
    downloadTimeoutMs: positiveInt(env, 'TRANSCRIPTION_DOWNLOAD_TIMEOUT_SECONDS', DEFAULTS.downloadTimeoutSeconds) * 1000,
    heartbeatFile: env.TRANSCRIPTION_HEARTBEAT_FILE || DEFAULTS.heartbeatFile,
    heartbeatUrl: env.TRANSCRIPTION_HEARTBEAT_URL || null,
    // Feed check (replaces the check-new-episodes cron) is opt-in as well.
    feedCheckIntervalMs: env.WORKER_FEED_CHECK_ENABLED === 'true'
      ? positiveInt(env, 'FEED_CHECK_INTERVAL_MINUTES', DEFAULTS.feedCheckIntervalMinutes) * 60 * 1000
      : null,
    youtube: {
      ytDlpPath: env.YTDLP_PATH || DEFAULTS.ytDlpPath,
      downloadTimeoutMs: youtubeTimeoutSeconds(env) * 1000,
      captionLanguages: parseLanguages(env.YOUTUBE_CAPTION_LANGUAGES) ?? DEFAULTS.youtubeCaptionLanguages,
    },
    newsletters: newslettersEnabled
      ? {
          resendApiKey: env.RESEND_API_KEY,
          fromEmail: env.FROM_EMAIL || DEFAULTS.fromEmail,
          settingsUrl: `${appUrl.replace(/\/+$/, '')}/settings`,
        }
      : null,
  }
}

function youtubeTimeoutSeconds(env) {
  const seconds = positiveInt(env, 'YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS', DEFAULTS.youtubeDownloadTimeoutSeconds)
  if (seconds > MAX_YOUTUBE_TIMEOUT_SECONDS) {
    throw new Error(`YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS darf höchstens ${MAX_YOUTUBE_TIMEOUT_SECONDS} sein (Transkriptions-Lease), ist: ${seconds}`)
  }
  return seconds
}

function parseLanguages(raw) {
  if (!raw) return null
  const languages = raw.split(',').map((l) => l.trim()).filter((l) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(l))
  return languages.length > 0 ? languages : null
}

function positiveInt(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} muss eine positive ganze Zahl sein (ist: ${raw})`)
  }
  return value
}
