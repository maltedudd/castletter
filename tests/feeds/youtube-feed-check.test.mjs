import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAllFeeds, selectNewYouTubeVideos, MAX_NEW_EPISODES_PER_FEED } from '../../src/lib/feeds/check-feeds.mjs'
import { buildYouTubeFeedUrl } from '../../src/lib/youtube/channel.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T10:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY)
const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const FEED_URL = buildYouTubeFeedUrl(CHANNEL_ID)

const YT_SOURCE = {
  id: 'yt-1',
  source_type: 'youtube',
  youtube_channel_id: CHANNEL_ID,
  feed_url: FEED_URL,
  title: 'Kanal',
  enabled: true,
  created_at: daysAgo(60).toISOString(),
}

const vid = (n) => `video${String(n).padStart(6, '0')}`

function entry(videoId, publishedDaysAgo, overrides = {}) {
  return { videoId, title: `Video ${videoId}`, published: daysAgo(publishedDaysAgo).toISOString(), description: `Über ${videoId}`, thumbnailUrl: null, ...overrides }
}

function feedXml(entries, channelId = CHANNEL_ID) {
  const body = entries
    .map((e) => `<entry><id>yt:video:${e.videoId}</id><yt:videoId>${e.videoId}</yt:videoId><title>${e.title}</title><published>${e.published}</published><media:group><media:description>${e.description ?? ''}</media:description></media:group></entry>`)
    .join('')
  return `<feed><yt:channelId>${channelId}</yt:channelId><title>Kanal</title>${body}</feed>`
}

function deps(db, routes) {
  const requested = []
  return {
    requested,
    supabase: db,
    now: () => NOW,
    fetchImpl: async (url, init) => {
      requested.push({ url, hasSignal: init?.signal instanceof AbortSignal })
      const route = routes[url]
      if (route === undefined) return { ok: false, status: 404, text: async () => '' }
      return { ok: true, status: 200, text: async () => route }
    },
    parseXml: async () => { throw new Error('RSS parser must not be used for YouTube sources') },
  }
}

test('selectNewYouTubeVideos maps uploads to pipeline rows keyed by video ID', () => {
  const rows = selectNewYouTubeVideos({ entries: [entry(vid(1), 1)], subscription: YT_SOURCE, existingGuids: new Set(), now: NOW })

  assert.deepEqual(rows, [{
    subscription_id: 'yt-1',
    guid: `yt:video:${vid(1)}`,
    title: `Video ${vid(1)}`,
    description: `Über ${vid(1)}`,
    audio_url: `https://www.youtube.com/watch?v=${vid(1)}`,
    duration_seconds: null,
    published_at: daysAgo(1).toISOString(),
    status: 'pending_transcription',
    source_type: 'youtube',
    youtube_video_id: vid(1),
  }])
})

test('selectNewYouTubeVideos dedupes by video ID (known and repeated) and applies the import cutoff', () => {
  const entries = [
    entry(vid(1), 1),
    entry(vid(1), 1), // repeated inside the same feed
    entry(vid(2), 1), // already imported
    entry(vid(3), 31), // older than 30 days
    entry(vid(4), -1), // future (scheduled premiere timestamp)
    entry(vid(5), 1, { published: null }),
  ]
  const rows = selectNewYouTubeVideos({ entries, subscription: YT_SOURCE, existingGuids: new Set([`yt:video:${vid(2)}`]), now: NOW })
  assert.deepEqual(rows.map((r) => r.youtube_video_id), [vid(1)])

  const fresh = { ...YT_SOURCE, created_at: daysAgo(3).toISOString() }
  const freshRows = selectNewYouTubeVideos({ entries: [entry(vid(6), 5), entry(vid(7), 2)], subscription: fresh, existingGuids: new Set(), now: NOW })
  assert.deepEqual(freshRows.map((r) => r.youtube_video_id), [vid(7)])

  const many = Array.from({ length: 60 }, (_, i) => entry(vid(100 + i), 1))
  assert.equal(selectNewYouTubeVideos({ entries: many, subscription: YT_SOURCE, existingGuids: new Set(), now: NOW }).length, MAX_NEW_EPISODES_PER_FEED)
})

test('checkAllFeeds ingests a YouTube channel from its official feed and is idempotent across runs', async () => {
  const db = makeFakeSupabase({ podcast_subscriptions: [YT_SOURCE], episodes: [], feed_check_logs: [] })
  const d = deps(db, { [FEED_URL]: feedXml([entry(vid(1), 1), entry(vid(2), 2)]) })

  const first = await checkAllFeeds(d)
  const second = await checkAllFeeds(d)

  assert.deepEqual(first, { subscriptionsChecked: 1, newEpisodes: 2, errors: 0 })
  assert.deepEqual(second, { subscriptionsChecked: 1, newEpisodes: 0, errors: 0 })
  assert.deepEqual(db.data.episodes.map((e) => e.youtube_video_id).sort(), [vid(1), vid(2)])
  assert.ok(db.data.episodes.every((e) => e.status === 'pending_transcription' && e.source_type === 'youtube'))
  assert.deepEqual(d.requested.map((r) => r.url), [FEED_URL, FEED_URL])
  assert.ok(d.requested.every((r) => r.hasSignal))

  const source = db.data.podcast_subscriptions[0]
  assert.equal(source.last_check_status, 'success')
  assert.equal(source.last_check_error, null)
  assert.equal(source.last_checked_at, NOW.toISOString())
  assert.deepEqual(db.data.feed_check_logs.map((l) => [l.status, l.episodes_found]), [['success', 2], ['success', 0]])
})

test('the feed is always built from the stored channel ID, not the stored feed_url', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{ ...YT_SOURCE, feed_url: 'https://evil.example/feed.xml' }],
    episodes: [],
    feed_check_logs: [],
  })
  const d = deps(db, { [FEED_URL]: feedXml([entry(vid(1), 1)]) })
  await checkAllFeeds(d)
  assert.deepEqual(d.requested.map((r) => r.url), [FEED_URL])
})

test('feed failures are persisted on the source with an actionable reason', async () => {
  const otherId = 'UCbbbbbbbbbbbbbbbbbbbbbb'
  const db = makeFakeSupabase({
    podcast_subscriptions: [
      YT_SOURCE,
      { ...YT_SOURCE, id: 'yt-2', youtube_channel_id: otherId, feed_url: buildYouTubeFeedUrl(otherId) },
      { ...YT_SOURCE, id: 'yt-3', youtube_channel_id: 'UCcccccccccccccccccccccc', feed_url: buildYouTubeFeedUrl('UCcccccccccccccccccccccc') },
      { ...YT_SOURCE, id: 'yt-4', youtube_channel_id: 'broken', feed_url: 'x' },
    ],
    episodes: [],
    feed_check_logs: [],
  })
  const d = deps(db, {
    // yt-1: 404 (not in routes)
    [buildYouTubeFeedUrl(otherId)]: '<html>consent</html>',
    [buildYouTubeFeedUrl('UCcccccccccccccccccccccc')]: feedXml([], CHANNEL_ID),
  })

  const summary = await checkAllFeeds(d)

  assert.deepEqual(summary, { subscriptionsChecked: 4, newEpisodes: 0, errors: 4 })
  const byId = Object.fromEntries(db.data.podcast_subscriptions.map((s) => [s.id, s]))
  assert.equal(byId['yt-1'].last_check_status, 'error')
  assert.match(byId['yt-1'].last_check_error, /HTTP 404.*Kanal gelöscht oder Channel-ID falsch/)
  assert.match(byId['yt-2'].last_check_error, /Kein gültiger YouTube-Feed/)
  assert.match(byId['yt-3'].last_check_error, /gehört zu Kanal UCaaaa/)
  assert.match(byId['yt-4'].last_check_error, /Ungültige YouTube-Channel-ID/)
  assert.ok(db.data.feed_check_logs.every((l) => l.status === 'error'))
})

test('disabled sources (podcast or YouTube) are not checked; podcasts keep using the RSS parser', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [
      { ...YT_SOURCE, enabled: false },
      { id: 'pod-1', feed_url: 'https://feeds.example/a.xml', title: 'Pod', created_at: daysAgo(60).toISOString() },
      { id: 'pod-2', feed_url: 'https://feeds.example/b.xml', title: 'Aus', created_at: daysAgo(60).toISOString(), enabled: false },
    ],
    episodes: [],
    feed_check_logs: [],
  })
  const requested = []
  const summary = await checkAllFeeds({
    supabase: db,
    now: () => NOW,
    fetchImpl: async (url) => { requested.push(url); return { ok: true, status: 200, text: async () => '<rss/>' } },
    parseXml: async () => ({
      items: [{ guid: 'g1', title: 'Neu', pubDate: daysAgo(1).toUTCString(), enclosure: { url: 'https://cdn.example/g1.mp3' } }],
    }),
  })

  assert.deepEqual(summary, { subscriptionsChecked: 1, newEpisodes: 1, errors: 0 })
  assert.deepEqual(requested, ['https://feeds.example/a.xml'])
  // Podcast rows keep their previous shape (no YouTube columns written).
  assert.equal('source_type' in db.data.episodes[0], false)
  assert.equal('last_check_status' in db.data.podcast_subscriptions[1], false)
})
