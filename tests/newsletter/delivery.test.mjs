import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DELIVERY_MODE,
  normalizeDeliveryMode,
  isDueForDelivery,
  buildNewsletterSubject,
  SENDING_LEASE_MS,
  claimEpisodesForSending,
  resetStaleSendingEpisodes,
  sendNewsletterToUser,
} from '../../src/lib/newsletter/delivery.mjs'

const NOW = new Date('2026-10-04T08:00:00.000Z')
const CUTOFF = '2026-10-02T08:00:00.000Z'

/**
 * In-memory stand-in for the subset of the Supabase query builder used here:
 * select/update with eq/in/gte/lt/order, awaited directly or via `.select()`.
 * `beforeUpdate` simulates a concurrent writer between read and write.
 */
function makeDb(tables, { beforeUpdate } = {}) {
  const data = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]))

  function builder(table, kind, patch) {
    const filters = []
    let order = null
    const run = () => {
      const rows = data[table]
      if (kind === 'update' && beforeUpdate) beforeUpdate(data, table, patch)
      let matched = rows.filter((row) => filters.every((f) => f(row)))
      if (kind === 'update') {
        for (const row of matched) Object.assign(row, patch)
        return { data: matched.map((r) => ({ id: r.id })), error: null }
      }
      if (order) matched = [...matched].sort((a, b) => (a[order] < b[order] ? -1 : 1))
      return { data: matched.map((r) => ({ ...r })), error: null }
    }
    const b = {
      eq(c, v) { filters.push((r) => r[c] === v); return b },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b },
      gte(c, v) { filters.push((r) => r[c] >= v); return b },
      lt(c, v) { filters.push((r) => r[c] != null && r[c] < v); return b },
      order(c) { order = c; return b },
      select() { return Promise.resolve(run()) },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return b
  }

  return {
    data,
    from(table) {
      return {
        select: () => builder(table, 'select'),
        update: (patch) => builder(table, 'update', patch),
      }
    },
  }
}

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
    subscription_id: 'sub-1',
    status: 'newsletter_ready',
    published_at: '2026-10-03T06:00:00.000Z',
    newsletter_sent_at: null,
    episode_newsletters: newsletter(`intro ${id}`),
    ...overrides,
  }
}

function makeUserDb(episodes, options) {
  return makeDb({
    podcast_subscriptions: [
      { id: 'sub-1', title: 'Lage der Nation', user_id: 'user-1' },
      { id: 'sub-other', title: 'Fremd', user_id: 'user-2' },
    ],
    episodes,
  }, options)
}

function recordingMailer() {
  const mails = []
  return { mails, sendEmail: async (mail) => { mails.push(mail) } }
}

const DAILY_USER = { user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_mode: 'daily' }
const IMMEDIATE_USER = { ...DAILY_USER, newsletter_delivery_mode: 'immediate' }

test('unknown or missing delivery modes fall back to daily', () => {
  assert.equal(DEFAULT_DELIVERY_MODE, 'daily')
  assert.equal(normalizeDeliveryMode('immediate'), 'immediate')
  assert.equal(normalizeDeliveryMode('daily'), 'daily')
  assert.equal(normalizeDeliveryMode(undefined), 'daily')
  assert.equal(normalizeDeliveryMode('weekly'), 'daily')
})

test('daily users are due only in their UTC hour, immediate users always', () => {
  assert.equal(isDueForDelivery({ newsletter_delivery_mode: 'daily', newsletter_delivery_hour: 6 }, 6), true)
  assert.equal(isDueForDelivery({ newsletter_delivery_mode: 'daily', newsletter_delivery_hour: 6 }, 7), false)
  assert.equal(isDueForDelivery({ newsletter_delivery_hour: 6 }, 6), true)
  assert.equal(isDueForDelivery({ newsletter_delivery_mode: 'immediate', newsletter_delivery_hour: 6 }, 13), true)
})

test('subject names podcast and episode for an immediate mail, counts episodes for a digest', () => {
  const one = [{ podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 1' }]
  const two = [...one, { podcastTitle: 'Lage der Nation', episodeTitle: 'Folge 2' }]

  assert.equal(buildNewsletterSubject(one, 'immediate'), 'Lage der Nation: Folge 1')
  assert.equal(buildNewsletterSubject(one, 'daily'), 'Deine neuen Podcast-Updates (1 Episode)')
  assert.equal(buildNewsletterSubject(two, 'daily'), 'Deine neuen Podcast-Updates (2 Episoden)')
})

test('daily: one digest with all ready episodes, then marked sent', async () => {
  const db = makeUserDb([episode('a'), episode('b', { published_at: '2026-10-03T07:00:00.000Z' })])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 2 })
  assert.equal(mails.length, 1)
  assert.equal(mails[0].to, 'malte@example.com')
  assert.equal(mails[0].subject, 'Deine neuen Podcast-Updates (2 Episoden)')
  assert.deepEqual(mails[0].items.map((i) => [i.podcastTitle, i.episodeTitle, i.intro]), [
    ['Lage der Nation', 'Episode a', 'intro a'],
    ['Lage der Nation', 'Episode b', 'intro b'],
  ])
  for (const row of db.data.episodes) {
    assert.equal(row.status, 'newsletter_sent')
    assert.equal(row.newsletter_sent_at, NOW.toISOString())
  }
})

test('immediate: one mail per episode', async () => {
  const db = makeUserDb([episode('a'), episode('b', { published_at: '2026-10-03T07:00:00.000Z' })])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: IMMEDIATE_USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(result, { mailsSent: 2, episodesSent: 2 })
  assert.deepEqual(mails.map((m) => m.subject), ['Lage der Nation: Episode a', 'Lage der Nation: Episode b'])
  assert.ok(mails.every((m) => m.items.length === 1))
})

test('episodeIds limits an immediate send to the freshly generated episode', async () => {
  const db = makeUserDb([episode('a'), episode('b')])
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({
    supabase: db, user: IMMEDIATE_USER, sendEmail, now: NOW, recentCutoff: CUTOFF, episodeIds: ['b'],
  })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1 })
  assert.equal(mails[0].items[0].episodeTitle, 'Episode b')
  assert.equal(db.data.episodes.find((e) => e.id === 'a').status, 'newsletter_ready')
})

test('only the user\'s own, recent, ready episodes are considered', async () => {
  const db = makeUserDb([
    episode('mine'),
    episode('foreign', { subscription_id: 'sub-other' }),
    episode('old', { published_at: '2026-09-20T06:00:00.000Z' }),
    episode('sent', { status: 'newsletter_sent' }),
  ])
  const { mails, sendEmail } = recordingMailer()

  await sendNewsletterToUser({ supabase: db, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(mails[0].items.map((i) => i.episodeTitle), ['Episode mine'])
})

test('no mail without subscriptions or ready episodes', async () => {
  const { mails, sendEmail } = recordingMailer()

  const noSubs = makeDb({ podcast_subscriptions: [], episodes: [episode('a')] })
  assert.deepEqual(
    await sendNewsletterToUser({ supabase: noSubs, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF }),
    { mailsSent: 0, episodesSent: 0 }
  )
  const noEpisodes = makeUserDb([episode('a', { status: 'transcribed' })])
  assert.deepEqual(
    await sendNewsletterToUser({ supabase: noEpisodes, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF }),
    { mailsSent: 0, episodesSent: 0 }
  )
  assert.equal(mails.length, 0)
})

test('an episode claimed by a concurrent run is never mailed twice', async () => {
  const db = makeUserDb([episode('a'), episode('b')], {
    // Another run (generate-newsletters' immediate send) claims `a` between our read and claim.
    beforeUpdate: (data, table, patch) => {
      const a = data.episodes.find((e) => e.id === 'a')
      if (table === 'episodes' && patch.status === 'newsletter_sending' && a.status === 'newsletter_ready') {
        a.status = 'newsletter_sending'
      }
    },
  })
  const { mails, sendEmail } = recordingMailer()

  const result = await sendNewsletterToUser({ supabase: db, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF })

  assert.deepEqual(result, { mailsSent: 1, episodesSent: 1 })
  assert.deepEqual(mails[0].items.map((i) => i.episodeTitle), ['Episode b'])
  assert.equal(mails[0].subject, 'Deine neuen Podcast-Updates (1 Episode)')
  assert.equal(db.data.episodes.find((e) => e.id === 'a').status, 'newsletter_sending')
})

test('a failed send releases the claim so the episode is retried later', async () => {
  const db = makeUserDb([episode('a')])
  const sendEmail = async () => { throw new Error('Resend error: rate limited') }

  await assert.rejects(
    sendNewsletterToUser({ supabase: db, user: DAILY_USER, sendEmail, now: NOW, recentCutoff: CUTOFF }),
    /rate limited/
  )
  assert.equal(db.data.episodes[0].status, 'newsletter_ready')
  assert.equal(db.data.episodes[0].newsletter_sent_at, null)
})

test('claimEpisodesForSending only claims ready episodes and stamps the claim time', async () => {
  const db = makeDb({ episodes: [episode('a'), episode('b', { status: 'newsletter_sent' })] })

  const claimed = await claimEpisodesForSending(db, ['a', 'b'], NOW)

  assert.deepEqual(claimed, ['a'])
  assert.equal(db.data.episodes[0].status, 'newsletter_sending')
  assert.equal(db.data.episodes[0].newsletter_sent_at, NOW.toISOString())
})

test('resetStaleSendingEpisodes frees claims older than the lease, keeps fresh ones', async () => {
  const stale = new Date(NOW.getTime() - SENDING_LEASE_MS - 1000).toISOString()
  const fresh = new Date(NOW.getTime() - 60_000).toISOString()
  const db = makeDb({
    episodes: [
      episode('stale', { status: 'newsletter_sending', newsletter_sent_at: stale }),
      episode('fresh', { status: 'newsletter_sending', newsletter_sent_at: fresh }),
      episode('sent', { status: 'newsletter_sent', newsletter_sent_at: stale }),
    ],
  })

  const reset = await resetStaleSendingEpisodes(db, NOW)

  assert.equal(reset, 1)
  const byId = Object.fromEntries(db.data.episodes.map((e) => [e.id, e]))
  assert.equal(byId.stale.status, 'newsletter_ready')
  assert.equal(byId.stale.newsletter_sent_at, null)
  assert.equal(byId.fresh.status, 'newsletter_sending')
  assert.equal(byId.sent.status, 'newsletter_sent')
})
