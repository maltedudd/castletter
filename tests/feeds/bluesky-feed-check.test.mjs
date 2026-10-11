// Feed check for Bluesky (social) sources (Kanban #40): new own posts are imported once,
// unchanged and directly ready for delivery – no transcription, no summary. Reposts and replies
// to others are left out, the DID keeps the source working across handle changes and the RSS
// fallback yields the same GUIDs as the API.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { checkAllFeeds } from '../../src/lib/feeds/check-feeds.mjs'
import { buildBlueskyAuthorFeedUrl } from '../../src/lib/social/bluesky.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'
import { fakeFetch } from '../helpers/mastodon-fixtures.mjs'
import { DID, HANDLE, OTHER_DID, RSS_URL, author, blueskyRss, feedItem, postUri, postUrl, replyTo } from '../helpers/bluesky-fixtures.mjs'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const parser = new Parser()
const parseXml = (xml) => parser.parseString(xml)
const FEED_URL = buildBlueskyAuthorFeedUrl(DID)

function blueskySource(overrides = {}) {
  return {
    id: 'bsky-1',
    user_id: 'user-1',
    feed_url: RSS_URL,
    title: 'Anna Beispiel',
    created_at: '2026-09-01T00:00:00Z',
    source_type: 'social',
    youtube_channel_id: null,
    social_platform: 'bluesky',
    social_handle: HANDLE,
    social_account_id: DID,
    enabled: true,
    ...overrides,
  }
}

const FEED = [
  feedItem('3ka', {
    record: {
      text: 'Neuer Radweg example.org',
      facets: [{ index: { byteStart: 13, byteEnd: 24 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.org/radweg' }] }],
    },
    post: { embed: { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/f.jpg', thumb: 'https://cdn.bsky.app/t.jpg', alt: 'Radweg' }] } },
  }),
  feedItem('3kb', { record: { createdAt: '2026-10-05T11:00:00.000Z', text: 'Heikel', labels: { values: [{ val: 'graphic-media' }] } } }),
  // Repost, reply to someone else, thread continuation, too old, in the future.
  feedItem('3kc', { post: { uri: postUri('3kc', OTHER_DID), author: author({ did: OTHER_DID, handle: 'bob.example.org' }) }, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }),
  feedItem('3kd', { record: { reply: replyTo(OTHER_DID) } }),
  feedItem('3ke', { record: { createdAt: '2026-10-05T12:00:00.000Z', text: 'Fortsetzung', reply: replyTo(DID, '3ka') } }),
  feedItem('3kf', { record: { createdAt: '2026-08-01T10:00:00.000Z' } }),
  feedItem('3kg', { record: { createdAt: '2026-10-07T10:00:00.000Z' } }),
]

test('neue eigene Posts werden unverändert und zustellbereit importiert, ohne Reposts und fremde Replies', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: [blueskySource()], episodes: [], feed_check_logs: [] })
  const summary = await checkAllFeeds({ supabase, fetchImpl: fakeFetch({ [FEED_URL]: { json: { feed: FEED } } }), parseXml, now: () => NOW })
  assert.deepEqual(summary, { subscriptionsChecked: 1, newEpisodes: 3, errors: 0, socialUserIds: ['user-1'] })

  const rows = supabase.data.episodes
  assert.deepEqual(rows.map((r) => r.guid), [postUrl('3ka'), postUrl('3kb'), postUrl('3ke')])
  assert.ok(rows.every((r) => r.source_type === 'social' && r.status === 'newsletter_ready'))
  assert.ok(rows.every((r) => r.transcript === undefined && r.feed_content === undefined && r.article_url === undefined))

  const [first, warned] = rows
  assert.equal(first.audio_url, postUrl('3ka'))
  assert.equal(first.published_at, '2026-10-05T10:00:00.000Z')
  assert.equal(first.social_content, '<p>Neuer Radweg <a href="https://example.org/radweg" rel="noopener noreferrer nofollow">example.org</a></p>')
  assert.equal(first.title, 'Neuer Radweg example.org')
  assert.deepEqual(first.social_media, [{ type: 'image', url: 'https://cdn.bsky.app/f.jpg', previewUrl: 'https://cdn.bsky.app/t.jpg', description: 'Radweg' }])
  assert.equal(warned.title, 'CW: graphic-media')
  assert.equal(warned.social_spoiler, 'graphic-media')

  const source = supabase.data.podcast_subscriptions[0]
  assert.equal(source.last_check_status, 'success')
  assert.equal(source.social_handle, HANDLE)
})

test('ein zweiter Lauf importiert nichts doppelt', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: [blueskySource()], episodes: [], feed_check_logs: [] })
  const fetchImpl = fakeFetch({ [FEED_URL]: { json: { feed: FEED } } })
  await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  const again = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.deepEqual(again, { subscriptionsChecked: 1, newEpisodes: 0, errors: 0 })
  assert.equal(supabase.data.episodes.length, 3)
})

test('Handle-Wechsel: Abruf über die DID läuft weiter, das neue Handle wird übernommen, keine Duplikate', async () => {
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [blueskySource()],
    episodes: [{ id: 'e1', subscription_id: 'bsky-1', guid: postUrl('3ka'), source_type: 'social', status: 'newsletter_sent' }],
    feed_check_logs: [],
  })
  const renamed = FEED.slice(0, 2).map((item) => ({ ...item, post: { ...item.post, author: author({ handle: 'anna.example.org' }) } }))
  const summary = await checkAllFeeds({ supabase, fetchImpl: fakeFetch({ [FEED_URL]: { json: { feed: renamed } } }), parseXml, now: () => NOW })
  assert.equal(summary.newEpisodes, 1)
  assert.deepEqual(supabase.data.episodes.map((r) => r.guid), [postUrl('3ka'), postUrl('3kb')])
  assert.equal(supabase.data.podcast_subscriptions[0].social_handle, 'anna.example.org')
  assert.equal(supabase.data.podcast_subscriptions[0].feed_url, RSS_URL)
})

test('API-Ausfall: RSS-Fallback liefert dieselben GUIDs, importiert nur Neues und meldet einen Hinweis', async () => {
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [blueskySource()],
    episodes: [{ id: 'e1', subscription_id: 'bsky-1', guid: postUrl('3ka'), source_type: 'social', status: 'newsletter_sent' }],
    feed_check_logs: [],
  })
  const rss = blueskyRss({
    items: [
      { rkey: '3ka', text: 'Neuer Radweg', published: '2026-10-05T10:00:00Z' },
      { rkey: '3kz', text: 'Nur per RSS\n\n[contains quote post or other embedded content]', published: '2026-10-06T09:00:00Z' },
    ],
  })
  const fetchImpl = fakeFetch({ [FEED_URL]: { status: 502, body: '' }, [RSS_URL]: { body: rss } })
  const summary = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.equal(summary.newEpisodes, 1)
  assert.equal(summary.errors, 0)
  assert.match(summary.issues[0].note, /Bluesky-API nicht erreichbar \(HTTP 502\)/)
  const imported = supabase.data.episodes.find((r) => r.guid === postUrl('3kz'))
  assert.equal(imported.social_content, '<p>Nur per RSS</p>')
  assert.equal(supabase.data.feed_check_logs[0].status, 'success')
})

test('Bluesky- und Mastodon-Quellen laufen nebeneinander, ein Bluesky-Fehler bleibt an seiner Quelle', async () => {
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [blueskySource(), blueskySource({ id: 'bsky-2', social_account_id: OTHER_DID, feed_url: `https://bsky.app/profile/${OTHER_DID}/rss` })],
    episodes: [],
    feed_check_logs: [],
  })
  const summary = await checkAllFeeds({ supabase, fetchImpl: fakeFetch({ [FEED_URL]: { json: { feed: FEED } } }), parseXml, now: () => NOW })
  assert.equal(summary.newEpisodes, 3)
  assert.equal(summary.errors, 1)
  assert.match(summary.issues[0].error, /Bluesky-API: HTTP 404; RSS-Feed: HTTP 404/)
  assert.equal(supabase.data.podcast_subscriptions[1].last_check_status, 'error')
})
