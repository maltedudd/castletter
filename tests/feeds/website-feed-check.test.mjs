// Feed check for Website (RSS) sources: RSS and Atom items are imported idempotently with
// their feed text and article link; podcast and YouTube sources are unaffected.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { checkAllFeeds, selectNewWebsiteItems } from '../../src/lib/feeds/check-feeds.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'
import { atomFeed, fakeFetch, longHtml, longText, rssFeed } from '../helpers/website-fixtures.mjs'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const parser = new Parser()
const parseXml = (xml) => parser.parseString(xml)

const RSS_URL = 'https://blog.example.com/feed'
const ATOM_URL = 'https://mag.example.org/atom.xml'

const RSS_XML = rssFeed({
  items: [
    { title: 'Volltext', link: 'https://blog.example.com/voll', guid: 'blog-1', published: '2026-10-05T10:00:00Z', description: 'Anriss', content: longHtml() },
    { title: 'Teaser', link: 'https://blog.example.com/teaser', guid: 'blog-2', published: '2026-10-05T11:00:00Z', description: 'Nur ein Anriss … Weiterlesen' },
    // The same item twice in one feed must be imported once.
    { title: 'Teaser', link: 'https://blog.example.com/teaser', guid: 'blog-2', published: '2026-10-05T11:00:00Z', description: 'Nur ein Anriss … Weiterlesen' },
    { title: 'Zu alt', link: 'https://blog.example.com/alt', guid: 'blog-old', published: '2026-08-01T10:00:00Z', description: 'Alt' },
  ],
})
const ATOM_XML = atomFeed({
  entries: [
    { title: 'Analyse', id: 'urn:mag:1', link: 'https://mag.example.org/analyse', published: '2026-10-04T08:00:00Z', summary: 'Kurz', content: longHtml() },
    { title: 'Ohne Link', id: 'urn:mag:2', published: '2026-10-04T09:00:00Z', summary: 'Nur eine Notiz' },
  ],
})

function subscriptions() {
  return [
    { id: 'web-rss', feed_url: RSS_URL, title: 'Stadtblog', created_at: '2026-09-01T00:00:00Z', source_type: 'website', youtube_channel_id: null, enabled: true },
    { id: 'web-atom', feed_url: ATOM_URL, title: 'Technik-Magazin', created_at: '2026-09-01T00:00:00Z', source_type: 'website', youtube_channel_id: null, enabled: true },
  ]
}

test('RSS- und Atom-Einträge werden mit Feed-Text und Artikel-Link als website-Zeilen importiert', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: subscriptions(), episodes: [], feed_check_logs: [] })
  const fetchImpl = fakeFetch({ [RSS_URL]: { body: RSS_XML }, [ATOM_URL]: { body: ATOM_XML } })

  const summary = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  assert.deepEqual(summary, { subscriptionsChecked: 2, newEpisodes: 4, errors: 0 })

  const rows = supabase.data.episodes
  assert.deepEqual(rows.map((r) => r.guid).sort(), ['blog-1', 'blog-2', 'urn:mag:1', 'urn:mag:2'])
  assert.ok(rows.every((r) => r.source_type === 'website' && r.status === 'pending_transcription'))

  const full = rows.find((r) => r.guid === 'blog-1')
  assert.equal(full.article_url, 'https://blog.example.com/voll')
  assert.equal(full.audio_url, 'https://blog.example.com/voll')
  assert.equal(full.feed_content, longText().trim())
  assert.equal(full.published_at, '2026-10-05T10:00:00.000Z')

  const atom = rows.find((r) => r.guid === 'urn:mag:1')
  assert.equal(atom.article_url, 'https://mag.example.org/analyse')
  assert.equal(atom.feed_content, longText().trim())

  const noLink = rows.find((r) => r.guid === 'urn:mag:2')
  assert.equal(noLink.article_url, null)
  assert.equal(noLink.audio_url, ATOM_URL)

  const sources = supabase.data.podcast_subscriptions
  assert.ok(sources.every((s) => s.last_check_status === 'success' && s.last_check_error === null))
})

test('zweiter Lauf importiert nichts doppelt (idempotent)', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: subscriptions(), episodes: [], feed_check_logs: [] })
  const fetchImpl = fakeFetch({ [RSS_URL]: { body: RSS_XML }, [ATOM_URL]: { body: ATOM_XML } })

  await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })
  const second = await checkAllFeeds({ supabase, fetchImpl, parseXml, now: () => NOW })

  assert.equal(second.newEpisodes, 0)
  assert.equal(supabase.data.episodes.length, 4)
})

test('Feed-Abruffehler wird an der Website-Quelle gespeichert', async () => {
  const supabase = makeFakeSupabase({ podcast_subscriptions: subscriptions().slice(0, 1), episodes: [], feed_check_logs: [] })
  const summary = await checkAllFeeds({ supabase, fetchImpl: fakeFetch({ [RSS_URL]: { status: 503 } }), parseXml, now: () => NOW })

  assert.equal(summary.errors, 1)
  assert.equal(supabase.data.podcast_subscriptions[0].last_check_status, 'error')
  assert.match(supabase.data.podcast_subscriptions[0].last_check_error, /HTTP 503/)
})

test('selectNewWebsiteItems: Schlüssel guid › id › link › Hash, ungültige Daten/Zukunft übersprungen, Audio nicht nötig', () => {
  const subscription = { id: 's', feed_url: RSS_URL, created_at: '2026-09-01T00:00:00Z' }
  const rows = selectNewWebsiteItems({
    subscription,
    existingGuids: new Set(['known']),
    now: NOW,
    items: [
      { guid: 'known', title: 'Bekannt', isoDate: '2026-10-05T10:00:00Z' },
      { id: 'atom-id', title: 'Atom', isoDate: '2026-10-05T10:00:00Z' },
      { link: 'https://blog.example.com/nur-link', title: 'Link', isoDate: '2026-10-05T10:00:00Z' },
      { title: 'Ohne alles', pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT' },
      { guid: 'kein-datum', title: 'X' },
      { guid: 'zukunft', title: 'X', isoDate: '2026-10-07T10:00:00Z' },
    ],
  })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].guid, 'atom-id')
  assert.equal(rows[1].guid, 'https://blog.example.com/nur-link')
  assert.match(rows[2].guid, /^[0-9a-f]{64}$/)
  assert.equal(rows[2].feed_content, null)
})

test('Podcast- und YouTube-Quellen behalten ihren Import-Pfad (keine website-Spalten)', async () => {
  const podcastXml = rssFeed({
    items: [{ title: 'Folge', guid: 'ep-1', published: '2026-10-05T10:00:00Z', description: 'Shownotes', enclosure: 'https://cdn.example.com/1.mp3' }],
  })
  const supabase = makeFakeSupabase({
    podcast_subscriptions: [{ id: 'pod', feed_url: 'https://pod.example.com/feed', title: 'Pod', created_at: '2026-09-01T00:00:00Z', source_type: 'podcast', enabled: true }],
    episodes: [],
    feed_check_logs: [],
  })
  await checkAllFeeds({ supabase, fetchImpl: fakeFetch({ 'https://pod.example.com/feed': { body: podcastXml } }), parseXml, now: () => NOW })
  const [row] = supabase.data.episodes
  assert.equal(row.audio_url, 'https://cdn.example.com/1.mp3')
  assert.equal(row.source_type, undefined)
  assert.equal('article_url' in row, false)
})
