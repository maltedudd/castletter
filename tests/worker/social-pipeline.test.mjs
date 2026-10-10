// Mocked end-to-end run of the worker stages for social (Mastodon) sources: feed check →
// deduplicated import as `newsletter_ready` → immediate posts mailed right after the check,
// daily posts in the digest of the send sweep. Transcription, generation and the overview model
// are never involved.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { runFeedCheck } from '../../worker/feed-jobs.mjs'
import { runOnce } from '../../worker/worker-core.mjs'
import { runGenerationOnce, runSendSweep } from '../../worker/newsletter-jobs.mjs'
import { createDigestOverviewGenerator } from '../../src/lib/newsletter/digest.mjs'
import { MASTODON_RSS_CUSTOM_FIELDS, buildMastodonStatusesUrl } from '../../src/lib/social/mastodon.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'
import { ACCOUNT_ID, INSTANCE, RSS_URL, fakeFetch, status } from '../helpers/mastodon-fixtures.mjs'

const NOW = new Date('2026-10-06T07:30:00.000Z')
const BOB_RSS = 'https://bob.example/@bob.rss'
const BOB_ID = '42'

function setup({ newsletters = true } = {}) {
  const db = makeFakeSupabase({
    podcast_subscriptions: [
      { id: 'anna', user_id: 'user-1', source_type: 'social', social_platform: 'mastodon', social_account_id: ACCOUNT_ID, feed_url: RSS_URL,
        title: 'Anna Beispiel', enabled: true, delivery_mode: 'immediate', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'bob', user_id: 'user-1', source_type: 'social', social_platform: 'mastodon', social_account_id: BOB_ID, feed_url: BOB_RSS,
        title: 'Bob', enabled: true, delivery_mode: 'daily', created_at: '2026-10-01T00:00:00.000Z' },
    ],
    episodes: [],
    feed_check_logs: [],
    episode_newsletters: [],
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
  })
  const fetchImpl = fakeFetch({
    [buildMastodonStatusesUrl(INSTANCE, ACCOUNT_ID)]: {
      json: [
        status('1', { created_at: '2026-10-06T06:00:00.000Z', spoiler_text: 'Politik' }),
        status('2', { created_at: '2026-10-06T07:00:00.000Z' }),
        status('3', { created_at: '2026-10-06T07:10:00.000Z', reblog: status('99') }),
      ],
    },
    [buildMastodonStatusesUrl('https://bob.example', BOB_ID)]: {
      json: [status('7', { created_at: '2026-10-06T05:00:00.000Z', url: 'https://bob.example/@bob/7', account: { id: BOB_ID } })],
    },
  })
  const mails = []
  const fail = (what) => async () => assert.fail(`${what} darf für Social-Posts nie laufen`)
  const openrouter = { chat: { completions: { create: fail('KI-Aufruf') } } }
  const parser = new Parser({ customFields: MASTODON_RSS_CUSTOM_FIELDS })
  const deps = {
    supabase: db,
    config: { maxEpisodeAgeDays: 7, maxAttempts: 3, openrouter: { newsletterModel: 'test/model' } },
    now: () => NOW,
    log: () => {},
    fetchImpl,
    parseXml: (xml) => parser.parseString(xml),
    openrouter,
    transcribeEpisodeAudio: fail('Transkription'),
    sendEmail: newsletters ? async (mail) => { mails.push(mail) } : null,
    summarizeDigest: createDigestOverviewGenerator({ openrouter, model: 'test/model' }),
  }
  return { db, deps, mails }
}

test('Social-Posts: Sofort-Mail direkt nach dem Feed-Check, Tages-Posts im Digest – ohne Transkription und KI', async () => {
  const { db, deps, mails } = setup()

  // 1. Feed check: two posts of Anna (boost left out), one of Bob; Anna's go out at once.
  assert.equal((await runFeedCheck(deps)).newEpisodes, 3)
  assert.deepEqual(mails.map((m) => [m.mode, m.subject]), [
    ['immediate', 'Anna Beispiel: CW: Politik'],
    ['immediate', `Anna Beispiel: Post 2`],
  ])
  assert.equal(mails[0].items[0].social.spoiler, 'Politik')
  assert.equal(mails[0].items[0].audioUrl, `${INSTANCE}/@anna/1`)

  // 2. A second check imports and mails nothing again.
  assert.equal((await runFeedCheck(deps)).newEpisodes, 0)
  assert.equal(mails.length, 2)

  // 3. Transcription and generation have nothing to do.
  assert.deepEqual(await runOnce(deps), { worked: false, outcome: 'idle' })
  assert.deepEqual(await runGenerationOnce(deps), { worked: false, outcome: 'idle' })

  // 4. Send sweep in the delivery hour: Bob's post in the digest, without overview.
  const sweep = await runSendSweep(deps)
  assert.equal(sweep.mailsSent, 1)
  const digest = mails[2]
  assert.equal(digest.mode, 'daily')
  assert.deepEqual(digest.items.map((i) => [i.podcastTitle, i.sourceType]), [['Bob', 'social']])
  assert.equal(digest.overview, null)

  assert.ok(db.data.episodes.every((e) => e.status === 'newsletter_sent'))
  assert.equal(db.data.episode_newsletters.length, 0)
  assert.equal(db.data.newsletter_mails.length, 3)
})

test('ohne Newsletter-Versand importiert der Feed-Check nur und verschickt nichts', async () => {
  const { db, deps, mails } = setup({ newsletters: false })
  const summary = await runFeedCheck(deps)
  assert.deepEqual(summary, { subscriptionsChecked: 2, newEpisodes: 3, errors: 0 })
  assert.equal(mails.length, 0)
  assert.ok(db.data.episodes.every((e) => e.status === 'newsletter_ready'))
})
