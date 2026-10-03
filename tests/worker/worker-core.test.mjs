import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runOnce,
  releaseClaim,
  getEpisodeAgeCutoff,
  STALE_RESET_MESSAGE,
  RELEASE_MESSAGE,
} from '../../worker/worker-core.mjs'
import { buildClaimMarker, TRANSCRIBING_LEASE_MS } from '../../src/lib/cron/transcribe-ack.mjs'
import { PermanentError } from '../../src/lib/transcription/audio-transcriber.mjs'

const NOW = new Date('2026-10-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const CONFIG = { maxEpisodeAgeDays: 7, maxAttempts: 3 }

/**
 * In-memory stand-in for the subset of the Supabase query builder the worker uses:
 * select/update with eq/gte/in/is/order/limit, awaited directly or via `.select()`.
 * `beforeUpdate` lets a test simulate a concurrent writer between read and write.
 */
function makeTable(initialRows, { beforeUpdate } = {}) {
  const rows = initialRows.map((row) => ({ transcription_attempts: 0, error_message: null, transcript: null, ...row }))
  const updates = []

  function builder(kind, patch) {
    const filters = []
    let order = null
    let limit = Infinity
    const run = () => {
      if (kind === 'update' && beforeUpdate) beforeUpdate(rows, patch)
      let matched = rows.filter((row) => filters.every((f) => f(row)))
      if (kind === 'update') {
        for (const row of matched) Object.assign(row, patch)
        updates.push({ patch, matched: matched.map((r) => r.id) })
        return { data: matched.map((r) => ({ id: r.id })), error: null }
      }
      if (order) {
        matched = [...matched].sort((a, b) =>
          order.ascending ? a[order.column].localeCompare(b[order.column]) : b[order.column].localeCompare(a[order.column])
        )
      }
      return { data: matched.slice(0, limit).map((r) => ({ ...r })), error: null }
    }
    const b = {
      eq(column, value) { filters.push((row) => row[column] === value); return b },
      gte(column, value) { filters.push((row) => row[column] >= value); return b },
      in(column, values) { filters.push((row) => values.includes(row[column])); return b },
      is(column, value) { filters.push((row) => row[column] === value); return b },
      order(column, { ascending }) { order = { column, ascending }; return b },
      limit(n) { limit = n; return b },
      select() { return Promise.resolve(run()) },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return b
  }

  return {
    rows,
    updates,
    from() {
      return {
        select: () => builder('select'),
        update: (patch) => builder('update', patch),
      }
    },
  }
}

function makeDeps(table, overrides = {}) {
  const logs = []
  return {
    logs,
    supabase: table,
    config: CONFIG,
    now: () => NOW,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    transcribeEpisodeAudio: async () => 'volles transkript',
    ...overrides,
  }
}

const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString()

test('idle when nothing is pending inside the age cutoff', async () => {
  const table = makeTable([
    { id: 'old', status: 'pending_transcription', published_at: daysAgo(30) },
    { id: 'done', status: 'transcribed', published_at: daysAgo(1) },
  ])

  const result = await runOnce(makeDeps(table))

  assert.deepEqual(result, { worked: false, outcome: 'idle' })
  assert.equal(table.updates.length, 0)
})

test('picks the oldest pending episode inside the cutoff and stores the full transcript', async () => {
  const table = makeTable([
    { id: 'newer', status: 'pending_transcription', published_at: daysAgo(1) },
    { id: 'older', status: 'pending_transcription', published_at: daysAgo(5) },
    { id: 'too-old', status: 'pending_transcription', published_at: daysAgo(8) },
  ])
  const seen = []
  const deps = makeDeps(table, {
    transcribeEpisodeAudio: async (episode) => {
      seen.push(episode.id)
      const row = table.rows.find((r) => r.id === episode.id)
      assert.equal(row.status, 'transcribing', 'episode is claimed before transcription starts')
      return 'volles transkript'
    },
  })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'transcribed' })
  assert.deepEqual(seen, ['older'])
  const older = table.rows.find((r) => r.id === 'older')
  assert.equal(older.status, 'transcribed')
  assert.equal(older.transcript, 'volles transkript')
  assert.equal(older.error_message, null)
  assert.equal(older.transcription_attempts, 1)
  assert.equal(table.rows.find((r) => r.id === 'too-old').status, 'pending_transcription')
})

test('a lost claim race does nothing (no transcription, no writes to the row)', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1) }], {
    // Another worker / the legacy route claims the row between our read and our write.
    beforeUpdate: (rows) => {
      if (rows[0].status === 'pending_transcription') {
        rows[0].status = 'transcribing'
        rows[0].error_message = 'Transkription gestartet: other'
      }
    },
  })
  let transcribed = false
  const deps = makeDeps(table, { transcribeEpisodeAudio: async () => { transcribed = true; return 'x' } })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'lost_race' })
  assert.equal(transcribed, false)
  assert.equal(table.rows[0].error_message, 'Transkription gestartet: other')
})

test('an episode that used all attempts is marked failed with its last error', async () => {
  const table = makeTable([{
    id: 'ep',
    status: 'pending_transcription',
    published_at: daysAgo(1),
    transcription_attempts: 3,
    error_message: 'Temporärer Fehler (Versuch 3/3): 502',
  }])
  let transcribed = false
  const deps = makeDeps(table, { transcribeEpisodeAudio: async () => { transcribed = true; return 'x' } })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'gave_up' })
  assert.equal(transcribed, false)
  assert.equal(table.rows[0].status, 'failed')
  assert.equal(table.rows[0].error_message, 'Abgebrochen nach 3 Versuchen. Letzter Fehler: Temporärer Fehler (Versuch 3/3): 502')
})

test('temporary errors return the episode to the queue with the attempt count', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1), transcription_attempts: 1 }])
  const deps = makeDeps(table, { transcribeEpisodeAudio: async () => { throw new Error('429 rate limited') } })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'retry_later' })
  assert.equal(table.rows[0].status, 'pending_transcription')
  assert.equal(table.rows[0].transcript, null)
  assert.equal(table.rows[0].transcription_attempts, 2)
  assert.equal(table.rows[0].error_message, 'Temporärer Fehler (Versuch 2/3): 429 rate limited')
})

test('permanent errors mark the episode failed immediately', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1) }])
  const deps = makeDeps(table, {
    transcribeEpisodeAudio: async () => { throw new PermanentError('Audio nicht erreichbar (HTTP 404)') },
  })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'failed' })
  assert.equal(table.rows[0].status, 'failed')
  assert.equal(table.rows[0].error_message, 'Audio nicht erreichbar (HTTP 404)')
})

test('each finished chunk refreshes the lease marker so long episodes never look stale', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1) }])
  let clock = NOW.getTime()
  const markers = []
  const deps = makeDeps(table, {
    now: () => new Date(clock),
    transcribeEpisodeAudio: async (_episode, onChunkTranscribed) => {
      for (let index = 0; index < 3; index++) {
        clock += 10 * 60 * 1000 // 10 min per chunk: 30 min total, twice the lease
        await onChunkTranscribed({ index, total: 3 })
        markers.push(table.rows[0].error_message)
      }
      return 'a\n\nb\n\nc'
    },
  })

  const result = await runOnce(deps)

  assert.equal(result.outcome, 'transcribed')
  assert.deepEqual(markers, [
    buildClaimMarker(new Date(NOW.getTime() + 10 * 60 * 1000)),
    buildClaimMarker(new Date(NOW.getTime() + 20 * 60 * 1000)),
    buildClaimMarker(new Date(NOW.getTime() + 30 * 60 * 1000)),
  ])
  assert.equal(table.rows[0].transcript, 'a\n\nb\n\nc')
})

test('a lost lease mid-episode aborts and writes nothing over the new owner', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1) }])
  let chunksAfterLoss = 0
  const deps = makeDeps(table, {
    now: (() => { let t = NOW.getTime(); return () => new Date((t += 1000)) })(),
    transcribeEpisodeAudio: async (_episode, onChunkTranscribed) => {
      // Someone reset and re-claimed the row while chunk 1 was running.
      table.rows[0].error_message = 'Transkription gestartet: someone-else'
      await onChunkTranscribed({ index: 0, total: 2 })
      chunksAfterLoss++
      return 'nie gespeichert'
    },
  })

  const result = await runOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'lease_lost' })
  assert.equal(chunksAfterLoss, 0)
  assert.equal(table.rows[0].status, 'transcribing')
  assert.equal(table.rows[0].error_message, 'Transkription gestartet: someone-else')
  assert.equal(table.rows[0].transcript, null)
})

test('an existing transcript is promoted without calling the transcription API', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1), transcript: 'schon da' }])
  let called = false
  const deps = makeDeps(table, { transcribeEpisodeAudio: async () => { called = true; return 'x' } })

  const result = await runOnce(deps)

  assert.equal(result.outcome, 'transcribed')
  assert.equal(called, false)
  assert.equal(table.rows[0].transcript, 'schon da')
})

test('stale claims inside the cutoff are reset (not only the last 48h), fresh ones are kept', async () => {
  const staleMarker = buildClaimMarker(new Date(NOW.getTime() - TRANSCRIBING_LEASE_MS - 1000))
  const freshMarker = buildClaimMarker(new Date(NOW.getTime() - 60 * 1000))
  const table = makeTable([
    { id: 'stale', status: 'transcribing', published_at: daysAgo(5), error_message: staleMarker, created_at: daysAgo(5) },
    { id: 'fresh', status: 'transcribing', published_at: daysAgo(5), error_message: freshMarker, created_at: daysAgo(5) },
    { id: 'outside', status: 'transcribing', published_at: daysAgo(20), error_message: staleMarker, created_at: daysAgo(20) },
  ])
  const deps = makeDeps(table, { transcribeEpisodeAudio: async () => 'transkript' })

  await runOnce(deps)

  const byId = Object.fromEntries(table.rows.map((r) => [r.id, r]))
  // The reset episode is then immediately picked up again in the same iteration.
  assert.equal(byId.stale.status, 'transcribed')
  assert.equal(byId.fresh.status, 'transcribing')
  assert.equal(byId.fresh.error_message, freshMarker)
  assert.equal(byId.outside.status, 'transcribing')
  assert.ok(deps.logs.some((l) => l.msg === 'stale_claims_reset' && l.count === 1))
  assert.ok(table.updates.some((u) => u.patch.error_message === STALE_RESET_MESSAGE))
})

test('state.active exposes the in-flight claim and is cleared afterwards', async () => {
  const table = makeTable([{ id: 'ep', status: 'pending_transcription', published_at: daysAgo(1) }])
  const state = {}
  let activeDuringRun = null
  const deps = makeDeps(table, {
    transcribeEpisodeAudio: async () => { activeDuringRun = { ...state.active }; return 'x' },
  })

  await runOnce(deps, state)

  assert.equal(activeDuringRun.id, 'ep')
  assert.equal(activeDuringRun.attempt, 1)
  assert.match(activeDuringRun.marker, /^Transkription gestartet: /)
  assert.equal(state.active, null)
})

test('releaseClaim returns the episode to the queue without counting the attempt', async () => {
  const marker = buildClaimMarker(NOW)
  const table = makeTable([{ id: 'ep', status: 'transcribing', published_at: daysAgo(1), error_message: marker, transcription_attempts: 2 }])

  const released = await releaseClaim({ supabase: table }, { id: 'ep', marker, attempt: 2 })

  assert.equal(released, true)
  assert.equal(table.rows[0].status, 'pending_transcription')
  assert.equal(table.rows[0].error_message, RELEASE_MESSAGE)
  assert.equal(table.rows[0].transcription_attempts, 1)
})

test('getEpisodeAgeCutoff subtracts whole days', () => {
  assert.equal(getEpisodeAgeCutoff(NOW, 7), '2026-09-26T12:00:00.000Z')
})
