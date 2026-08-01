// Pure helpers for the fast-ack / background-transcription flow. Kept dependency-free
// so they can be exercised with node:test without spinning up Supabase/OpenAI/Next.

export const OPENAI_TRANSCRIPTION_MAX_SIZE = 25 * 1024 * 1024 // 25 MB — OpenAI audio transcription upload limit
export const TRANSCRIPTION_CHUNK_TARGET_SIZE = 20 * 1024 * 1024 // keep multipart requests safely below 25 MB

/** OpenAI's file transcription endpoint has a hard 25MB request limit. */
export function isTooLargeForSingleTranscriptionUpload(sizeBytes) {
  return typeof sizeBytes === 'number' && sizeBytes > OPENAI_TRANSCRIPTION_MAX_SIZE
}

/** Builds ordered inclusive byte ranges that each fit below the transcription upload limit. */
export function buildAudioChunkRanges(totalBytes, chunkSize = TRANSCRIPTION_CHUNK_TARGET_SIZE) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('Ungültige Audio-Größe: Content-Length fehlt oder ist 0')
  }
  if (!Number.isFinite(chunkSize) || chunkSize <= 0 || chunkSize > OPENAI_TRANSCRIPTION_MAX_SIZE) {
    throw new Error('Ungültige Chunk-Größe für OpenAI-Transkription')
  }

  const total = Math.ceil(totalBytes / chunkSize)
  return Array.from({ length: total }, (_, index) => {
    const start = index * chunkSize
    const end = Math.min(totalBytes - 1, start + chunkSize - 1)
    return { start, end, index, total }
  })
}

/** Joins chunk transcripts without claiming empty chunk output is meaningful text. */
export function joinTranscriptChunks(chunks) {
  return chunks
    .map((chunk) => (typeof chunk === 'string' ? chunk.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
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

/**
 * Groups stale rows by the exact `error_message` marker read at select time, so the reset
 * can run as a true compare-and-swap per group instead of a single id+status batch update.
 *
 * Why this matters: two overlapping cron runs can both select the same orphaned row before
 * either writes. If run A resets it and immediately reclaims it with a fresh marker, an
 * id+status-only update from run B still matches — status is 'transcribing' again — and
 * wipes out A's fresh claim out from under its in-flight Whisper job (ABA race: both runs
 * read the same old marker, A swaps it for a new one, B's write lands anyway because it
 * never checked the marker had changed). Pinning `error_message = <that exact marker>`
 * (`IS NULL` for legacy unmarked rows) in the WHERE clause closes that window: once A's
 * write changes the marker, B's compare-and-swap simply no longer matches.
 */
export function groupStaleRowsForReset(rows) {
  const groups = []
  for (const { id, errorMessage } of rows) {
    const marker = errorMessage ?? null
    let group = groups.find((g) => g.errorMessage === marker)
    if (!group) {
      group = { errorMessage: marker, ids: [] }
      groups.push(group)
    }
    group.ids.push(id)
  }
  return groups
}

/**
 * Executes the stale-reset compare-and-swap described above against a Supabase-style query
 * builder (`from().update().in().eq().is().select()`). Takes the client as a parameter
 * rather than importing one so it can be exercised against a fake in tests without a real
 * database.
 */
export async function resetStaleTranscribingRows(supabase, staleRows, resetMessage) {
  let staleReset = 0
  for (const group of groupStaleRowsForReset(staleRows)) {
    let query = supabase
      .from('episodes')
      .update({ status: 'pending_transcription', error_message: resetMessage })
      .in('id', group.ids)
      .eq('status', 'transcribing')

    query = group.errorMessage === null
      ? query.is('error_message', null)
      : query.eq('error_message', group.errorMessage)

    const { data, error } = await query.select('id')
    if (error) {
      return { staleReset, error }
    }
    staleReset += data?.length ?? 0
  }
  return { staleReset, error: null }
}
