import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_NEW_EPISODES_PER_FEED,
  checkAllFeeds,
  selectNewEpisodes,
  generateGuid,
  parseDuration,
} from '../../src/lib/feeds/check-feeds.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T10:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY)

function item(guid, publishedDaysAgo, overrides = {}) {
  return {
    guid,
    title: `Folge ${guid}`,
    pubDate: daysAgo(publishedDaysAgo).toUTCString(),
    enclosure: { url: `https://cdn.example/${guid}.mp3` },
    contentSnippet: `Beschreibung ${guid}`,
    itunes: { duration: '01:02:03' },
    ...overrides,
  }
}

const SUBSCRIPTION = {
  id: 'sub-1',
  feed_url: 'https://feeds.example/lage.xml',
  title: 'Lage der Nation',
  created_at: daysAgo(60).toISOString(),
}

test('selectNewEpisodes keeps audio episodes after the cutoff and maps them to rows', () => {
  const rows = selectNewEpisodes({ items: [item('a', 1)], subscription: SUBSCRIPTION, existingGuids: new Set(), now: NOW })

  assert.deepEqual(rows, [{
    subscription_id: 'sub-1',
    guid: 'a',
    title: 'Folge a',
    description: 'Beschreibung a',
    audio_url: 'https://cdn.example/a.mp3',
    duration_seconds: 3723,
    published_at: daysAgo(1).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    status: 'pending_transcription',
  }])
})

test('selectNewEpisodes filters missing audio, bad dates, future, known and too old items', () => {
  const items = [
    item('no-audio', 1, { enclosure: undefined }),
    item('bad-date', 1, { pubDate: 'kein Datum' }),
    item('no-date', 1, { pubDate: undefined }),
    item('future', -1),
    item('known', 1),
    item('older-than-30-days', 31),
    item('ok', 2),
  ]

  const rows = selectNewEpisodes({ items, subscription: SUBSCRIPTION, existingGuids: new Set(['known']), now: NOW })

  assert.deepEqual(rows.map((r) => r.guid), ['ok'])
})

test('a fresh subscription only imports episodes published after it was created', () => {
  const subscription = { ...SUBSCRIPTION, created_at: daysAgo(3).toISOString() }
  const rows = selectNewEpisodes({
    items: [item('before', 5), item('after', 2)],
    subscription,
    existingGuids: new Set(),
    now: NOW,
  })
  assert.deepEqual(rows.map((r) => r.guid), ['after'])
})

test('at most 50 new episodes per feed', () => {
  const items = Array.from({ length: 60 }, (_, i) => item(`e${i}`, 1))
  const rows = selectNewEpisodes({ items, subscription: SUBSCRIPTION, existingGuids: new Set(), now: NOW })
  assert.equal(rows.length, MAX_NEW_EPISODES_PER_FEED)
})

test('items without guid get a stable sha256 guid and default title', () => {
  const raw = item(undefined, 1, { title: undefined })
  const [row] = selectNewEpisodes({ items: [raw], subscription: SUBSCRIPTION, existingGuids: new Set(), now: NOW })

  assert.equal(row.guid, generateGuid(SUBSCRIPTION.feed_url, '', raw.pubDate))
  assert.match(row.guid, /^[0-9a-f]{64}$/)
  assert.equal(row.title, 'Untitled Episode')

  // Known generated guid is deduplicated on the next run.
  const again = selectNewEpisodes({ items: [raw], subscription: SUBSCRIPTION, existingGuids: new Set([row.guid]), now: NOW })
  assert.equal(again.length, 0)
})

test('parseDuration supports HH:MM:SS, MM:SS, seconds and rejects garbage', () => {
  assert.equal(parseDuration('01:02:03'), 3723)
  assert.equal(parseDuration('45:30'), 2730)
  assert.equal(parseDuration('900'), 900)
  assert.equal(parseDuration(1200), 1200)
  assert.equal(parseDuration('1:2:3:4'), null)
  assert.equal(parseDuration('abc'), null)
  assert.equal(parseDuration(undefined), null)
})

function makeDeps(db, feeds) {
  const requested = []
  return {
    requested,
    supabase: db,
    now: () => NOW,
    fetchImpl: async (url, init) => {
      requested.push({ url, hasSignal: init?.signal instanceof AbortSignal })
      const feed = feeds[url]
      if (feed === undefined) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => url }
    },
    parseXml: async (xml) => {
      const feed = feeds[xml]
      if (feed instanceof Error) throw feed
      return feed
    },
  }
}

test('checkAllFeeds inserts new episodes per subscription and logs each feed', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [
      SUBSCRIPTION,
      { id: 'sub-2', feed_url: 'https://feeds.example/broken.xml', title: 'Kaputt', created_at: daysAgo(60).toISOString() },
      { id: 'sub-3', feed_url: 'https://feeds.example/gone.xml', title: 'Weg', created_at: daysAgo(60).toISOString() },
    ],
    episodes: [{ id: 'e-known', subscription_id: 'sub-1', guid: 'known' }],
    feed_check_logs: [],
  })
  const deps = makeDeps(db, {
    'https://feeds.example/lage.xml': { items: [item('known', 1), item('new-1', 1), item('new-2', 2)] },
    'https://feeds.example/broken.xml': new Error('Non-whitespace before first tag.'),
  })

  const summary = await checkAllFeeds(deps)

  assert.deepEqual(summary, { subscriptionsChecked: 3, newEpisodes: 2, errors: 2 })
  assert.deepEqual(db.data.episodes.map((e) => e.guid).sort(), ['known', 'new-1', 'new-2'])
  assert.ok(deps.requested.every((r) => r.hasSignal))
  const logs = Object.fromEntries(db.data.feed_check_logs.map((l) => [l.subscription_id, l]))
  assert.deepEqual([logs['sub-1'].status, logs['sub-1'].episodes_found], ['success', 2])
  assert.deepEqual([logs['sub-2'].status, logs['sub-2'].error_message], ['error', 'Non-whitespace before first tag.'])
  assert.deepEqual([logs['sub-3'].status, logs['sub-3'].error_message], ['error', 'HTTP 404 fetching feed'])
})

test('episodes inserted concurrently by another run are skipped, not an error', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [SUBSCRIPTION],
    episodes: [],
    feed_check_logs: [],
  })
  const deps = makeDeps(db, { 'https://feeds.example/lage.xml': { items: [item('dup', 1), item('dup', 1)] } })
  // Another run inserts the same episode after our duplicate check.
  const originalFrom = db.from.bind(db)
  db.from = (table) => {
    const api = originalFrom(table)
    if (table !== 'episodes') return api
    return {
      ...api,
      upsert: (record, options) => {
        db.data.episodes.push({ id: 'other-run', subscription_id: 'sub-1', guid: 'dup' })
        return api.upsert(record, options)
      },
    }
  }

  const summary = await checkAllFeeds(deps)

  assert.equal(summary.errors, 0)
  assert.equal(db.data.episodes.filter((e) => e.guid === 'dup').length, 1)
})
