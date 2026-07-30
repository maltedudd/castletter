// Pure helpers for the fast-ack / background-transcription flow. Kept dependency-free
// so they can be exercised with node:test without spinning up Supabase/OpenAI/Next.

export const WHISPER_MAX_SIZE = 25 * 1024 * 1024 // 25 MB — actual OpenAI Whisper API limit

/**
 * Whisper has a hard 25MB request limit. We never truncate audio to fit it (PR #3's
 * approach); instead we refuse honestly so a human can decide on chunking later.
 */
export function isTooLargeForWhisper(sizeBytes) {
  return typeof sizeBytes === 'number' && sizeBytes > WHISPER_MAX_SIZE
}

/**
 * Response for cron-job.org once an episode has been claimed (status flipped to
 * `transcribing`) but before the background transcription has actually finished.
 * `staleReset` surfaces how many orphaned `transcribing` rows this run reclaimed,
 * for scheduler/debug visibility.
 */
export function buildAcceptedResponse(episodeId, staleReset = 0) {
  return {
    success: true,
    accepted: 1,
    processing: true,
    message: 'Transcription accepted',
    episodeId,
    staleReset,
  }
}

/** Response when there was nothing to claim, or another cron run already claimed it. */
export function buildNoPendingResponse(staleReset = 0) {
  return {
    success: true,
    accepted: 0,
    message: 'No claimable episode',
    staleReset,
  }
}

// A `transcribing` row is only ever written by this route right before it starts the
// background after() work (fetch + Whisper), which itself is bounded by maxDuration=60s
// plus a 45s download timeout. A row still `transcribing` well past that has to mean the
// function died mid-flight (crash, redeploy, OOM) — not that work is still in progress.
export const TRANSCRIBING_LEASE_MS = 15 * 60 * 1000 // 15 minutes

/** Episodes claimed before this cutoff are safe to reset back to pending_transcription. */
export function getStaleTranscribingCutoff(now = new Date()) {
  return new Date(now.getTime() - TRANSCRIBING_LEASE_MS).toISOString()
}

/**
 * `timestamp` must be the actual claim time (the marker recovered by `parseClaimMarker`,
 * or — only for legacy rows with no marker — the episode's `created_at`). Never pass
 * `created_at` for a marked row: that's when the episode was first detected, not when this
 * claim began, and using it would make any older-but-still-recent episode look instantly
 * stale the moment it's legitimately (re-)claimed.
 */
export function isStaleTranscribing(timestamp, now = new Date()) {
  return new Date(timestamp).getTime() < new Date(getStaleTranscribingCutoff(now)).getTime()
}

// Machine-readable claim marker stored in `error_message` when status flips to
// `transcribing` — no schema migration needed, since `episodes` has no dedicated claim
// timestamp column.
export const CLAIM_MARKER_PREFIX = 'Transkription gestartet: '

/** Builds the claim marker to store in `error_message` at claim time. */
export function buildClaimMarker(now = new Date()) {
  return `${CLAIM_MARKER_PREFIX}${now.toISOString()}`
}

/** Recovers the claim timestamp from `error_message`, or null if absent/unparsable. */
export function parseClaimMarker(errorMessage) {
  if (typeof errorMessage !== 'string' || !errorMessage.startsWith(CLAIM_MARKER_PREFIX)) {
    return null
  }
  const iso = errorMessage.slice(CLAIM_MARKER_PREFIX.length).trim()
  return Number.isNaN(new Date(iso).getTime()) ? null : iso
}

/**
 * Decides whether a recent `transcribing` row should be reclaimed. A marked claim is
 * judged purely by its own marker — never by `createdAt` — so a fresh claim on an
 * old-but-still-recent episode is never falsely reset out from under a concurrent Whisper
 * job. Only rows with no parseable marker (claimed before this marker existed) fall back
 * to `createdAt` for one-time legacy recovery.
 */
export function isStaleTranscribingRow({ errorMessage, createdAt }, now = new Date()) {
  const marker = parseClaimMarker(errorMessage)
  if (marker != null) {
    return isStaleTranscribing(marker, now)
  }
  return isStaleTranscribing(createdAt, now)
}
