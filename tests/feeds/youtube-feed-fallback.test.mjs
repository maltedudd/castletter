import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAllFeeds } from '../../src/lib/feeds/check-feeds.mjs'
import { buildYouTubeFeedUrl } from '../../src/lib/youtube/channel.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-06T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const FEED_URL = buildYouTubeFeedUrl(CHANNEL_ID)
const vid = (n) => `video${String(n).padStart(6, '0')}`

function source(overrides = {}) {
  return {
    id: 'yt-1',
    source_type: 'youtube',
    youtube_channel_id: CHANNEL_ID,
    feed_url: FEED_URL,
    title: 'Kanal',
    enabled: true,
    created_at: ago(20 * DAY),
    ...overrides,
  }
}

/** Feed answers `feedStatus`; /shorts/<id> always redirects (no Shorts on the Videos tab). */
function deps(db, { feedStatus = 404, feedBody = '', youtubeFallback } = {}) {
  const requested = []
  return {
    requested,
    supabase: db,
    now: () => NOW,
    youtubeFallback,
    parseXml: async () => assert.fail('RSS parser is only for podcasts'),
    fetchImpl: async (url) => {
      const short = url.match(/\/shorts\/(.+)$/)
      if (short) return { status: 303, headers: new Headers({ location: `https://www.youtube.com/watch?v=${short[1]}` }) }
      requested.push(url)
      return { ok: feedStatus === 200, status: feedStatus, text: async () => feedBody }
    },
  }
}

function fallback({ uploads = [], uploadsError, exact = {}, exactError } = {}) {
  const calls = []
  return {
    calls,
    async listUploads(channelId) {
      calls.push(['list', channelId])
      if (uploadsError) throw uploadsError
      return uploads
    },
    async fetchPublishTimes(videoIds) {
      calls.push(['exact', videoIds])
      if (exactError) throw exactError
      return Object.fromEntries(videoIds.filter((id) => exact[id]).map((id) => [id, exact[id]]))
    },
  }
}

const upload = (n, publishedAgoMs) => ({ videoId: vid(n), title: `Video ${n}`, published: ago(publishedAgoMs), description: null, approximate: true })

test('feed 404 → uploads are read via yt-dlp and imported like feed entries', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [source()],
    episodes: [{ id: 'e-old', subscription_id: 'yt-1', guid: `yt:video:${vid(1)}` }],
    feed_check_logs: [],
  })
  const fb = fallback({ uploads: [upload(1, 2 * HOUR), upload(2, 3 * HOUR), upload(3, 5 * DAY)] })

  const summary = await checkAllFeeds(deps(db, { youtubeFallback: fb }))

  assert.equal(summary.newEpisodes, 2)
  assert.equal(summary.errors, 0)
  assert.deepEqual(db.data.episodes.map((e) => e.guid).sort(), [`yt:video:${vid(1)}`, `yt:video:${vid(2)}`, `yt:video:${vid(3)}`])
  const imported = db.data.episodes.find((e) => e.youtube_video_id === vid(2))
  assert.equal(imported.status, 'pending_transcription')
  assert.equal(imported.published_at, ago(3 * HOUR))
  // Far from the cut-off (subscription 20 days old): approximate dates are good enough.
  assert.deepEqual(fb.calls, [['list', CHANNEL_ID]])

  const sourceRow = db.data.podcast_subscriptions[0]
  assert.equal(sourceRow.last_check_status, 'success')
  assert.equal(sourceRow.last_check_error, null)
  const log = db.data.feed_check_logs[0]
  assert.equal(log.status, 'success')
  assert.match(log.error_message, /HTTP 404.*Uploads per yt-dlp vom Videos-Tab gelesen/)
  assert.deepEqual(summary.issues, [{ source: 'Kanal', note: log.error_message }])
})

test('near the cut-off the exact publish time decides; a missing exact time holds the video back', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [source({ created_at: ago(10 * HOUR) })],
    episodes: [],
    feed_check_logs: [],
  })
  const fb = fallback({
    // All three look like ~1 day old (approximate), i.e. near the cut-off 10 h ago.
    uploads: [upload(1, 9 * HOUR), upload(2, 1 * DAY), upload(3, 1 * DAY), upload(4, 10 * DAY)],
    exact: { [vid(1)]: ago(9 * HOUR), [vid(2)]: ago(26 * HOUR) }, // vid(3): no exact time
  })

  const summary = await checkAllFeeds(deps(db, { youtubeFallback: fb }))

  // vid(1) after the cut-off → imported; vid(2) exactly before → skipped; vid(3) unknown → held back;
  // vid(4) far before the cut-off → skipped without lookup.
  assert.deepEqual(db.data.episodes.map((e) => e.youtube_video_id), [vid(1)])
  assert.deepEqual(fb.calls, [['list', CHANNEL_ID], ['exact', [vid(1), vid(2), vid(3)]]])
  assert.equal(summary.errors, 1)
  assert.match(db.data.podcast_subscriptions[0].last_check_error, /Veröffentlichungsdatum für 1 Video nicht ermittelbar.*nächsten Lauf/)
})

test('a failing exact-time lookup holds all affected videos back instead of guessing', async () => {
  const db = makeFakeSupabase({ podcast_subscriptions: [source({ created_at: ago(10 * HOUR) })], episodes: [], feed_check_logs: [] })
  const fb = fallback({ uploads: [upload(1, 9 * HOUR)], exactError: new Error('HTTP Error 429') })

  const summary = await checkAllFeeds(deps(db, { youtubeFallback: fb }))

  assert.equal(db.data.episodes.length, 0)
  assert.equal(summary.errors, 1)
  assert.match(db.data.podcast_subscriptions[0].last_check_error, /Veröffentlichungsdatum für 1 Video nicht ermittelbar \(HTTP Error 429\)/)
})

test('feed and fallback both failing → error with both reasons on the source and in the summary', async () => {
  const db = makeFakeSupabase({ podcast_subscriptions: [source()], episodes: [], feed_check_logs: [] })
  const fb = fallback({ uploadsError: new Error('Video unavailable: channel terminated') })

  const summary = await checkAllFeeds(deps(db, { youtubeFallback: fb }))

  const message = db.data.podcast_subscriptions[0].last_check_error
  assert.match(message, /^YouTube-Feed nicht erreichbar \(HTTP 404\).*; Ausweichabruf per yt-dlp fehlgeschlagen: Video unavailable: channel terminated$/)
  assert.equal(db.data.podcast_subscriptions[0].last_check_status, 'error')
  assert.deepEqual(summary.issues, [{ source: 'Kanal', error: message }])
})

test('network errors and invalid feeds also use the fallback; a channel mismatch does not', async () => {
  const fb = fallback({ uploads: [upload(1, HOUR)] })
  const invalid = makeFakeSupabase({ podcast_subscriptions: [source()], episodes: [], feed_check_logs: [] })
  await checkAllFeeds(deps(invalid, { feedStatus: 200, feedBody: '<html>consent</html>', youtubeFallback: fb }))
  assert.equal(invalid.data.episodes.length, 1)

  const offline = makeFakeSupabase({ podcast_subscriptions: [source()], episodes: [], feed_check_logs: [] })
  const d = deps(offline, { youtubeFallback: fallback({ uploads: [upload(1, HOUR)] }) })
  d.fetchImpl = async () => { throw new TypeError('fetch failed') }
  // Shorts check needs fetch as well and fails → held back, but the fallback listing ran.
  const summary = await checkAllFeeds(d)
  assert.equal(offline.data.feed_check_logs[0].status, 'error')
  assert.match(summary.issues[0].error, /Shorts-Prüfung/)

  const mismatch = makeFakeSupabase({ podcast_subscriptions: [source()], episodes: [], feed_check_logs: [] })
  const mismatchFallback = fallback({ uploads: [upload(1, HOUR)] })
  await checkAllFeeds(deps(mismatch, {
    feedStatus: 200,
    feedBody: '<feed><yt:channelId>bbbbbbbbbbbbbbbbbbbbbb</yt:channelId><title>X</title></feed>',
    youtubeFallback: mismatchFallback,
  }))
  assert.deepEqual(mismatchFallback.calls, [])
  assert.match(mismatch.data.podcast_subscriptions[0].last_check_error, /gehört zu Kanal/)
})

test('without a fallback (Vercel cron) a feed failure stays an error as before', async () => {
  const db = makeFakeSupabase({ podcast_subscriptions: [source()], episodes: [], feed_check_logs: [] })
  const summary = await checkAllFeeds(deps(db))
  assert.equal(summary.errors, 1)
  assert.match(db.data.podcast_subscriptions[0].last_check_error, /^YouTube-Feed nicht erreichbar \(HTTP 404\) – Störung bei YouTube oder Kanal gelöscht$/)
})

test('summary issues name failing podcast feeds too; a clean run has no issues key', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{ id: 'pod-1', feed_url: 'https://feeds.example/weg.xml', title: 'Weg-Podcast', created_at: ago(60 * DAY) }],
    episodes: [],
    feed_check_logs: [],
  })
  const failing = await checkAllFeeds({
    supabase: db,
    now: () => NOW,
    fetchImpl: async () => ({ ok: false, status: 410, text: async () => '' }),
    parseXml: async () => ({ items: [] }),
  })
  assert.deepEqual(failing.issues, [{ source: 'Weg-Podcast', error: 'HTTP 410 fetching feed' }])

  const clean = await checkAllFeeds({
    supabase: db,
    now: () => NOW,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<rss/>' }),
    parseXml: async () => ({ items: [] }),
  })
  assert.deepEqual(clean, { subscriptionsChecked: 1, newEpisodes: 0, errors: 0 })
})
