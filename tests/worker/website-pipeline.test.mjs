// Mocked end-to-end run of the worker stages for a Website (RSS) source: feed check →
// idempotent import → text resolution without audio/STT (feed full text, teaser → public
// article, paywall/teaser-only/login → transparent failure) → newsletter generation ending in
// the review-ready `newsletter_ready` state. Nothing is sent.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { runFeedCheck } from '../../worker/feed-jobs.mjs'
import { runOnce } from '../../worker/worker-core.mjs'
import { runGenerationOnce } from '../../worker/newsletter-jobs.mjs'
import { createEpisodeTranscriber } from '../../worker/transcribers.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'
import { articlePage, fakeFetch, fakeLookup, longHtml, longText, rssFeed } from '../helpers/website-fixtures.mjs'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const FEED_URL = 'https://blog.example.com/feed'
const MODEL_OUTPUT = '## Zusammenfassung\nKurz.\n\n## Hauptthemen\n- Thema\n\n## Wichtige Aussagen und Erkenntnisse\n- Aussage'
const TEASER = 'Ein kurzer Anriss … Weiterlesen'

const FEED_XML = rssFeed({
  items: [
    { title: 'Volltext im Feed', link: 'https://blog.example.com/voll', guid: 'full', published: '2026-10-05T08:00:00Z', description: 'Anriss', content: longHtml() },
    { title: 'Teaser mit Artikel', link: 'https://blog.example.com/artikel', guid: 'teaser', published: '2026-10-05T09:00:00Z', description: TEASER },
    { title: 'Hinter Paywall', link: 'https://blog.example.com/plus', guid: 'paywall', published: '2026-10-05T10:00:00Z', description: TEASER },
    { title: 'Nur Login', link: 'https://blog.example.com/intern', guid: 'login', published: '2026-10-05T11:00:00Z', description: TEASER },
    { title: 'Nur Notiz', guid: 'note', published: '2026-10-05T12:00:00Z', description: 'Kurze Notiz ohne Link' },
  ],
})

/** Column defaults from the migrations and the PostgREST source embed, which the fake lacks. */
function withDefaultsAndSubscriptionJoin(db) {
  const originalFrom = db.from.bind(db)
  db.from = (table) => {
    if (table === 'episodes') {
      for (const row of db.data.episodes) {
        row.transcription_attempts ??= 0
        row.error_message ??= null
        row.transcript ??= null
        const source = db.data.podcast_subscriptions.find((s) => s.id === row.subscription_id)
        if (source) row.podcast_subscriptions = { title: source.title, user_id: source.user_id }
      }
    }
    return originalFrom(table)
  }
}

test('Website-Quelle durchläuft die gemeinsame Pipeline ohne Audio/STT bis newsletter_ready, nichts wird versendet', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{
      id: 'web-1', user_id: 'user-1', source_type: 'website', youtube_channel_id: null, feed_url: FEED_URL,
      title: 'Stadtblog', enabled: true, delivery_mode: 'daily', created_at: '2026-09-01T00:00:00.000Z',
    }],
    episodes: [],
    feed_check_logs: [],
    episode_newsletters: [],
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
  })
  withDefaultsAndSubscriptionJoin(db)

  const fetchImpl = fakeFetch({
    [FEED_URL]: { body: FEED_XML, headers: { 'content-type': 'application/rss+xml' } },
    'https://blog.example.com/artikel': { body: articlePage() },
    'https://blog.example.com/plus': { body: articlePage({ head: '<script type="application/ld+json">{"isAccessibleForFree": false}</script>' }) },
    'https://blog.example.com/intern': { status: 302, headers: { location: '/login?redirect=/intern' } },
    'https://blog.example.com/login?redirect=/intern': { body: articlePage({ body: '<form>Bitte anmelden</form>' }) },
  })
  const prompts = []
  const mails = []
  const parser = new Parser()
  const deps = {
    supabase: db,
    config: { maxEpisodeAgeDays: 7, maxAttempts: 3, downloadTimeoutMs: 1000, youtube: { captionLanguages: ['de'] }, openrouter: { newsletterModel: 'test/model' } },
    now: () => NOW,
    log: () => {},
    fetchImpl,
    parseXml: (xml) => parser.parseString(xml),
    openrouter: {
      chat: { completions: { create: async ({ messages }) => { prompts.push(messages[0].content); return { choices: [{ message: { content: MODEL_OUTPUT } }] } } } },
    },
    sendEmail: async (mail) => { mails.push(mail) },
  }
  deps.transcribeEpisodeAudio = createEpisodeTranscriber({
    config: deps.config,
    transcribeChunk: async () => assert.fail('Website-Artikel werden nie per STT transkribiert'),
    youtube: { fetchMetadata: async () => assert.fail('kein yt-dlp für Website-Artikel') },
    ffmpeg: async () => assert.fail('kein ffmpeg für Website-Artikel'),
    fetchImpl,
    lookup: fakeLookup(),
  })

  // 1. Feed check twice: every item exactly once.
  assert.equal((await runFeedCheck(deps)).newEpisodes, 5)
  assert.equal((await runFeedCheck(deps)).newEpisodes, 0)
  assert.equal(db.data.episodes.length, 5)

  // 2. Text resolution loop until idle (oldest first).
  const outcomes = []
  for (let i = 0; i < 10; i++) {
    const result = await runOnce(deps)
    if (!result.worked) break
    outcomes.push(result.outcome)
  }
  assert.deepEqual(outcomes, ['transcribed', 'transcribed', 'failed', 'failed', 'failed'])

  // 3. Newsletter generation until idle.
  for (let i = 0; i < 10 && (await runGenerationOnce(deps)).worked; i++) { /* drain */ }

  const byGuid = Object.fromEntries(db.data.episodes.map((e) => [e.guid, e]))

  assert.equal(byGuid.full.status, 'newsletter_ready')
  assert.equal(byGuid.full.transcript_source, 'feed_content')
  assert.equal(byGuid.full.transcript, longText())
  assert.equal(byGuid.full.error_code, null)

  assert.equal(byGuid.teaser.status, 'newsletter_ready')
  assert.equal(byGuid.teaser.transcript_source, 'article')
  assert.match(byGuid.teaser.transcript, /^Das neue Wärmenetz/)

  assert.deepEqual(
    [byGuid.paywall, byGuid.login, byGuid.note].map((e) => [e.status, e.error_code, e.transcript]),
    [['failed', 'paywalled', null], ['failed', 'access_restricted', null], ['failed', 'content_incomplete', null]]
  )
  assert.ok(byGuid.paywall.error_message.includes('Paywall'))

  // Only the two complete articles were summarised – with the website wording – and none was mailed.
  assert.equal(db.data.episode_newsletters.length, 2)
  assert.deepEqual(db.data.episode_newsletters.map((n) => n.episode_id).sort(), [byGuid.full.id, byGuid.teaser.id].sort())
  assert.equal(prompts.length, 2)
  assert.ok(prompts.every((p) => p.startsWith('Du fasst einen Artikel einer Website zusammen.') && p.includes('\nWebsite: Stadtblog\n')))
  assert.deepEqual(mails, [])

  // Only the feed and the linked article pages (plus the redirect target) were requested.
  assert.deepEqual(
    [...new Set(fetchImpl.calls)].sort(),
    [FEED_URL, 'https://blog.example.com/artikel', 'https://blog.example.com/intern', 'https://blog.example.com/login?redirect=/intern', 'https://blog.example.com/plus'].sort()
  )
})

test('Temporärer Artikel-Fehler geht mit Grund zurück in die Warteschlange und wird später verarbeitet', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{ id: 'web-1', user_id: 'u', source_type: 'website', feed_url: FEED_URL, title: 'Blog', created_at: '2026-09-01T00:00:00.000Z' }],
    episodes: [{
      id: 'ep-1', subscription_id: 'web-1', source_type: 'website', guid: 'g', title: 'T', status: 'pending_transcription',
      published_at: '2026-10-05T10:00:00.000Z', audio_url: 'https://blog.example.com/a', article_url: 'https://blog.example.com/a', feed_content: TEASER,
    }],
  })
  withDefaultsAndSubscriptionJoin(db)
  let available = false
  const fetchImpl = fakeFetch({ 'https://blog.example.com/a': () => (available ? { body: articlePage() } : { status: 503 }) })
  const deps = { supabase: db, config: { maxEpisodeAgeDays: 7, maxAttempts: 3 }, now: () => NOW, log: () => {} }
  deps.transcribeEpisodeAudio = createEpisodeTranscriber({ config: {}, transcribeChunk: null, youtube: null, ffmpeg: null, fetchImpl })

  assert.equal((await runOnce(deps)).outcome, 'retry_later')
  const [row] = db.data.episodes
  assert.equal(row.status, 'pending_transcription')
  assert.equal(row.error_code, 'article_fetch_failed')
  assert.match(row.error_message, /Versuch 1\/3.*HTTP 503/)

  available = true
  assert.equal((await runOnce(deps)).outcome, 'transcribed')
  assert.equal(row.status, 'transcribed')
  assert.equal(row.error_code, null)
  assert.equal(row.transcript_source, 'article')
})
