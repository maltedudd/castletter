// Transcript for one YouTube video: complete captions first, otherwise the full audio goes
// through the existing OpenRouter STT path. Dependency-free: the YouTube access (metadata,
// caption and audio download — yt-dlp in the worker) and the STT function are injected.
//
// Never returns a partial transcript: truncated captions are not accepted, and any audio or
// STT failure rejects instead of returning what was transcribed so far.

import { PermanentError } from '../transcription/audio-transcriber.mjs'

/** Persisted in `episodes.error_code` so failures are actionable without reading logs. */
export const YOUTUBE_ERROR_CODES = {
  videoUnavailable: 'video_unavailable',
  videoNotYetAvailable: 'video_not_yet_available',
  youtubeBlocked: 'youtube_blocked',
  youtubeFetchFailed: 'youtube_fetch_failed',
  youtubeToolMissing: 'youtube_tool_missing',
  audioDownloadFailed: 'audio_download_failed',
  sttFailed: 'stt_failed',
}

/** Retrying will not help (private/removed/members-only video, no speech). */
export class YouTubePermanentError extends PermanentError {
  constructor(code, message) {
    super(message)
    this.name = 'YouTubePermanentError'
    this.code = code
  }
}

/** Worth retrying later (premiere not started, bot check, timeout, STT outage). */
export class YouTubeTemporaryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'YouTubeTemporaryError'
    this.code = code
  }
}

const UNAVAILABLE_AVAILABILITY = new Set(['private', 'premium_only', 'subscriber_only', 'needs_auth'])
const NOT_YET_LIVE_STATUS = new Set(['is_live', 'is_upcoming', 'post_live'])
export const DEFAULT_CAPTION_LANGUAGES = ['de', 'en']

// Caption completeness rules. Captions count as complete if they run to the end of the video
// (allowing for an outro of up to 60 s or 5 % of the duration) and carry real speech.
const MIN_CAPTION_WORDS = 20
const MIN_CAPTION_WORDS_PER_MINUTE = 15
const MAX_TRAILING_GAP_MS = 60_000
const MAX_TRAILING_GAP_RATIO = 0.05

/**
 * Returns `{ transcript, source: 'captions' }` or, after the fallback,
 * `{ transcript, source: 'audio_stt', captionsReason }` (why captions were not used).
 *
 * `youtube`: `{ fetchMetadata(videoId), downloadCaptions(videoId, track), downloadAudio(videoId) }`
 * (metadata in yt-dlp's JSON shape; the audio object is passed through unchanged).
 * `transcribeAudio({ ...audio, onChunkTranscribed, onProgress })` is the STT path.
 * `onChunkTranscribed` and `onProgress` (called between the download stages so the worker
 * can renew its lease) may throw, e.g. on a lost lease; those errors propagate unchanged.
 */
export async function transcribeYouTubeVideo({
  videoId,
  youtube,
  transcribeAudio,
  captionLanguages = DEFAULT_CAPTION_LANGUAGES,
  onChunkTranscribed = async () => {},
  onProgress = async () => {},
}) {
  const metadata = await youtube.fetchMetadata(videoId)
  assertVideoProcessable(metadata)
  await onProgress({ stage: 'metadata' })

  const captions = await tryCaptions({ videoId, youtube, metadata, captionLanguages })
  if (captions.transcript) return { transcript: captions.transcript, source: 'captions' }
  await onProgress({ stage: 'captions' })

  const prefix = `Keine verwendbaren YouTube-Untertitel (${captions.reason})`
  let audio
  try {
    audio = await youtube.downloadAudio(videoId)
  } catch (err) {
    throw rewrap(err, YOUTUBE_ERROR_CODES.audioDownloadFailed, `${prefix}; Audio-Download fehlgeschlagen`)
  }
  await onProgress({ stage: 'audio' })

  // Errors of our callbacks (lost lease) must not be relabelled as STT failures.
  let callbackError = null
  const tracked = (fn) => async (info) => {
    try {
      await fn(info)
    } catch (err) {
      callbackError = err
      throw err
    }
  }
  try {
    const transcript = await transcribeAudio({
      ...audio,
      onChunkTranscribed: tracked(onChunkTranscribed),
      onProgress: tracked(onProgress),
    })
    return { transcript, source: 'audio_stt', captionsReason: captions.reason }
  } catch (err) {
    if (callbackError && err === callbackError) throw err
    throw rewrap(err, YOUTUBE_ERROR_CODES.sttFailed, `${prefix}; Audio-Transkription fehlgeschlagen`, { keepCode: false })
  }
}

function assertVideoProcessable(metadata) {
  if (NOT_YET_LIVE_STATUS.has(metadata?.live_status)) {
    throw new YouTubeTemporaryError(
      YOUTUBE_ERROR_CODES.videoNotYetAvailable,
      `Video ist noch nicht abrufbar (Livestream/Premiere: ${metadata.live_status}) – wird später erneut versucht`
    )
  }
  if (UNAVAILABLE_AVAILABILITY.has(metadata?.availability)) {
    throw new YouTubePermanentError(
      YOUTUBE_ERROR_CODES.videoUnavailable,
      `Video ist nicht öffentlich abrufbar (${metadata.availability})`
    )
  }
}

async function tryCaptions({ videoId, youtube, metadata, captionLanguages }) {
  const track = selectCaptionTrack(metadata, captionLanguages)
  if (!track) return { reason: 'keine Untertitel vorhanden' }

  let doc
  try {
    doc = await youtube.downloadCaptions(videoId, track)
  } catch (err) {
    return { reason: `Untertitel-Download fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parseJson3Captions(doc)
  const assessment = assessCaptions(parsed, metadata.duration)
  return assessment.usable ? { transcript: parsed.text } : { reason: assessment.reason }
}

/** Keeps permanence of the underlying error; YouTube codes of the cause win unless told otherwise. */
function rewrap(err, fallbackCode, prefix, { keepCode = true } = {}) {
  const message = `${prefix}: ${err instanceof Error ? err.message : String(err)}`
  const code = keepCode && typeof err?.code === 'string' && Object.values(YOUTUBE_ERROR_CODES).includes(err.code)
    ? err.code
    : fallbackCode
  return err instanceof PermanentError ? new YouTubePermanentError(code, message) : new YouTubeTemporaryError(code, message)
}

function json3Tracks(tracks) {
  return Object.entries(tracks ?? {})
    .filter(([language, formats]) => language !== 'live_chat' && Array.isArray(formats) && formats.some((f) => f?.ext === 'json3'))
    .map(([language]) => language)
}

function matchLanguage(languages, wanted) {
  if (!wanted) return null
  const base = wanted.toLowerCase()
  return languages.find((l) => l.toLowerCase() === base) ??
    languages.find((l) => l.toLowerCase().startsWith(`${base}-`) && !l.endsWith('-orig')) ??
    null
}

/**
 * Picks `{ language, automatic }` or `null`:
 * 1. human-made captions — original language, then `preferredLanguages`, then any;
 * 2. automatic captions only in the original spoken language (`<lang>-orig` or the video's
 *    language). Other automatic tracks are machine translations and never used.
 */
export function selectCaptionTrack(metadata, preferredLanguages = DEFAULT_CAPTION_LANGUAGES) {
  const original = metadata?.language || null

  const manual = json3Tracks(metadata?.subtitles)
  for (const wanted of [original, ...preferredLanguages]) {
    const language = matchLanguage(manual, wanted)
    if (language) return { language, automatic: false }
  }
  if (manual.length > 0) return { language: manual[0], automatic: false }

  const automatic = json3Tracks(metadata?.automatic_captions)
  const orig = (original && automatic.find((l) => l.toLowerCase() === `${original.toLowerCase()}-orig`)) ||
    automatic.find((l) => l.endsWith('-orig'))
  if (orig) return { language: orig, automatic: true }
  if (original && automatic.includes(original)) return { language: original, automatic: true }
  return null
}

/** Flattens YouTube's json3 caption format to plain text plus the end of the last cue. */
export function parseJson3Captions(doc) {
  const cues = []
  let lastEndMs = 0
  for (const event of Array.isArray(doc?.events) ? doc.events : []) {
    if (!Array.isArray(event.segs)) continue
    const text = event.segs.map((seg) => seg?.utf8 ?? '').join('').replace(/\s+/g, ' ').trim()
    if (!text) continue
    cues.push(text)
    lastEndMs = Math.max(lastEndMs, (event.tStartMs ?? 0) + (event.dDurationMs ?? 0))
  }
  return { text: cues.join(' '), lastEndMs, cueCount: cues.length }
}

/** `{ usable: true }` or `{ usable: false, reason }` (German, stored in the episode error). */
export function assessCaptions({ text, lastEndMs }, durationSeconds) {
  const spoken = text.replace(/\[[^\]]*\]/g, ' ').trim()
  const words = spoken ? spoken.split(/\s+/).length : 0
  if (words < MIN_CAPTION_WORDS) {
    return { usable: false, reason: 'Untertitel leer oder nur Geräuschhinweise' }
  }

  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const durationMs = durationSeconds * 1000
    const allowedGapMs = Math.max(MAX_TRAILING_GAP_MS, durationMs * MAX_TRAILING_GAP_RATIO)
    if (durationMs - lastEndMs > allowedGapMs) {
      const covered = Math.floor(lastEndMs / 60_000)
      const total = Math.round(durationSeconds / 60)
      return { usable: false, reason: `Untertitel decken nur ${covered} von ${total} Minuten ab` }
    }
    if (words / (durationSeconds / 60) < MIN_CAPTION_WORDS_PER_MINUTE) {
      return { usable: false, reason: 'Untertitel enthalten zu wenig Text für die Videolänge' }
    }
  }
  return { usable: true }
}
