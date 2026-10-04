import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DELIVERY_MODE,
  normalizeDeliveryMode,
  isDailyDigestDue,
  buildNewsletterSubject,
  SENDING_LEASE_MS,
  claimEpisodesForSending,
  resetStaleSendingEpisodes,
  sendNewsletterToUser,
  deliverImmediatelyIfWanted,
} from '../../src/lib/newsletter/delivery.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T08:00:00.000Z')
const CUTOFF = '2026-10-02T08:00:00.000Z'

const USER = { user_id: 'user-1', newsletter_email: 'malte@example.com' }

const newsletter = (intro) => ({
  intro,
  bullet_points: ['b'],
  key_takeaways: ['k'],
  action_items: [],
  quotes: [],
  speakers: [],
  reflection: null,
})

function episode(id, overrides = {}) {
  return {
    id,
    title: `Episode ${id}`,
    audio_url: `https://cdn.example/${id}.mp3`,
    subscription_id: 'sub-daily',
    status: 'newsletter_ready',
    published_at: '2026-10-03T06:00:00.000Z',
    newsletter_sent_at: null,
    episode_newsletters: newsletter(`intro ${id}`),
    ...overrides,
  }
}

const SUBSCRIPTIONS = [
  { id: 'sub-daily', title: 'Lage der Nation', user_id: 'user-1', delivery_mode: 'daily' },
  { id: 'sub-now', title: 'Hotel Matze', user_id: 'user-1', delivery_mode: 'immediate' },
  { id: 'sub-other', title: 'Fremd', user_id: 'user-2', delivery_mode: 'immediate' },
]

function makeDb(episodes, hooks) {
  return makeFakeSupabase({
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
    podcast_subscriptions: SUBSCRIPTIONS,
    episodes,
  }, hooks)
}

function recordingMailer() {
  const mails = []
  return { mails, sendEmail: async (mail) => { mails.push(mail) } }
}

const statusOf = (db, id) => db.data.episodes.find((e) => e.id === id).status

test('unknown or missing delivery modes fall back to daily', () => {
  assert.equal(DEFAULT_DELIVERY_MODE, 'daily')
  assert.equal(normalizeDeliveryMode('immediate'), 'immediate')
  assert.equal(normalizeDeliveryMode(undefined), 'daily')
  assert.equal(normalizeDeliveryMode('weekly'), 'daily')
})

test('the daily digest is due in the user\'s UTC hour only', () => {
  assert.equal(isDailyDigestDue({ newsletter_delivery_hour: 6 }, 6), true)
  assert.equal(isDailyDigestDue({ newsletter_delivery_hour: 6 }, 7), false)
})

test('subject names podcast and episode for an immediate mail, counts episodes for a digest', () => {
  const one = [{ podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1' }]
  const two = [...one, { podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 2' }]

  assert.equal(buildNewsletterSubject(one, 'immediate'), 'Lage der Nation: Folge 1')
  assert.equal(buildNewsletterSubject(one, 'daily'), 'Deine neuen Podcast-Updates (1 Episode)')
  assert.equal(buildNewsletterSubject(two, 'daily'), 'Deine neuen Podcast-Updates (2 Episoden)')
})

test('daily podcasts: one digest in the delivery hour, then marked sent', async () => {
  const db = makeDb([episode('a'), episode('b', { published_at: '2026-10-03T07:00:00.000Z' })])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 2 })
  assert.equal(mails[0].to, 'malte@example.com')
  assert.equal(mails[0].subject, 'Deine neuen Podcast-Updates (2 Episoden)')
  assert.equal(mails[0].mode, 'daily')
  assert.deepEqual(mails[0].items.map((i) => [i.podcastTitle, i.episodeTitle, i.intro]), [
    ['Lage der Nation', 'Episode a', 'intro a'],
    ['Lage der Nation', 'Episode b', 'intro b'],
  ])
  for (const row of db.data.episodes) {
    assert.equal(row.status, 'newsletter_sent')
    assert.equal(row.newsletter_sent_at, NOW.toISOString())
  }
})

test('daily podcasts wait outside the delivery hour', async () => {
  const db = makeDb([episode('a')])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(result, { mailsSent: 0, episodesSent: 0 })
  assert.equal(mails.length, 0)
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')
})

test('immediate podcasts: one mail per episode, regardless of the hour', async () => {
  const db = makeDb([
    episode('x', { subscription_id: 'sub-now' }),
    episode('y', { subscription_id: 'sub-now', published_at: '2026-10-03T07:00:00.000Z' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(result, { mailsSent: 2, episodesSent: 2 })
  assert.deepEqual(mails.map((m) => m.subject), ['Hotel Matze: Episode x', 'Hotel Matze: Episode y'])
  assert.ok(mails.every((m) => m.mode === 'immediate'))
})

test('mixed podcasts: immediate episodes go out singly, daily ones only in the digest', async () => {
  const db = makeDb([
    episode('daily-1'),
    episode('now-1', { subscription_id: 'sub-now' }),
    episode('daily-2', { published_at: '2026-10-03T07:00:00.000Z' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  // Outside the delivery hour: only the immediate episode.
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.deepEqual(mails.map((m) => m.subject), ['Hotel Matze: Episode now-1'])
  assert.equal(statusOf(db, 'daily-1'), 'newsletter_ready')

  // In the delivery hour: the digest contains only the daily podcast's episodes.
  db.data.episodes.push(episode('now-2', { subscription_id: 'sub-now' }))
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(mails.map((m) => m.subject), [
    'Hotel Matze: Episode now-1',
    'Hotel Matze: Episode now-2',
    'Deine neuen Podcast-Updates (2 Episoden)',
  ])
  assert.deepEqual(mails[2].items.map((i) => i.episodeTitle), ['Episode daily-1', 'Episode daily-2'])
  assert.ok(db.data.episodes.every((e) => e.status === 'newsletter_sent'))
})

test('episodeIds limits a send to the freshly generated episode', async () => {
  const db = makeDb([
    episode('a', { subscription_id: 'sub-now' }),
    episode('b', { subscription_id: 'sub-now' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({
    supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, episodeIds: ['b'],
  })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1 })
  assert.equal(mails[0].items[0].episodeTitle, 'Episode b')
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')
})

test('only the user\'s own, recent, ready episodes are considered', async () => {
  const db = makeDb([
    episode('mine'),
    episode('foreign', { subscription_id: 'sub-other' }),
    episode('old', { published_at: '2026-09-20T06:00:00.000Z' }),
    episode('sent', { status: 'newsletter_sent' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(mails[0].items.map((i) => i.episodeTitle), ['Episode mine'])
})

test('no mail without subscriptions or ready episodes', async () => {
  const { mails, sendEmail } = recordingMailer()

  const noSubs = makeFakeSupabase({ podcast_subscriptions: [], episodes: [episode('a')] })
  assert.deepEqual(
    await sendNewsletterToUser({ supabase: noSubs, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true }),
    { mailsSent: 0, episodesSent: 0 }
  )
  const noEpisodes = makeDb([episode('a', { status: 'transcribed' })])
  assert.deepEqual(
    await sendNewsletterToUser({ supabase: noEpisodes, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true }),
    { mailsSent: 0, episodesSent: 0 }
  )
  assert.equal(mails.length, 0)
})

test('an episode claimed by a concurrent run is never mailed twice', async () => {
  const db = makeDb([episode('a'), episode('b')], {
    // Another run claims `a` between our read and claim.
    beforeUpdate: (data, table, patch) => {
      const a = data.episodes.find((e) => e.id === 'a')
      if (table === 'episodes' && patch.status === 'newsletter_sending' && a.status === 'newsletter_ready') {
        a.status = 'newsletter_sending'
      }
    },
  })
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1 })
  assert.deepEqual(mails[0].items.map((i) => i.episodeTitle), ['Episode b'])
  assert.equal(statusOf(db, 'a'), 'newsletter_sending')
})

test('a failed send releases the claim so the episode is retried later', async () => {
  const db = makeDb([episode('a')])
  const sendEmail = async () => { throw new Error('Resend error: rate limited') }

  await assert.rejects(
    sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true }),
    /rate limited/
  )
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')
  assert.equal(db.data.episodes[0].newsletter_sent_at, null)
})

test('claimEpisodesForSending only claims ready episodes and stamps the claim time', async () => {
  const db = makeFakeSupabase({ episodes: [episode('a'), episode('b', { status: 'newsletter_sent' })] })

  const claimed = await claimEpisodesForSending(db, ['a', 'b'], NOW)

  assert.deepEqual(claimed, ['a'])
  assert.equal(db.data.episodes[0].status, 'newsletter_sending')
  assert.equal(db.data.episodes[0].newsletter_sent_at, NOW.toISOString())
})

test('resetStaleSendingEpisodes frees claims older than the lease, keeps fresh ones', async () => {
  const stale = new Date(NOW.getTime() - SENDING_LEASE_MS - 1000).toISOString()
  const fresh = new Date(NOW.getTime() - 60_000).toISOString()
  const db = makeFakeSupabase({
    episodes: [
      episode('stale', { status: 'newsletter_sending', newsletter_sent_at: stale }),
      episode('fresh', { status: 'newsletter_sending', newsletter_sent_at: fresh }),
      episode('sent', { status: 'newsletter_sent', newsletter_sent_at: stale }),
    ],
  })

  const reset = await resetStaleSendingEpisodes(db, NOW)

  assert.equal(reset, 1)
  assert.equal(statusOf(db, 'stale'), 'newsletter_ready')
  assert.equal(db.data.episodes[0].newsletter_sent_at, null)
  assert.equal(statusOf(db, 'fresh'), 'newsletter_sending')
  assert.equal(statusOf(db, 'sent'), 'newsletter_sent')
})

test('deliverImmediatelyIfWanted mails only episodes of immediate podcasts', async () => {
  const db = makeDb([episode('now', { subscription_id: 'sub-now' }), episode('daily')])
  const { mails, sendEmail } = recordingMailer()
  const args = { supabase: db, userId: 'user-1', sendEmail, now: NOW, recentCutoff: CUTOFF }

  assert.equal(await deliverImmediatelyIfWanted({ ...args, episodeId: 'now' }), 1)
  assert.equal(await deliverImmediatelyIfWanted({ ...args, episodeId: 'daily' }), 0)
  assert.equal(await deliverImmediatelyIfWanted({ ...args, userId: undefined, episodeId: 'daily' }), 0)

  assert.deepEqual(mails.map((m) => m.subject), ['Hotel Matze: Episode now'])
  assert.equal(statusOf(db, 'daily'), 'newsletter_ready')
})
