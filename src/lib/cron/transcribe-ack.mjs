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
 */
export function buildAcceptedResponse(episodeId) {
  return {
    success: true,
    accepted: 1,
    processing: true,
    message: 'Transcription accepted',
    episodeId,
  }
}

/** Response when there was nothing to claim, or another cron run already claimed it. */
export function buildNoPendingResponse() {
  return {
    success: true,
    accepted: 0,
    message: 'No claimable episode',
  }
}
