import assert from 'node:assert/strict'
import test from 'node:test'
import { runFeedCheck, createIntervalGate } from '../../worker/feed-jobs.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T10:00:00.000Z')

test('runFeedCheck imports new episodes and logs a summary', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{ id: 'sub-1', feed_url: 'https://feeds.example/a.xml', title: 'A', created_at: '2026-09-01T00:00:00.000Z' }],
    episodes: [],
    feed_check_logs: [],
  })
  const logs = []

  const summary = await runFeedCheck({
    supabase: db,
    now: () => NOW,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<rss/>' }),
    parseXml: async () => ({
      items: [{ guid: 'g1', title: 'Neu', pubDate: 'Sat, 03 Oct 2026 06:00:00 GMT', enclosure: { url: 'https://cdn.example/g1.mp3' } }],
    }),
  })

  assert.deepEqual(summary, { subscriptionsChecked: 1, newEpisodes: 1, errors: 0 })
  assert.equal(db.data.episodes[0].status, 'pending_transcription')
  assert.deepEqual(logs, [{ level: 'info', msg: 'feed_check', subscriptionsChecked: 1, newEpisodes: 1, errors: 0 }])
})

test('interval gate is due on start, then only after the interval since the last success', () => {
  const gate = createIntervalGate(30 * 60 * 1000)
  const at = (min) => new Date(NOW.getTime() + min * 60 * 1000)

  assert.equal(gate.isDue(at(0)), true)
  // Failed run: not marked, still due.
  assert.equal(gate.isDue(at(1)), true)
  gate.markDone(at(1))
  assert.equal(gate.isDue(at(30)), false)
  assert.equal(gate.isDue(at(31)), true)
})
