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
  groupStaleRowsForReset,
  resetStaleTranscribingRows,
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

// groupStaleRowsForReset / resetStaleTranscribingRows implement the reset as a
// compare-and-swap: the update's WHERE clause must pin the exact error_message marker that
// was read when a row was judged stale, not just id+status. Without that, two overlapping
// cron runs that both read the same stale marker can race — run A resets and reclaims with
// a fresh marker, then run B's id+status-only update still matches (status is 'transcribing'
// again) and wipes out A's fresh claim (ABA race).

test('groupStaleRowsForReset groups ids sharing the exact same marker together', () => {
  const rows = [
    { id: 'ep-1', errorMessage: 'Transkription gestartet: 2026-07-30T10:00:00.000Z' },
    { id: 'ep-2', errorMessage: 'Transkription gestartet: 2026-07-30T10:00:00.000Z' },
    { id: 'ep-3', errorMessage: 'Transkription gestartet: 2026-07-30T09:00:00.000Z' },
  ]
  const groups = groupStaleRowsForReset(rows)
  assert.equal(groups.length, 2)
  const byMarker = new Map(groups.map((g) => [g.errorMessage, g.ids]))
  assert.deepEqual(byMarker.get('Transkription gestartet: 2026-07-30T10:00:00.000Z'), ['ep-1', 'ep-2'])
  assert.deepEqual(byMarker.get('Transkription gestartet: 2026-07-30T09:00:00.000Z'), ['ep-3'])
})

test('groupStaleRowsForReset puts legacy null-marker rows in their own group', () => {
  const rows = [
    { id: 'ep-1', errorMessage: null },
    { id: 'ep-2', errorMessage: undefined },
    { id: 'ep-3', errorMessage: 'Transkription gestartet: 2026-07-30T09:00:00.000Z' },
  ]
  const groups = groupStaleRowsForReset(rows)
  assert.equal(groups.length, 2)
  const nullGroup = groups.find((g) => g.errorMessage === null)
  assert.deepEqual(nullGroup.ids.sort(), ['ep-1', 'ep-2'])
})

/**
 * Minimal in-memory stand-in for the subset of the Supabase query builder that
 * resetStaleTranscribingRows() actually uses (from/update/in/eq/is/select), so the ABA
 * race can be reproduced deterministically without a real database. Filters accumulate and
 * are applied on `.select()`, mirroring the real client's "await the built query" shape.
 */
function makeFakeEpisodesTable(initialRows) {
  const rows = initialRows.map((row) => ({ ...row }))
  return {
    rows,
    from() {
      return {
        update(patch) {
          const filters = []
          const builder = {
            eq(column, value) {
              filters.push((row) => row[column] === value)
              return builder
            },
            in(column, values) {
              filters.push((row) => values.includes(row[column]))
              return builder
            },
            is(column, value) {
              filters.push((row) => row[column] === value)
              return builder
            },
            async select() {
              const matched = rows.filter((row) => filters.every((matches) => matches(row)))
              for (const row of matched) Object.assign(row, patch)
              return { data: matched.map((row) => ({ id: row.id })), error: null }
            },
          }
          return builder
        },
      }
    },
  }
}

test('resetStaleTranscribingRows never resurrects a concurrent run\'s fresh claim (ABA race)', async () => {
  const now = new Date('2026-07-30T12:00:00.000Z')
  const staleMarker = buildClaimMarker(new Date(now.getTime() - TRANSCRIBING_LEASE_MS - 1))

  const table = makeFakeEpisodesTable([
    { id: 'ep-1', status: 'transcribing', error_message: staleMarker },
  ])

  // Both run A and run B read the same stale snapshot before either writes.
  const staleRowsReadByA = [{ id: 'ep-1', errorMessage: staleMarker }]
  const staleRowsReadByB = [{ id: 'ep-1', errorMessage: staleMarker }]
  const resetMessage = 'Automatischer Reset: Transkriptions-Lease abgelaufen (verwaiste transcribing-Episode)'

  // Run A resets ep-1, then immediately reclaims it with a fresh marker.
  const resultA = await resetStaleTranscribingRows(table, staleRowsReadByA, resetMessage)
  assert.equal(resultA.staleReset, 1)
  assert.equal(resultA.error, null)

  const freshMarker = buildClaimMarker(now)
  table.rows[0].status = 'transcribing'
  table.rows[0].error_message = freshMarker

  // Run B, unaware A already reclaimed it, applies its own reset built from the stale
  // snapshot it read earlier. The CAS on error_message must stop this from matching.
  const resultB = await resetStaleTranscribingRows(table, staleRowsReadByB, resetMessage)
  assert.equal(resultB.staleReset, 0)
  assert.equal(resultB.error, null)

  // A's fresh claim must survive untouched.
  assert.equal(table.rows[0].status, 'transcribing')
  assert.equal(table.rows[0].error_message, freshMarker)
})

test('resetStaleTranscribingRows resets a legacy null-marker row using IS NULL, not id+status alone', async () => {
  const table = makeFakeEpisodesTable([{ id: 'ep-1', status: 'transcribing', error_message: null }])
  const resetMessage = 'Automatischer Reset: Transkriptions-Lease abgelaufen (verwaiste transcribing-Episode)'

  const result = await resetStaleTranscribingRows(table, [{ id: 'ep-1', errorMessage: null }], resetMessage)

  assert.equal(result.staleReset, 1)
  assert.equal(table.rows[0].status, 'pending_transcription')
  assert.equal(table.rows[0].error_message, resetMessage)
})

test('resetStaleTranscribingRows surfaces the first update error without throwing', async () => {
  const failingClient = {
    from() {
      return {
        update() {
          return {
            in() {
              return this
            },
            eq() {
              return this
            },
            is() {
              return this
            },
            async select() {
              return { data: null, error: { message: 'boom' } }
            },
          }
        },
      }
    },
  }

  const result = await resetStaleTranscribingRows(
    failingClient,
    [{ id: 'ep-1', errorMessage: null }],
    'Automatischer Reset'
  )
  assert.equal(result.staleReset, 0)
  assert.equal(result.error.message, 'boom')
})
