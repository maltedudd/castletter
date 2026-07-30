import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WHISPER_MAX_SIZE,
  isTooLargeForWhisper,
  buildAcceptedResponse,
  buildNoPendingResponse,
  TRANSCRIBING_LEASE_MS,
  getStaleTranscribingCutoff,
  isStaleTranscribing,
  buildClaimMarker,
  parseClaimMarker,
  isStaleTranscribingRow,
} from '../../src/lib/cron/transcribe-ack.mjs'

test('flags audio over the 25MB Whisper limit without ever suggesting truncation', () => {
  assert.equal(isTooLargeForWhisper(WHISPER_MAX_SIZE), false)
  assert.equal(isTooLargeForWhisper(WHISPER_MAX_SIZE + 1), true)
  assert.equal(isTooLargeForWhisper(15 * 1024 * 1024), false) // typical daily episode size
  assert.equal(isTooLargeForWhisper(undefined), false)
})

test('accepted response acks the claim without claiming the transcript is done', () => {
  const response = buildAcceptedResponse('episode-1')
  assert.equal(response.success, true)
  assert.equal(response.accepted, 1)
  assert.equal(response.processing, true)
  assert.equal(response.episodeId, 'episode-1')
  assert.equal(response.staleReset, 0)
  assert.equal('transcribed' in response, false)
})

test('accepted response surfaces how many stale transcribing rows were reclaimed', () => {
  const response = buildAcceptedResponse('episode-1', 2)
  assert.equal(response.staleReset, 2)
})

test('no-pending response reports zero accepted for cron-job.org', () => {
  assert.deepEqual(buildNoPendingResponse(), {
    success: true,
    accepted: 0,
    message: 'No claimable episode',
    staleReset: 0,
  })
})

test('no-pending response still reports stale resets even when nothing new was claimed', () => {
  assert.deepEqual(buildNoPendingResponse(3), {
    success: true,
    accepted: 0,
    message: 'No claimable episode',
    staleReset: 3,
  })
})

test('stale transcribing cutoff is now minus the bounded lease', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const cutoff = getStaleTranscribingCutoff(now)
  assert.equal(new Date(cutoff).getTime(), now.getTime() - TRANSCRIBING_LEASE_MS)
})

test('fresh transcribing claims are not treated as stale', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const justClaimed = new Date(now.getTime() - 1000).toISOString() // 1s ago
  assert.equal(isStaleTranscribing(justClaimed, now), false)
})

test('a transcribing row exactly at the lease boundary is not yet stale', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const atBoundary = new Date(now.getTime() - TRANSCRIBING_LEASE_MS).toISOString()
  assert.equal(isStaleTranscribing(atBoundary, now), false)
})

test('a transcribing row older than the lease is reclaimed as stale', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const orphaned = new Date(now.getTime() - TRANSCRIBING_LEASE_MS - 1).toISOString()
  assert.equal(isStaleTranscribing(orphaned, now), true)
})

// The claim marker is a machine-readable string stored in error_message (no schema
// migration) when status flips to transcribing: 'Transkription gestartet: <ISO>'.

test('buildClaimMarker embeds an ISO timestamp that parseClaimMarker recovers exactly', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const marker = buildClaimMarker(now)
  assert.equal(marker, `Transkription gestartet: ${now.toISOString()}`)
  assert.equal(parseClaimMarker(marker), now.toISOString())
})

test('parseClaimMarker returns null for missing, empty, or unrelated error messages', () => {
  assert.equal(parseClaimMarker(null), null)
  assert.equal(parseClaimMarker(undefined), null)
  assert.equal(parseClaimMarker(''), null)
  assert.equal(parseClaimMarker('Temporärer Fehler: network timeout'), null)
})

test('parseClaimMarker returns null for a marker with an unparsable timestamp', () => {
  assert.equal(parseClaimMarker('Transkription gestartet: not-a-date'), null)
})

// isStaleTranscribingRow decides per-row whether a recent `transcribing` episode should be
// reclaimed. A marked claim is judged purely by its own marker — never by the episode's
// created_at — so a fresh claim on an old-but-still-recent episode is never falsely reset
// out from under a concurrent Whisper job. Only rows with no parseable marker (claimed
// before this marker existed) fall back to created_at for one-time legacy recovery.

test('a marked fresh claim is not stale, even though the episode itself is old', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const oldEpisodeCreatedAt = new Date(now.getTime() - 40 * 60 * 60 * 1000).toISOString() // 40h old, still within the 48h recent window
  const errorMessage = buildClaimMarker(new Date(now.getTime() - 1000)) // claimed 1s ago
  assert.equal(isStaleTranscribingRow({ errorMessage, createdAt: oldEpisodeCreatedAt }, now), false)
})

test('a marked stale claim is reclaimed, even though the episode itself was just created', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const brandNewEpisodeCreatedAt = now.toISOString()
  const errorMessage = buildClaimMarker(new Date(now.getTime() - TRANSCRIBING_LEASE_MS - 1))
  assert.equal(isStaleTranscribingRow({ errorMessage, createdAt: brandNewEpisodeCreatedAt }, now), true)
})

test('a legacy row with no marker falls back to created_at and is reclaimed once it is stale', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const staleCreatedAt = new Date(now.getTime() - TRANSCRIBING_LEASE_MS - 1).toISOString()
  assert.equal(isStaleTranscribingRow({ errorMessage: null, createdAt: staleCreatedAt }, now), true)
  assert.equal(
    isStaleTranscribingRow({ errorMessage: 'some unrelated old error', createdAt: staleCreatedAt }, now),
    true
  )
})

test('a legacy row with no marker is not reclaimed while created_at is still fresh', () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const freshCreatedAt = new Date(now.getTime() - 1000).toISOString()
  assert.equal(isStaleTranscribingRow({ errorMessage: undefined, createdAt: freshCreatedAt }, now), false)
})
