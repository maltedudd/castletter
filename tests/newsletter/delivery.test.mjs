import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DELIVERY_MODE,
  normalizeDeliveryMode,
  isDailyDigestDue,
  buildNewsletterSubject,
  MAX_SUBJECT_TITLE_CHARS,
  SENDING_LEASE_MS,
  claimDeliveries,
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

test('subject names podcast and episode for an immediate mail, leads a digest with its first title', () => {
  const one = [{ podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1' }]
  const two = [...one, { podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 2', sourceType: 'podcast' }]

  assert.equal(buildNewsletterSubject(one, 'immediate'), 'Lage der Nation: Folge 1')
  assert.equal(buildNewsletterSubject(one, 'daily'), 'Für dich reingehört: „Folge 1“')
  assert.equal(buildNewsletterSubject(two, 'daily'), 'Für dich reingehört: „Folge 1“ und 1 weitere Folge')
})

test('briefing tone: a digest subject leads with the highest-weighted title, independent of categories', () => {
  const news = { id: 'news', name: 'News', position: 0 }
  const web = { podcastTitle: 'tagesschau.de', episodeTitle: 'Artikel', sourceType: 'website', category: news }
  const pod = { podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1', sourceType: 'podcast', category: null }
  const yt = { podcastTitle: 'Kanal', episodeTitle: 'Video', sourceType: 'youtube', category: news }
  // The website article of the first category is listed first in the mail, the podcast still leads the subject.
  assert.equal(buildNewsletterSubject([web, yt, pod], 'daily'), 'Dein Castletter: „Folge 1“ und 2 weitere Inhalte')
  assert.equal(buildNewsletterSubject([web, yt], 'daily'), 'Dein Castletter: „Video“ und 1 weiterer Inhalt')
})

test('briefing tone: a long lead title is cut on one line; without a title the subject only counts', () => {
  assert.equal(MAX_SUBJECT_TITLE_CHARS, 60)
  const long = { podcastTitle: 'Lage der Nation', episodeTitle: `Sehr\nlange   ${'Folge '.repeat(20)}`, sourceType: 'podcast' }
  const subject = buildNewsletterSubject([long, long], 'daily')
  const lead = subject.slice(subject.indexOf('„') + 1, subject.indexOf('“'))
  assert.ok(Array.from(lead).length <= MAX_SUBJECT_TITLE_CHARS)
  assert.ok(lead.startsWith('Sehr lange Folge') && lead.endsWith('…'))
  assert.match(subject, /“ und 1 weitere Folge$/)

  const untitled = (sourceType) => ({ podcastTitle: 'Quelle', episodeTitle: '  ', sourceType })
  assert.equal(buildNewsletterSubject([untitled('podcast'), untitled('podcast')], 'daily'), 'Für dich reingehört: 2 neue Folgen')
  assert.equal(buildNewsletterSubject([untitled('podcast')], 'daily'), 'Für dich reingehört: 1 neue Folge')
  assert.equal(buildNewsletterSubject([untitled('website')], 'daily'), 'Dein Castletter: 1 neuer Inhalt')
  assert.equal(buildNewsletterSubject([untitled('website'), untitled('youtube')], 'daily'), 'Dein Castletter: 2 neue Inhalte')
})

test('Kanban #42: a digest with anything but podcasts gets a source-neutral subject', () => {
  const pod = { podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1', sourceType: 'podcast' }
  const yt = { podcastTitle: 'Kanal', episodeTitle: 'Video', sourceType: 'youtube' }
  const web = { podcastTitle: 'tagesschau.de', episodeTitle: 'Artikel', sourceType: 'website' }
  const social = { podcastTitle: '@a@b.social', episodeTitle: 'Post', sourceType: 'social' }

  assert.equal(buildNewsletterSubject([pod, yt, web], 'daily'), 'Dein Castletter: „Folge 1“ und 2 weitere Inhalte')
  assert.equal(buildNewsletterSubject([pod, web], 'daily'), 'Dein Castletter: „Folge 1“ und 1 weiterer Inhalt')
  assert.equal(buildNewsletterSubject([yt], 'daily'), 'Dein Castletter: „Video“')
  assert.equal(buildNewsletterSubject([web, web], 'daily'), 'Dein Castletter: „Artikel“ und 1 weiterer Inhalt')
  assert.equal(buildNewsletterSubject([pod, social], 'daily'), 'Dein Castletter: „Folge 1“ und 1 weiterer Inhalt')
  for (const items of [[pod, yt], [web, web], [pod, social]]) {
    assert.doesNotMatch(buildNewsletterSubject(items, 'daily'), /Podcast|Episode/)
  }
  // Several immediate items fall back to the digest subject, with the same rule.
  assert.equal(buildNewsletterSubject([pod, yt], 'immediate'), 'Dein Castletter: „Folge 1“ und 1 weiterer Inhalt')
  assert.equal(buildNewsletterSubject([web], 'immediate'), 'tagesschau.de: Artikel')
})

test('daily podcasts: one digest in the delivery hour, then marked sent', async () => {
  const db = makeDb([episode('a'), episode('b', { published_at: '2026-10-03T07:00:00.000Z' })])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 2 })
  assert.equal(mails[0].to, 'malte@example.com')
  assert.equal(mails[0].subject, 'Für dich reingehört: „Episode a“ und 1 weitere Folge')
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
    'Für dich reingehört: „Episode daily-1“ und 1 weitere Folge',
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
    // Another run claims the digest delivery of `a` between our read and claim.
    beforeInsert: (data, table) => {
      if (table !== 'newsletter_deliveries') return
      data.newsletter_deliveries ??= []
      if (!data.newsletter_deliveries.some((d) => d.episode_id === 'a')) {
        data.newsletter_deliveries.push({ id: 'other-run', episode_id: 'a', target: 'daily', status: 'sending', claimed_at: NOW.toISOString() })
      }
    },
  })
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1 })
  assert.deepEqual(mails[0].items.map((i) => i.episodeTitle), ['Episode b'])
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')
  assert.equal(db.data.newsletter_deliveries.find((d) => d.episode_id === 'a').status, 'sending')
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
  assert.deepEqual(db.data.newsletter_deliveries, [])

  const { mails, sendEmail: working } = recordingMailer()
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail: working, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
  assert.equal(mails.length, 1)
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
})

test('claimDeliveries claims each episode and target once and stamps the claim time', async () => {
  const db = makeFakeSupabase({
    newsletter_deliveries: [{ id: 'd1', user_id: 'user-1', episode_id: 'b', target: 'daily', status: 'sent', claimed_at: 'x' }],
  })

  assert.deepEqual(await claimDeliveries(db, { userId: 'user-1', episodeIds: ['a', 'b'], target: 'daily', now: NOW }), ['a'])
  assert.deepEqual(await claimDeliveries(db, { userId: 'user-1', episodeIds: ['a'], target: 'daily', now: NOW }), [])
  // The other target of the same episode is independent.
  assert.deepEqual(await claimDeliveries(db, { userId: 'user-1', episodeIds: ['a', 'b'], target: 'immediate', now: NOW }), ['a', 'b'])
  assert.deepEqual(await claimDeliveries(db, { userId: 'user-1', episodeIds: [], target: 'immediate', now: NOW }), [])

  const claim = db.data.newsletter_deliveries.find((d) => d.episode_id === 'a' && d.target === 'daily')
  assert.deepEqual(
    { user_id: claim.user_id, status: claim.status, claimed_at: claim.claimed_at },
    { user_id: 'user-1', status: 'sending', claimed_at: NOW.toISOString() }
  )
})

test('resetStaleSendingEpisodes frees claims older than the lease, keeps fresh ones', async () => {
  const stale = new Date(NOW.getTime() - SENDING_LEASE_MS - 1000).toISOString()
  const fresh = new Date(NOW.getTime() - 60_000).toISOString()
  const db = makeFakeSupabase({
    episodes: [
      // Legacy episode claims from before Kanban #43.
      episode('stale', { status: 'newsletter_sending', newsletter_sent_at: stale }),
      episode('fresh', { status: 'newsletter_sending', newsletter_sent_at: fresh }),
      episode('sent', { status: 'newsletter_sent', newsletter_sent_at: stale }),
    ],
    newsletter_deliveries: [
      { id: 'd-stale', episode_id: 'x', target: 'immediate', status: 'sending', claimed_at: stale },
      { id: 'd-fresh', episode_id: 'x', target: 'daily', status: 'sending', claimed_at: fresh },
      { id: 'd-sent', episode_id: 'y', target: 'daily', status: 'sent', claimed_at: stale },
    ],
  })

  const reset = await resetStaleSendingEpisodes(db, NOW)

  assert.equal(reset, 2)
  assert.equal(statusOf(db, 'stale'), 'newsletter_ready')
  assert.equal(db.data.episodes[0].newsletter_sent_at, null)
  assert.equal(statusOf(db, 'fresh'), 'newsletter_sending')
  assert.equal(statusOf(db, 'sent'), 'newsletter_sent')
  assert.deepEqual(db.data.newsletter_deliveries.map((d) => d.id), ['d-fresh', 'd-sent'])
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

// ─── Kanban #38: digest order, overview and style ─────────────────────

const TYPED_SUBSCRIPTIONS = [
  { id: 'sub-pod', title: 'Lage der Nation', user_id: 'user-1', delivery_mode: 'daily', source_type: 'podcast' },
  { id: 'sub-yt', title: 'Kanal', user_id: 'user-1', delivery_mode: 'daily', source_type: 'youtube' },
  { id: 'sub-web', title: 'Stadtblog', user_id: 'user-1', delivery_mode: 'daily', source_type: 'website' },
  { id: 'sub-now', title: 'Hotel Matze', user_id: 'user-1', delivery_mode: 'immediate', source_type: 'podcast' },
]

function typedDb(episodes) {
  return makeFakeSupabase({ podcast_subscriptions: TYPED_SUBSCRIPTIONS, episodes })
}

const MIXED_EPISODES = () => [
  episode('web', { subscription_id: 'sub-web', source_type: 'website', published_at: '2026-10-03T01:00:00.000Z' }),
  episode('yt', { subscription_id: 'sub-yt', source_type: 'youtube', published_at: '2026-10-03T02:00:00.000Z' }),
  episode('pod-late', { subscription_id: 'sub-pod', source_type: 'podcast', published_at: '2026-10-03T05:00:00.000Z' }),
  episode('pod-early', { subscription_id: 'sub-pod', source_type: 'podcast', published_at: '2026-10-03T03:00:00.000Z' }),
]

test('daily digest items follow podcasts → YouTube → Website (RSS), chronological within each', async () => {
  const db = typedDb(MIXED_EPISODES())
  const { mails, sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(mails[0].items.map((i) => [i.id, i.sourceType, i.publishedAt]), [
    ['pod-early', 'podcast', '2026-10-03T03:00:00.000Z'],
    ['pod-late', 'podcast', '2026-10-03T05:00:00.000Z'],
    ['yt', 'youtube', '2026-10-03T02:00:00.000Z'],
    ['web', 'website', '2026-10-03T01:00:00.000Z'],
  ])
  assert.equal(mails[0].subject, 'Dein Castletter: „Episode pod-early“ und 3 weitere Inhalte')
  assert.equal(mails[0].overview, null, 'no overview without a generator')
})

test('daily digest with two or more items gets the overview in the user\'s style', async () => {
  const db = typedDb(MIXED_EPISODES())
  const { mails, sendEmail } = recordingMailer()
  const calls = []
  const overview = { themes: [{ text: 'Energie', sources: [] }], connections: [], reflection: null, itemCount: 4 }
  const summarizeDigest = async (items, style, options) => { calls.push({ ids: items.map((i) => i.id), style, options }); return overview }
  const user = { ...USER, summary_tone: 'analytical', summary_prompt_addition: ' Fokus Kommunen ' }

  await sendNewsletterToUser({ supabase: db, user, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true, summarizeDigest })

  // NIAS-55: the edition date (the send time) goes along, so the overview is about this day.
  assert.deepEqual(calls, [{
    ids: ['pod-early', 'pod-late', 'yt', 'web'],
    style: { tone: 'analytical', promptAddition: 'Fokus Kommunen' },
    options: { editionDate: NOW },
  }])
  assert.deepEqual(mails[0].overview, overview)
  assert.deepEqual(mails[0].items.map((i) => i.id), ['pod-early', 'pod-late', 'yt', 'web'], 'single summaries stay complete')
})

test('a single digest item and immediate mails get no overview (and no model call)', async () => {
  const db = typedDb([
    episode('only', { subscription_id: 'sub-pod', source_type: 'podcast' }),
    episode('now', { subscription_id: 'sub-now', source_type: 'podcast' }),
  ])
  const { mails, sendEmail } = recordingMailer()
  let calls = 0
  const summarizeDigest = async () => { calls++; return { themes: [], connections: [], reflection: null } }

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true, summarizeDigest })

  assert.equal(calls, 0)
  assert.deepEqual(mails.map((m) => [m.mode, m.overview]), [['immediate', null], ['daily', null]])
})

test('a failing overview never blocks the digest: sent without overview, error reported', async () => {
  const db = typedDb(MIXED_EPISODES())
  const { mails, sendEmail } = recordingMailer()
  const errors = []

  const result = await sendNewsletterToUser({
    supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true,
    summarizeDigest: async () => { throw new Error('model down') },
    onOverviewError: (err) => { errors.push(err.message); throw new Error('reporter broken') },
  })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 4 })
  assert.equal(mails[0].overview, null)
  assert.deepEqual(errors, ['model down'])
  for (const row of db.data.episodes) assert.equal(row.status, 'newsletter_sent')
})

// ─── Archive: one record per sent mail ───────────────────────────────

test('a daily digest is recorded as one mail that holds all its episodes', async () => {
  const db = makeDb([episode('a'), episode('b', { published_at: '2026-10-03T07:00:00.000Z' })])
  const { sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(db.data.newsletter_mails, [{
    id: 'newsletter_mails-1',
    user_id: 'user-1',
    mode: 'daily',
    subject: 'Für dich reingehört: „Episode a“ und 1 weitere Folge',
    episode_count: 2,
    sent_at: NOW.toISOString(),
  }])
  assert.ok(db.data.episodes.every((e) => e.newsletter_mail_id === 'newsletter_mails-1' && e.status === 'newsletter_sent'))
})

test('immediate mails are recorded one by one, next to the digest of the same run', async () => {
  const db = makeDb([
    episode('daily-1'),
    episode('now-1', { subscription_id: 'sub-now' }),
    episode('now-2', { subscription_id: 'sub-now', published_at: '2026-10-03T07:00:00.000Z' }),
  ])
  const { sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  assert.deepEqual(
    db.data.newsletter_mails.map((m) => [m.mode, m.episode_count, m.subject]),
    [['immediate', 1, 'Hotel Matze: Episode now-1'], ['immediate', 1, 'Hotel Matze: Episode now-2'], ['daily', 1, 'Für dich reingehört: „Episode daily-1“']]
  )
  const mailOf = (id) => db.data.episodes.find((e) => e.id === id).newsletter_mail_id
  assert.equal(new Set([mailOf('now-1'), mailOf('now-2'), mailOf('daily-1')]).size, 3)
})

test('a failed archive record never blocks or repeats the send', async () => {
  const db = makeDb([episode('x', { subscription_id: 'sub-now' })])
  const originalFrom = db.from.bind(db)
  db.from = (table) => table === 'newsletter_mails'
    ? { insert: () => ({ select: async () => ({ data: null, error: { message: 'relation "newsletter_mails" does not exist' } }) }) }
    : originalFrom(table)
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1, archiveErrors: 1 })
  assert.equal(statusOf(db, 'x'), 'newsletter_sent')
  assert.equal(db.data.episodes[0].newsletter_mail_id, undefined)

  const again = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.deepEqual(again, { mailsSent: 0, episodesSent: 0 })
  assert.equal(mails.length, 1)
})

test('a failed send records no mail', async () => {
  const db = makeDb([episode('x', { subscription_id: 'sub-now' })])
  await assert.rejects(sendNewsletterToUser({
    supabase: db, user: USER, now: NOW, recentCutoff: CUTOFF,
    sendEmail: async () => { throw new Error('Resend down') },
  }))
  assert.equal(db.data.newsletter_mails, undefined)
  assert.equal(statusOf(db, 'x'), 'newsletter_ready')
})

// ─── Kanban #39: social posts (no summary) ────────────────────────────

const SOCIAL_SUBSCRIPTIONS = [
  ...SUBSCRIPTIONS,
  { id: 'sub-social-now', title: 'Anna Beispiel', user_id: 'user-1', delivery_mode: 'immediate', source_type: 'social' },
  { id: 'sub-social-daily', title: 'Bob', user_id: 'user-1', delivery_mode: 'daily', source_type: 'social' },
]

function socialPost(id, overrides = {}) {
  return {
    id,
    title: `Post ${id}`,
    audio_url: `https://social.example/@anna/${id}`,
    subscription_id: 'sub-social-now',
    status: 'newsletter_ready',
    source_type: 'social',
    published_at: '2026-10-03T06:00:00.000Z',
    newsletter_sent_at: null,
    social_content: `<p>Text ${id}</p>`,
    social_spoiler: null,
    social_media: null,
    ...overrides,
  }
}

function socialDb(episodes) {
  return makeFakeSupabase({
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
    podcast_subscriptions: SOCIAL_SUBSCRIPTIONS,
    episodes,
  })
}

test('immediate social source: one mail per post with original text, warning, media and link', async () => {
  const media = [{ type: 'image', url: 'https://files.social.example/a.jpg', previewUrl: null, description: 'Bild' }]
  const db = socialDb([
    socialPost('p1', { social_spoiler: 'Politik', social_media: media }),
    socialPost('p2', { published_at: '2026-10-03T07:00:00.000Z' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.deepEqual(result, { mailsSent: 2, episodesSent: 2 })
  assert.deepEqual(mails.map((m) => [m.mode, m.subject]), [['immediate', 'Anna Beispiel: Post p1'], ['immediate', 'Anna Beispiel: Post p2']])

  const [item] = mails[0].items
  assert.equal(item.sourceType, 'social')
  assert.equal(item.audioUrl, 'https://social.example/@anna/p1')
  assert.deepEqual(item.social, { html: '<p>Text p1</p>', spoiler: 'Politik', media })
  assert.equal(item.intro, '')
  assert.deepEqual(item.bulletPoints, [])
  assert.equal(statusOf(db, 'p1'), 'newsletter_sent')
})

test('daily social source: posts go into the digest unchanged, next to summaries', async () => {
  const db = socialDb([
    episode('a'),
    socialPost('s1', { subscription_id: 'sub-social-daily', published_at: '2026-10-03T05:00:00.000Z' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.equal(mails.length, 0) // outside the delivery hour

  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
  assert.deepEqual(result, { mailsSent: 1, episodesSent: 2 })
  assert.equal(mails[0].mode, 'daily')
  // Kanban #42: fixed section order – podcasts first, social posts last.
  assert.deepEqual(mails[0].items.map((i) => [i.id, i.sourceType]), [['a', 'podcast'], ['s1', 'social']])
  assert.equal(mails[0].items[1].social.html, '<p>Text s1</p>')
  assert.equal(mails[0].items[0].social, undefined)
})

test('a non-social episode without stored newsletter is still never mailed', async () => {
  const db = socialDb([episode('orphan', { subscription_id: 'sub-now', episode_newsletters: null })])
  const { mails, sendEmail } = recordingMailer()
  const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.deepEqual(result, { mailsSent: 0, episodesSent: 0 })
  assert.equal(mails.length, 0)
  assert.equal(statusOf(db, 'orphan'), 'newsletter_ready')
})

test('the overview is only asked for summaries, social posts are left out', async () => {
  const db = socialDb([
    episode('a'),
    episode('b', { published_at: '2026-10-03T07:00:00.000Z' }),
    socialPost('s1', { subscription_id: 'sub-social-daily' }),
  ])
  const { mails, sendEmail } = recordingMailer()
  let overviewItems = null
  const summarizeDigest = async (items) => { overviewItems = items; return { summary: 'Ü', themes: [], connections: [], reflection: null, itemCount: 2 } }

  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true, summarizeDigest })
  assert.equal(mails[0].items.length, 3)
  assert.equal(overviewItems.length, 3) // the generator itself filters to summarised items (hasSummaryContent)
  assert.equal(mails[0].overview.summary, 'Ü')
})

test('deliverImmediatelyIfWanted without episodeId mails all immediate posts of the user', async () => {
  const db = socialDb([
    socialPost('p1'),
    socialPost('p2', { published_at: '2026-10-03T07:00:00.000Z' }),
    socialPost('d1', { subscription_id: 'sub-social-daily' }),
  ])
  const { mails, sendEmail } = recordingMailer()
  const sent = await deliverImmediatelyIfWanted({ supabase: db, userId: 'user-1', sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.equal(sent, 2)
  assert.deepEqual(mails.map((m) => m.items[0].id), ['p1', 'p2'])
  assert.equal(statusOf(db, 'd1'), 'newsletter_ready')
})
