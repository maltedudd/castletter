import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TRANSCRIPT_CHARS,
  GENERATION_LEASE_MS,
  buildNewsletterPrompt,
  parseNewsletter,
  getPodcastRef,
  buildGenerationMarker,
  generateNewsletterForEpisode,
  resetStaleGeneratingEpisodes,
  NewsletterPermanentError,
} from '../../src/lib/newsletter/generate.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T08:00:00.000Z')

const MODEL_OUTPUT = `## Zusammenfassung
Es geht um Reformen.
Und um Gerechtigkeit.

## Hauptthemen
- Rente
- Bürgergeld

## Wichtige Aussagen und Erkenntnisse
- Aussage 1
* Aussage 2

## Tipps und Methoden
- Tipp

## Zitate und Begriffe
- „Zitat“

## Wer sagt was
- Moderatorin: fragt

## Einordnung
Kritisch zu sehen.`

function fakeOpenRouter(responder) {
  const requests = []
  return {
    requests,
    chat: {
      completions: {
        create: async (options) => {
          requests.push(options)
          return responder(options)
        },
      },
    },
  }
}

const answer = (content) => () => ({ choices: [{ message: { content } }] })

function episodeRow(overrides = {}) {
  return {
    id: 'ep-1',
    title: 'Wie gerecht sind die Merz-Reformen?',
    transcript: 'Volles Transkript.',
    status: 'transcribed',
    error_message: null,
    published_at: '2026-10-03T03:01:00.000Z',
    podcast_subscriptions: { title: 'Lage der Nation', user_id: 'user-1' },
    ...overrides,
  }
}

function setup(overrides) {
  const episode = episodeRow(overrides)
  const db = makeFakeSupabase({ episodes: [episode], episode_newsletters: [] })
  return { db, episode }
}

test('prompt carries podcast, episode and transcript; long transcripts are truncated', () => {
  const prompt = buildNewsletterPrompt({ podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1', transcript: 'Hallo' })
  assert.match(prompt, /^Du fasst eine Podcast-Episode zusammen\./)
  assert.match(prompt, /\nPodcast: Lage der Nation\nEpisode: Folge 1\n\nTranskript:\nHallo\n/)
  assert.match(prompt, /## Zusammenfassung/)

  const long = buildNewsletterPrompt({ podcastTitle: 'P', episodeTitle: 'E', transcript: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 10) })
  assert.ok(long.includes('x'.repeat(MAX_TRANSCRIPT_CHARS) + '\n\n[Transkript gekürzt]'))
  assert.ok(!long.includes('x'.repeat(MAX_TRANSCRIPT_CHARS + 1)))
})

test('buildNewsletterPrompt uses website wording for articles, keeps the section headings and forbids additions', () => {
  const prompt = buildNewsletterPrompt({ podcastTitle: 'Stadtblog', episodeTitle: 'Wärmenetz', transcript: 'Artikeltext', sourceType: 'website' })
  assert.match(prompt, /^Du fasst einen Artikel einer Website zusammen\./)
  assert.match(prompt, /ausschließlich auf den folgenden Text/)
  assert.match(prompt, /\nWebsite: Stadtblog\nArtikel: Wärmenetz\n\nText:\nArtikeltext\n/)
  assert.doesNotMatch(prompt, /Podcast|Transkript/)
  for (const heading of ['Zusammenfassung', 'Hauptthemen', 'Wichtige Aussagen und Erkenntnisse', 'Tipps und Methoden', 'Zitate und Begriffe', 'Wer sagt was', 'Einordnung']) {
    assert.ok(prompt.includes(`\n## ${heading}\n`), heading)
  }
  // YouTube and unknown types keep the podcast prompt unchanged.
  const base = { podcastTitle: 'P', episodeTitle: 'E', transcript: 'T' }
  assert.equal(buildNewsletterPrompt({ ...base, sourceType: 'youtube' }), buildNewsletterPrompt(base))
})

test('parseNewsletter extracts all sections', () => {
  assert.deepEqual(parseNewsletter(MODEL_OUTPUT), {
    intro: 'Es geht um Reformen. Und um Gerechtigkeit.',
    bulletPoints: ['Rente', 'Bürgergeld'],
    keyTakeaways: ['Aussage 1', 'Aussage 2'],
    actionItems: ['Tipp'],
    quotes: ['„Zitat“'],
    speakers: ['Moderatorin: fragt'],
    reflection: 'Kritisch zu sehen.',
  })
})

test('parseNewsletter falls back to the whole answer when nothing matches', () => {
  assert.deepEqual(parseNewsletter('  Freitext ohne Struktur  '), {
    intro: 'Freitext ohne Struktur',
    bulletPoints: [],
    keyTakeaways: [],
    actionItems: [],
    quotes: [],
    speakers: [],
    reflection: null,
  })
})

test('getPodcastRef handles the object PostgREST returns and a legacy array', () => {
  assert.deepEqual(getPodcastRef({ podcast_subscriptions: { title: 'A', user_id: 'u' } }), { title: 'A', user_id: 'u' })
  assert.deepEqual(getPodcastRef({ podcast_subscriptions: [{ title: 'B', user_id: 'v' }] }), { title: 'B', user_id: 'v' })
  assert.equal(getPodcastRef({ podcast_subscriptions: null }), undefined)
})

test('generates, stores the newsletter and marks the episode ready', async () => {
  const { db, episode } = setup()
  const openrouter = fakeOpenRouter(answer(MODEL_OUTPUT))

  const outcome = await generateNewsletterForEpisode({ supabase: db, openrouter, model: 'google/gemini-2.5-flash', episode, now: NOW })

  assert.equal(outcome, 'ready')
  assert.equal(openrouter.requests[0].model, 'google/gemini-2.5-flash')
  assert.deepEqual(openrouter.requests[0].reasoning, { effort: 'none' })
  assert.match(openrouter.requests[0].messages[0].content, /Podcast: Lage der Nation/)
  assert.equal(db.data.episodes[0].status, 'newsletter_ready')
  assert.equal(db.data.episodes[0].error_message, null)
  const stored = db.data.episode_newsletters[0]
  assert.equal(stored.episode_id, 'ep-1')
  assert.equal(stored.intro, 'Es geht um Reformen. Und um Gerechtigkeit.')
  assert.deepEqual(stored.bullet_points, ['Rente', 'Bürgergeld'])
  assert.equal(stored.reflection, 'Kritisch zu sehen.')
})

test('an episode claimed by another run is left alone', async () => {
  const episode = episodeRow()
  const db = makeFakeSupabase({ episodes: [episode], episode_newsletters: [] }, {
    beforeUpdate: (data) => {
      if (data.episodes[0].status === 'transcribed') data.episodes[0].status = 'generating_newsletter'
    },
  })
  const openrouter = fakeOpenRouter(answer(MODEL_OUTPUT))

  const outcome = await generateNewsletterForEpisode({ supabase: db, openrouter, model: 'm', episode, now: NOW })

  assert.equal(outcome, 'lost_race')
  assert.equal(openrouter.requests.length, 0)
  assert.equal(db.data.episode_newsletters.length, 0)
})

test('a retry after a stored-but-not-marked newsletter overwrites instead of failing', async () => {
  const { db, episode } = setup()
  db.data.episode_newsletters.push({ id: 'old', episode_id: 'ep-1', intro: 'alt' })
  const openrouter = fakeOpenRouter(answer(MODEL_OUTPUT))

  const outcome = await generateNewsletterForEpisode({ supabase: db, openrouter, model: 'm', episode, now: NOW })

  assert.equal(outcome, 'ready')
  assert.equal(db.data.episode_newsletters.length, 1)
  assert.equal(db.data.episode_newsletters[0].intro, 'Es geht um Reformen. Und um Gerechtigkeit.')
})

test('missing transcript or empty model answer fails permanently', async () => {
  const noTranscript = setup({ transcript: null })
  assert.equal(
    await generateNewsletterForEpisode({ supabase: noTranscript.db, openrouter: fakeOpenRouter(answer('x')), model: 'm', episode: noTranscript.episode, now: NOW }),
    'failed'
  )
  assert.equal(noTranscript.db.data.episodes[0].status, 'newsletter_failed')
  assert.equal(noTranscript.db.data.episodes[0].error_message, 'Kein Transkript vorhanden')

  const empty = setup()
  assert.equal(
    await generateNewsletterForEpisode({ supabase: empty.db, openrouter: fakeOpenRouter(answer('')), model: 'm', episode: empty.episode, now: NOW }),
    'failed'
  )
  assert.equal(empty.db.data.episodes[0].error_message, 'Keine Textantwort vom Modell erhalten')
})

test('temporary errors return the episode to transcribed for a retry', async () => {
  const { db, episode } = setup()
  const openrouter = fakeOpenRouter(() => { throw new Error('429 rate limited') })

  const outcome = await generateNewsletterForEpisode({ supabase: db, openrouter, model: 'm', episode, now: NOW })

  assert.equal(outcome, 'retry_later')
  assert.equal(db.data.episodes[0].status, 'transcribed')
  assert.equal(db.data.episodes[0].error_message, 'Temporärer Fehler: 429 rate limited')
})

test('a lost claim during generation discards the result', async () => {
  const { db, episode } = setup()
  const openrouter = fakeOpenRouter(() => {
    // Stale reset + re-claim by another run while the model is answering.
    db.data.episodes[0].error_message = buildGenerationMarker(new Date(NOW.getTime() + 1000))
    return answer(MODEL_OUTPUT)()
  })

  const outcome = await generateNewsletterForEpisode({ supabase: db, openrouter, model: 'm', episode, now: NOW })

  assert.equal(outcome, 'lease_lost')
  assert.equal(db.data.episodes[0].status, 'generating_newsletter')
})

test('stale generating claims inside the cutoff are reset, fresh and outside ones kept', async () => {
  const stale = buildGenerationMarker(new Date(NOW.getTime() - GENERATION_LEASE_MS - 1000))
  const fresh = buildGenerationMarker(new Date(NOW.getTime() - 60_000))
  const db = makeFakeSupabase({
    episodes: [
      episodeRow({ id: 'stale', status: 'generating_newsletter', error_message: stale }),
      episodeRow({ id: 'legacy', status: 'generating_newsletter', error_message: null }),
      episodeRow({ id: 'fresh', status: 'generating_newsletter', error_message: fresh }),
      episodeRow({ id: 'outside', status: 'generating_newsletter', error_message: stale, published_at: '2026-09-01T00:00:00.000Z' }),
    ],
  })

  const reset = await resetStaleGeneratingEpisodes(db, '2026-09-27T08:00:00.000Z', NOW)

  assert.equal(reset, 2)
  const byId = Object.fromEntries(db.data.episodes.map((e) => [e.id, e]))
  assert.equal(byId.stale.status, 'transcribed')
  assert.equal(byId.legacy.status, 'transcribed')
  assert.equal(byId.fresh.status, 'generating_newsletter')
  assert.equal(byId.outside.status, 'generating_newsletter')
})

test('NewsletterPermanentError is an Error subclass', () => {
  assert.ok(new NewsletterPermanentError('x') instanceof Error)
})
