// Kanban #43: immediate and daily delivery are two independent targets per source.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DELIVERY_TARGETS,
  deliveryPatchOf,
  deliveryTargetsOf,
  toggleDeliveryTarget,
  wantedTargetsOf,
} from '../../src/lib/newsletter/delivery-targets.mjs'
import { deliverImmediatelyIfWanted, sendNewsletterToUser } from '../../src/lib/newsletter/delivery.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T08:00:00.000Z')
const LATER = new Date('2026-10-05T07:00:00.000Z')
const CUTOFF = '2026-10-02T08:00:00.000Z'
const USER = { user_id: 'user-1', newsletter_email: 'malte@example.com' }

const IMMEDIATE_ONLY = { deliver_immediately: true, deliver_daily: false }
const DAILY_ONLY = { deliver_immediately: false, deliver_daily: true }
const BOTH = { deliver_immediately: true, deliver_daily: true }

const newsletter = (intro) => ({
  intro, bullet_points: ['b'], key_takeaways: ['k'], action_items: [], quotes: [], speakers: [], reflection: null,
})

function episode(id, subscriptionId, overrides = {}) {
  return {
    id,
    title: `Episode ${id}`,
    audio_url: `https://cdn.example/${id}.mp3`,
    subscription_id: subscriptionId,
    status: 'newsletter_ready',
    published_at: '2026-10-03T06:00:00.000Z',
    newsletter_sent_at: null,
    episode_newsletters: newsletter(`intro ${id}`),
    ...overrides,
  }
}

function sub(id, title, targets, overrides = {}) {
  return { id, title, user_id: 'user-1', source_type: 'podcast', ...targets, ...overrides }
}

function makeDb(subscriptions, episodes, extra = {}) {
  return makeFakeSupabase({
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
    podcast_subscriptions: subscriptions,
    episodes,
    ...extra,
  })
}

function recordingMailer() {
  const mails = []
  return { mails, sendEmail: async (mail) => { mails.push(mail) } }
}

const statusOf = (db, id) => db.data.episodes.find((e) => e.id === id).status
const deliveriesOf = (db, id) => (db.data.newsletter_deliveries ?? [])
  .filter((d) => d.episode_id === id)
  .map((d) => [d.target, d.status])
  .sort()
const titlesOf = (mail) => mail.items.map((i) => i.episodeTitle)

const send = (db, sendEmail, options = {}) =>
  sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, ...options })

// ─── Targets and migration of the legacy delivery_mode ────────────────

test('legacy delivery_mode maps safely: immediate → immediate only, daily/unknown/missing → daily only', () => {
  assert.deepEqual(DELIVERY_TARGETS, ['immediate', 'daily'])
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'immediate' }), { immediate: true, daily: false })
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'daily' }), { immediate: false, daily: true })
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'weekly' }), { immediate: false, daily: true })
  assert.deepEqual(deliveryTargetsOf(undefined), { immediate: false, daily: true })
})

test('the flags win over delivery_mode; "no target" never happens (falls back to delivery_mode)', () => {
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'immediate', ...BOTH }), { immediate: true, daily: true })
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'immediate', ...DAILY_ONLY }), { immediate: false, daily: true })
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'daily', ...IMMEDIATE_ONLY }), { immediate: true, daily: false })
  // Invalid rows (both off, or null flags) keep the legacy delivery instead of silently none.
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'immediate', deliver_immediately: false, deliver_daily: false }), { immediate: true, daily: false })
  assert.deepEqual(deliveryTargetsOf({ delivery_mode: 'daily', deliver_immediately: null, deliver_daily: null }), { immediate: false, daily: true })
  assert.deepEqual(wantedTargetsOf(BOTH), ['immediate', 'daily'])
  assert.deepEqual(wantedTargetsOf(DAILY_ONLY), ['daily'])
})

test('toggling targets: both combinable, the last active target cannot be switched off', () => {
  const daily = { immediate: false, daily: true }
  assert.deepEqual(toggleDeliveryTarget(daily, 'immediate', true), { ok: true, targets: { immediate: true, daily: true } })
  assert.deepEqual(toggleDeliveryTarget({ immediate: true, daily: true }, 'daily', false), { ok: true, targets: { immediate: true, daily: false } })
  assert.deepEqual(toggleDeliveryTarget(daily, 'daily', false), { ok: false, targets: daily })
  assert.deepEqual(toggleDeliveryTarget(daily, 'weekly', true), { ok: false, targets: daily })
  assert.deepEqual(deliveryPatchOf({ immediate: true, daily: false }), IMMEDIATE_ONLY)
})

// ─── The three combinations ───────────────────────────────────────────

test('immediate only: one mail right away, never in the digest', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', IMMEDIATE_ONLY)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail)
  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => [m.mode, titlesOf(m)]), [['immediate', ['Episode a']]])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
  assert.deepEqual(deliveriesOf(db, 'a'), [['immediate', 'sent']])
})

test('daily only: nothing outside the hour, then exactly one digest entry', async () => {
  const db = makeDb([sub('s', 'Lage der Nation', DAILY_ONLY)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail)
  assert.equal(mails.length, 0)
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')

  await send(db, sendEmail, { includeDaily: true })
  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => [m.mode, titlesOf(m)]), [['daily', ['Episode a']]])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
  assert.deepEqual(deliveriesOf(db, 'a'), [['daily', 'sent']])
})

test('both: exactly one immediate mail and exactly one later digest entry – immediate does not use it up', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()

  // Right after generation and in further sweeps outside the hour: one immediate mail only.
  assert.equal(await deliverImmediatelyIfWanted({ supabase: db, userId: 'user-1', episodeId: 'a', sendEmail, now: NOW, recentCutoff: CUTOFF }), 1)
  await send(db, sendEmail)
  await send(db, sendEmail)
  assert.deepEqual(mails.map((m) => m.mode), ['immediate'])
  assert.equal(statusOf(db, 'a'), 'newsletter_ready', 'still waiting for the digest')
  assert.deepEqual(deliveriesOf(db, 'a'), [['immediate', 'sent']])

  // Delivery hour: the digest holds it once; repeated sweeps add nothing.
  await send(db, sendEmail, { includeDaily: true, now: LATER })
  await send(db, sendEmail, { includeDaily: true, now: LATER })
  await send(db, sendEmail, { now: LATER })

  assert.deepEqual(mails.map((m) => [m.mode, m.subject, titlesOf(m)]), [
    ['immediate', 'Hotel Matze: Episode a', ['Episode a']],
    ['daily', 'Deine neuen Podcast-Updates (1 Episode)', ['Episode a']],
  ])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
  assert.equal(db.data.episodes[0].newsletter_sent_at, LATER.toISOString())
  assert.deepEqual(deliveriesOf(db, 'a'), [['daily', 'sent'], ['immediate', 'sent']])
})

test('both, generated during the delivery hour: immediate mail and digest in the same sweep, each once', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH), sub('d', 'Lage der Nation', DAILY_ONLY)], [episode('a', 's'), episode('b', 'd')])
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail, { includeDaily: true })
  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => [m.mode, titlesOf(m)]), [
    ['immediate', ['Episode a']],
    ['daily', ['Episode a', 'Episode b']],
  ])
  assert.ok(db.data.episodes.every((e) => e.status === 'newsletter_sent'))
})

// ─── Retry and dedupe per target ──────────────────────────────────────

test('a failed digest keeps the sent immediate mail and retries only the digest', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()
  await send(db, sendEmail)

  await assert.rejects(
    send(db, async () => { throw new Error('Resend down') }, { includeDaily: true }),
    /Resend down/
  )
  assert.deepEqual(deliveriesOf(db, 'a'), [['immediate', 'sent']])
  assert.equal(statusOf(db, 'a'), 'newsletter_ready')

  await send(db, sendEmail, { includeDaily: true })
  assert.deepEqual(mails.map((m) => m.mode), ['immediate', 'daily'])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
})

test('a failed immediate mail is retried by the sweep without touching the digest entry', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')])
  await assert.rejects(deliverImmediatelyIfWanted({
    supabase: db, userId: 'user-1', episodeId: 'a', now: NOW, recentCutoff: CUTOFF,
    sendEmail: async () => { throw new Error('Resend down') },
  }))
  assert.deepEqual(deliveriesOf(db, 'a'), [])

  const { mails, sendEmail } = recordingMailer()
  await send(db, sendEmail)
  await send(db, sendEmail, { includeDaily: true, now: LATER })
  assert.deepEqual(mails.map((m) => m.mode), ['immediate', 'daily'])
})

test('a running claim of one target blocks only that target', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')], {
    newsletter_deliveries: [{ id: 'other', user_id: 'user-1', episode_id: 'a', target: 'immediate', status: 'sending', claimed_at: NOW.toISOString() }],
  })
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => m.mode), ['daily'])
  assert.equal(statusOf(db, 'a'), 'newsletter_ready', 'the other run still has to finish its immediate mail')
})

test('a delivery claimed between read and claim by another run is skipped (no duplicate)', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()
  let raced = false
  const racing = makeFakeSupabase(db.data, {
    beforeInsert: (data, table, records) => {
      if (table !== 'newsletter_deliveries' || raced || records[0].target !== 'immediate') return
      raced = true
      data.newsletter_deliveries ??= []
      data.newsletter_deliveries.push({ id: 'other', episode_id: 'a', target: 'immediate', status: 'sent', claimed_at: NOW.toISOString() })
    },
  })

  const result = await send(racing, sendEmail)

  assert.deepEqual(result, { mailsSent: 0, episodesSent: 0 })
  assert.equal(mails.length, 0)
})

test('a concurrent run that delivered the other target meanwhile still lets the episode complete', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')], {
    newsletter_deliveries: [{ id: 'other', user_id: 'user-1', episode_id: 'a', target: 'immediate', status: 'sending', claimed_at: NOW.toISOString() }],
  })
  const mails = []
  // While our digest is being mailed, the other run finishes its immediate mail of `a`.
  const sendEmail = async (mail) => {
    mails.push(mail)
    db.data.newsletter_deliveries.find((d) => d.id === 'other').status = 'sent'
  }

  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => m.mode), ['daily'])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
})

// ─── Changing targets later never loses or repeats content ────────────

test('switching both → immediate only after the immediate mail completes the episode without a digest', async () => {
  const subscription = sub('s', 'Hotel Matze', BOTH)
  const db = makeDb([subscription], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()
  await send(db, sendEmail)

  Object.assign(db.data.podcast_subscriptions[0], IMMEDIATE_ONLY)
  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => m.mode), ['immediate'])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
})

test('switching daily only → both before the digest adds the immediate mail, the digest still comes', async () => {
  const db = makeDb([sub('s', 'Lage der Nation', DAILY_ONLY)], [episode('a', 's')])
  const { mails, sendEmail } = recordingMailer()
  await send(db, sendEmail)
  assert.equal(mails.length, 0)

  Object.assign(db.data.podcast_subscriptions[0], BOTH)
  await send(db, sendEmail)
  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => m.mode), ['immediate', 'daily'])
  assert.equal(statusOf(db, 'a'), 'newsletter_sent')
})

test('sources without the new flags (before the migration) keep their legacy delivery', async () => {
  const db = makeDb(
    [sub('now', 'Hotel Matze', {}, { delivery_mode: 'immediate' }), sub('day', 'Lage der Nation', {}, { delivery_mode: 'daily' })],
    [episode('a', 'now'), episode('b', 'day')]
  )
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail, { includeDaily: true })

  assert.deepEqual(mails.map((m) => [m.mode, titlesOf(m)]), [['immediate', ['Episode a']], ['daily', ['Episode b']]])
})

// ─── Every source type follows the same rule ──────────────────────────

test('podcast, YouTube, website and social with both targets: one immediate mail each plus one shared digest', async () => {
  const subscriptions = [
    sub('pod', 'Lage der Nation', BOTH, { source_type: 'podcast' }),
    sub('yt', 'Kanal', BOTH, { source_type: 'youtube' }),
    sub('web', 'Stadtblog', BOTH, { source_type: 'website' }),
    sub('soc', 'Anna Beispiel', BOTH, { source_type: 'social' }),
  ]
  const episodes = [
    episode('p', 'pod', { source_type: 'podcast' }),
    episode('y', 'yt', { source_type: 'youtube' }),
    episode('w', 'web', { source_type: 'website' }),
    episode('s', 'soc', {
      source_type: 'social', episode_newsletters: null,
      social_content: '<p>Hallo</p>', social_spoiler: null, social_media: [],
    }),
  ]
  const db = makeDb(subscriptions, episodes)
  const { mails, sendEmail } = recordingMailer()

  await send(db, sendEmail)
  await send(db, sendEmail, { includeDaily: true, now: LATER })
  await send(db, sendEmail, { includeDaily: true, now: LATER })

  const immediate = mails.filter((m) => m.mode === 'immediate')
  const daily = mails.filter((m) => m.mode === 'daily')
  assert.deepEqual(immediate.map((m) => m.items[0].sourceType).sort(), ['podcast', 'social', 'website', 'youtube'])
  assert.ok(immediate.every((m) => m.items.length === 1))
  assert.equal(daily.length, 1)
  assert.deepEqual(daily[0].items.map((i) => i.sourceType), ['podcast', 'youtube', 'website', 'social'])
  assert.equal(daily[0].items.find((i) => i.sourceType === 'social').social.html, '<p>Hallo</p>')
  assert.ok(db.data.episodes.every((e) => e.status === 'newsletter_sent'))
  for (const e of episodes) assert.deepEqual(deliveriesOf(db, e.id), [['daily', 'sent'], ['immediate', 'sent']])
})

// ─── Archive: an episode with both targets is in both mails ───────────

test('archive: the immediate mail and the digest each record the episode', async () => {
  const db = makeDb([sub('s', 'Hotel Matze', BOTH)], [episode('a', 's')])
  const { sendEmail } = recordingMailer()

  await send(db, sendEmail)
  await send(db, sendEmail, { includeDaily: true, now: LATER })

  const [immediateMail, dailyMail] = db.data.newsletter_mails
  assert.deepEqual([immediateMail.mode, immediateMail.episode_count, dailyMail.mode, dailyMail.episode_count], ['immediate', 1, 'daily', 1])
  const mailIds = db.data.newsletter_deliveries.map((d) => [d.target, d.mail_id]).sort()
  assert.deepEqual(mailIds, [['daily', dailyMail.id], ['immediate', immediateMail.id]])
  // Legacy pointer for code before #43: the latest mail.
  assert.equal(db.data.episodes[0].newsletter_mail_id, dailyMail.id)
  assert.ok(db.data.newsletter_deliveries.every((d) => d.user_id === 'user-1' && d.sent_at))
})
