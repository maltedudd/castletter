// One polling iteration of the transcription worker. Everything with side effects
// (Supabase client, audio transcription, clock, logger) is injected so the claim/lease
// logic can be tested against an in-memory table.

import {
  buildClaimMarker,
  isStaleTranscribingRow,
  resetStaleTranscribingRows,
} from '../src/lib/cron/transcribe-ack.mjs'
import { PermanentError } from '../src/lib/transcription/audio-transcriber.mjs'

export const STALE_RESET_MESSAGE =
  'Automatischer Reset: Transkriptions-Lease abgelaufen (verwaiste transcribing-Episode)'
export const RELEASE_MESSAGE = 'Worker gestoppt – Episode wird erneut versucht'

const CANDIDATE_COLUMNS =
  'id, audio_url, title, transcript, transcription_attempts, error_message, source_type, youtube_video_id'

/** Thrown when another run took over the episode; the worker must then write nothing. */
export class LeaseLostError extends Error {
  constructor(episodeId) {
    super(`Lease für Episode ${episodeId} verloren – Ergebnis wird verworfen`)
    this.name = 'LeaseLostError'
  }
}

export function getEpisodeAgeCutoff(now, maxEpisodeAgeDays) {
  return new Date(now.getTime() - maxEpisodeAgeDays * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Runs one iteration: reset stale claims, pick the oldest pending episode inside the age
 * cutoff, claim it and transcribe it completely. Returns `{ worked }` so the caller can
 * immediately poll again while there is a backlog.
 *
 * `state.active` holds the in-flight claim (id, marker, attempts) so a shutdown handler
 * can release it.
 */
export async function runOnce(deps, state = {}) {
  const { supabase, config, now, log } = deps
  const cutoff = getEpisodeAgeCutoff(now(), config.maxEpisodeAgeDays)

  const staleReset = await resetStaleClaims(deps, cutoff)
  if (staleReset > 0) log('info', 'stale_claims_reset', { count: staleReset })

  const { data: candidates, error } = await supabase
    .from('episodes')
    .select(CANDIDATE_COLUMNS)
    .eq('status', 'pending_transcription')
    .gte('published_at', cutoff)
    .order('published_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`Episoden konnten nicht gelesen werden: ${error.message}`)

  const candidate = candidates?.[0]
  if (!candidate) return { worked: false, outcome: 'idle' }

  const claim = await claimEpisode(deps, candidate)
  if (claim.outcome !== 'claimed') {
    log('info', `episode_${claim.outcome}`, { episodeId: candidate.id })
    return { worked: true, outcome: claim.outcome }
  }

  state.active = claim.active
  try {
    const outcome = await processClaimedEpisode(deps, candidate, claim.active)
    return { worked: true, outcome }
  } finally {
    state.active = null
  }
}

async function resetStaleClaims({ supabase, now }, cutoff) {
  const { data: rows, error } = await supabase
    .from('episodes')
    .select('id, created_at, error_message')
    .eq('status', 'transcribing')
    .gte('published_at', cutoff)
  if (error) throw new Error(`transcribing-Episoden konnten nicht gelesen werden: ${error.message}`)

  const staleRows = (rows ?? [])
    .filter((row) => isStaleTranscribingRow({ errorMessage: row.error_message, createdAt: row.created_at }, now()))
    .map((row) => ({ id: row.id, errorMessage: row.error_message }))
  if (staleRows.length === 0) return 0

  const { staleReset, error: resetError } = await resetStaleTranscribingRows(supabase, staleRows, STALE_RESET_MESSAGE)
  if (resetError) throw new Error(`Stale-Reset fehlgeschlagen: ${resetError.message}`)
  return staleReset
}

/**
 * Claims with a compare-and-swap on status and attempt count, so overlapping runs (or the
 * legacy Vercel route) never process the same episode twice. Episodes that already used
 * all attempts are marked `failed` instead of being retried forever.
 */
async function claimEpisode({ supabase, config, now }, candidate) {
  const attempts = candidate.transcription_attempts ?? 0

  if (attempts >= config.maxAttempts) {
    const { data, error } = await supabase
      .from('episodes')
      .update({
        status: 'failed',
        error_message: `Abgebrochen nach ${attempts} Versuchen. Letzter Fehler: ${candidate.error_message ?? 'unbekannt'}`,
      })
      .eq('id', candidate.id)
      .eq('status', 'pending_transcription')
      .eq('transcription_attempts', attempts)
      .select('id')
    if (error) throw new Error(`Episode konnte nicht als failed markiert werden: ${error.message}`)
    return { outcome: data?.length ? 'gave_up' : 'lost_race' }
  }

  const marker = buildClaimMarker(now())
  const { data, error } = await supabase
    .from('episodes')
    .update({ status: 'transcribing', error_message: marker, transcription_attempts: attempts + 1 })
    .eq('id', candidate.id)
    .eq('status', 'pending_transcription')
    .eq('transcription_attempts', attempts)
    .select('id')
  if (error) throw new Error(`Episode konnte nicht beansprucht werden: ${error.message}`)
  if (!data?.length) return { outcome: 'lost_race' }

  return { outcome: 'claimed', active: { id: candidate.id, marker, attempt: attempts + 1 } }
}

async function processClaimedEpisode(deps, episode, active) {
  const { supabase, config, log, transcribeEpisodeAudio } = deps
  const startedAt = Date.now()
  log('info', 'episode_claimed', { episodeId: episode.id, title: episode.title, attempt: active.attempt })

  const isYouTube = episode.source_type === 'youtube'
  try {
    let transcript = episode.transcript
    let transcriptSource = null
    let captionsReason
    if (!transcript || transcript.trim().length === 0) {
      const result = await transcribeEpisodeAudio(
        episode,
        async ({ index, total }) => {
          await refreshLease(deps, active)
          log('info', 'chunk_transcribed', { episodeId: episode.id, chunk: index + 1, total })
        },
        // Keep-alive between long non-chunk stages (YouTube metadata/caption/audio download).
        () => refreshLease(deps, active)
      )
      // Podcast transcribers return the text, YouTube ones `{ transcript, source }`.
      transcript = typeof result === 'string' ? result : result?.transcript
      transcriptSource = typeof result === 'string' ? null : result?.source ?? null
      captionsReason = typeof result === 'string' ? undefined : result?.captionsReason
    }
    if (typeof transcript !== 'string' || transcript.trim().length === 0) {
      throw new PermanentError('Transkription lieferte keinen Text')
    }

    // Single final write, only for the complete joined transcript and only while we
    // still hold the lease.
    const saved = await casUpdate(supabase, active, {
      status: 'transcribed',
      transcript,
      error_message: null,
      ...(isYouTube ? { error_code: null, transcript_source: transcriptSource } : {}),
    })
    if (!saved) throw new LeaseLostError(episode.id)

    log('info', 'episode_transcribed', {
      episodeId: episode.id,
      chars: transcript.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(isYouTube ? { source: transcriptSource, captionsReason } : {}),
    })
    return 'transcribed'
  } catch (err) {
    if (err instanceof LeaseLostError) {
      log('warn', 'lease_lost', { episodeId: episode.id })
      return 'lease_lost'
    }

    const message = err instanceof Error ? err.message : String(err)
    // YouTube failures carry a machine-readable reason that the admin UI shows.
    const errorCode = isYouTube ? { error_code: typeof err?.code === 'string' ? err.code : 'transcription_failed' } : {}
    if (err instanceof PermanentError) {
      await casUpdate(supabase, active, { status: 'failed', error_message: message, ...errorCode })
      log('error', 'episode_failed', { episodeId: episode.id, error: message, ...errorCode })
      return 'failed'
    }

    await casUpdate(supabase, active, {
      status: 'pending_transcription',
      error_message: `Temporärer Fehler (Versuch ${active.attempt}/${config.maxAttempts}): ${message}`,
      ...errorCode,
    })
    log('warn', 'episode_retry_later', { episodeId: episode.id, attempt: active.attempt, error: message, ...errorCode })
    return 'retry_later'
  }
}

/**
 * Moves the claim marker forward after each chunk so long episodes never look stale to
 * the 15-minute lease check (ours or the legacy Vercel route's).
 */
async function refreshLease({ supabase, now }, active) {
  const marker = buildClaimMarker(now())
  if (marker === active.marker) return
  const ok = await casUpdate(supabase, active, { error_message: marker })
  if (!ok) throw new LeaseLostError(active.id)
  active.marker = marker
}

/** Hands an in-flight episode back to the queue on shutdown, without counting the attempt. */
export async function releaseClaim({ supabase }, active) {
  return casUpdate(supabase, active, {
    status: 'pending_transcription',
    error_message: RELEASE_MESSAGE,
    transcription_attempts: Math.max(0, active.attempt - 1),
  })
}

/** Update guarded by id + status + our exact claim marker. Returns whether it matched. */
async function casUpdate(supabase, active, patch) {
  const { data, error } = await supabase
    .from('episodes')
    .update(patch)
    .eq('id', active.id)
    .eq('status', 'transcribing')
    .eq('error_message', active.marker)
    .select('id')
  if (error) throw new Error(`Episode ${active.id} konnte nicht aktualisiert werden: ${error.message}`)
  return (data?.length ?? 0) > 0
}
