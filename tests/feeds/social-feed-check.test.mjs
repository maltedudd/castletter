// Feed check for social (Mastodon) sources: new public posts are imported once, unchanged and
// directly ready for delivery – no transcription, no summary. Boosts and replies to others are
// left out; the RSS feed takes over when the API fails.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { checkAllFeeds, selectNewSocialPosts } from '../../src/lib/feeds/check-feeds.mjs'
import { MASTODON_RSS_CUSTOM_FIELDS, buildMastodonStatusesUrl, normalizeMastodonStatus } from '../../src/lib/social/mastodon.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'
import { ACCOUNT_ID, INSTANCE, RSS_URL, fakeFetch, mastodonRss, status } from '../helpers/mastodon-fixtures.mjs'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const parser = new Parser({ customFields: MASTODON_RSS_CUSTOM_FIELDS })
const parseXml = (xml) => parser.parseString(xml)
const STATUSES_URL = buildMastodonStatusesUrl(INSTANCE, ACCOUNT_ID)

function socialSource(overrides = {}) {
  return {
    id: 'social-1',
    user_id: 'user-1',
    feed_url: RSS_URL,
    title: 'Anna Beispiel',
    created_at: '2026-09-01T00:00:00Z',
    source_type: 'social',
    youtube_channel_id: null,
    social_platform: 'mastodon',
    social_account_id: ACCOUNT_ID,
    enabled: true,
    ...overrides,
  }
}

const STATUSES = [
  status('1001', {
    content: '<p>Neuer Radweg <a href="https://example.org/radweg">example.org/radweg</a></p><script>x()</script>',
    media_attachments: [{ type: 'image', url: 'https://files.social.example/rad.jpg', preview_url: 'https://files.social.example/rad_s.jpg', description: 'Radweg' }],
  }),
  status('1002', { created_at: '2026-10-05T11:00:00.000Z', spoiler_text: 'Politik', content: '<p>Heikler Inhalt</p>' }),
  // Boost, reply to someone else, thread continuation, too old, in the future.
  status('1003', { reblog: status('9', { account: { id: 'other' } }) }),
  status('1004', { in_reply_to_id: '77', in_reply_to_account_id: 'other' }),
  status('1005', { created_at: '2026-10-05T12:00:00.000Z', in_reply_to_id: '1001', in_reply_to_account_id: ACCOUNT_ID, content: '<p>Fortsetzung</p>' }),
  status('1006', { created_at: '2026-08-01T10:00:00.000Z' }),
  status('1007', { created_at: '2026-10-07T10:00:00.000Z' }),
]

test('neue Posts werden unverändert und direkt zustellbereit importiert, ohne Boosts und fremde Replies', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: [socialSource()], episodes: [], feed_check_logs: [] })
  const fetchImpl = fakeFetch({ [STATUSES_URL]: { json: STATUSES } })

  const summary = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.deepEqual(summary, { subscriptionsChecked: 1, newEpisodes: 3, errors: 0, socialUserIds: ['user-1'] })

  const rows = supabase.data.episodes
  assert.deepEqual(rows.map((r) => r.guid), [`${INSTANCE}/@anna/1001`, `${INSTANCE}/@anna/1002`, `${INSTANCE}/@anna/1005`])
  assert.ok(rows.every((r) => r.source_type === 'social' && r.status === 'newsletter_ready'))
  assert.ok(rows.every((r) => r.transcript === undefined && r.feed_content === undefined && r.article_url === undefined))

  const first = rows[0]
  assert.equal(first.audio_url, `${INSTANCE}/@anna/1001`)
  assert.equal(first.published_at, '2026-10-05T10:00:00.000Z')
  assert.equal(first.social_content, '<p>Neuer Radweg <a href="https://example.org/radweg" rel="noopener noreferrer nofollow">example.org/radweg</a></p>')
  assert.equal(first.title, 'Neuer Radweg example.org/radweg')
  assert.equal(first.description, 'Neuer Radweg example.org/radweg')
  assert.equal(first.social_spoiler, null)
  assert.deepEqual(first.social_media, [{ type: 'image', url: 'https://files.social.example/rad.jpg', previewUrl: 'https://files.social.example/rad_s.jpg', description: 'Radweg' }])

  const warned = rows[1]
  assert.equal(warned.title, 'CW: Politik')
  assert.equal(warned.social_spoiler, 'Politik')
  assert.equal(warned.social_media, null)

  assert.deepEqual(supabase.data.feed_check_logs.map((l) => [l.status, l.episodes_found]), [['success', 3]])
  const source = supabase.data.podcast_subscriptions[0]
  assert.equal(source.last_check_status, 'success')
  assert.equal(source.last_checked_at, NOW.toISOString())
})

test('ein zweiter Lauf importiert nichts doppelt', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: [socialSource()], episodes: [], feed_check_logs: [] })
  const fetchImpl = fakeFetch({ [STATUSES_URL]: { json: STATUSES } })
  await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  const again = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.deepEqual(again, { subscriptionsChecked: 1, newEpisodes: 0, errors: 0 })
  assert.equal(supabase.data.episodes.length, 3)
})

test('API-Ausfall: RSS-Fallback importiert dieselben Posts ohne Duplikate und meldet einen Hinweis', async () => {
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [socialSource()],
    // Imported earlier through the API.
    episodes: [{ id: 'e1', subscription_id: 'social-1', guid: `${INSTANCE}/@anna/1001`, source_type: 'social', status: 'newsletter_sent' }],
    feed_check_logs: [],
  })
  const rss = mastodonRss({
    items: [
      { url: `${INSTANCE}/@anna/1001`, published: '2026-10-05T10:00:00Z', html: '<p>Neuer Radweg</p>' },
      { url: `${INSTANCE}/@anna/1010`, published: '2026-10-06T09:00:00Z', html: '<p><strong>Inhaltswarnung:</strong> Essen</p><hr /><p>Rezept</p>',
        media: [{ url: 'https://files.social.example/k.jpg', description: 'Kuchen' }] },
    ],
  })
  const fetchImpl = fakeFetch({ [STATUSES_URL]: { status: 401, body: '' }, [RSS_URL]: { body: rss } })

  const summary = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.equal(summary.newEpisodes, 1)
  assert.equal(summary.errors, 0)
  assert.match(summary.issues[0].note, /Mastodon-API nicht erreichbar \(HTTP 401\)/)

  const imported = supabase.data.episodes.find((r) => r.guid === `${INSTANCE}/@anna/1010`)
  assert.equal(imported.social_spoiler, 'Essen')
  assert.equal(imported.social_content, '<p>Rezept</p>')
  assert.equal(imported.title, 'CW: Essen')
  assert.equal(supabase.data.feed_check_logs[0].status, 'success')
  assert.match(supabase.data.feed_check_logs[0].error_message, /RSS/)
})

test('Fehler einer Social-Quelle wird an der Quelle gespeichert und bricht andere nicht ab', async () => {
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [socialSource(), socialSource({ id: 'social-off', enabled: false })],
    episodes: [],
    feed_check_logs: [],
  })
  const summary = await checkAllFeeds({ supabase, fetchImpl: fakeFetch({}), parseXml, now: () => NOW })
  assert.equal(summary.subscriptionsChecked, 1)
  assert.equal(summary.errors, 1)
  assert.match(summary.issues[0].error, /Mastodon-API: HTTP 404; RSS-Feed: HTTP 404/)
  assert.equal(supabase.data.podcast_subscriptions[0].last_check_status, 'error')
  assert.equal(supabase.data.feed_check_logs[0].status, 'error')
})

test('selectNewSocialPosts: Cut-off, Zukunft, Filter, bekannte GUIDs und Duplikate im Abruf', () => {
  const posts = STATUSES.map(normalizeMastodonStatus)
  posts.push(posts[0]) // the same post twice in one answer
  const rows = selectNewSocialPosts({
    posts,
    subscription: socialSource(),
    existingGuids: new Set([`${INSTANCE}/@anna/1002`]),
    now: NOW,
  })
  assert.deepEqual(rows.map((r) => r.guid), [`${INSTANCE}/@anna/1001`, `${INSTANCE}/@anna/1005`])
})

test('ein Post nur mit Medien bekommt einen neutralen Titel', () => {
  const [row] = selectNewSocialPosts({
    posts: [normalizeMastodonStatus(status('2001', { content: '', media_attachments: [{ type: 'image', url: 'https://files.social.example/x.jpg' }] }))],
    subscription: socialSource(),
    existingGuids: new Set(),
    now: NOW,
  })
  assert.equal(row.title, 'Beitrag mit Medien')
  assert.equal(row.social_content, null)
  assert.equal(row.description, null)
})
