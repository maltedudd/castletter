// Kanban #48: the daily digest is ordered by the user's source categories; immediate mails,
// claims and delivery state stay exactly as before.
import assert from 'node:assert/strict'
import test from 'node:test'
import { sendNewsletterToUser } from '../../src/lib/newsletter/delivery.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-14T07:00:00.000Z')
const CUTOFF = '2026-10-12T07:00:00.000Z'
const USER = { user_id: 'user-1', newsletter_email: 'malte@example.com' }
const DAILY = { deliver_immediately: false, deliver_daily: true }
const BOTH = { deliver_immediately: true, deliver_daily: true }

const newsletter = (intro) => ({
  intro, bullet_points: ['b'], key_takeaways: ['k'], action_items: [], quotes: [], speakers: [], reflection: null,
})

function episode(id, subscriptionId, publishedAt, overrides = {}) {
  return {
    id,
    title: `Titel ${id}`,
    audio_url: `https://example.com/${id}`,
    subscription_id: subscriptionId,
    status: 'newsletter_ready',
    published_at: publishedAt,
    newsletter_sent_at: null,
    episode_newsletters: newsletter(`intro ${id}`),
    ...overrides,
  }
}

const sub = (id, sourceType, categoryId, targets = DAILY, userId = 'user-1') => ({
  id, title: `Quelle ${id}`, user_id: userId, source_type: sourceType, category_id: categoryId, ...targets,
})

const CATEGORIES = [
  { id: 'cat-tech', user_id: 'user-1', name: 'Technik', position: 1 },
  { id: 'cat-news', user_id: 'user-1', name: 'Weltgeschehen', position: 0 },
  // Another user's category: never used for user-1, even if an id pointed to it.
  { id: 'cat-foreign', user_id: 'user-2', name: 'Fremd', position: -1 },
]

const SUBSCRIPTIONS = [
  sub('pod-free', 'podcast', null),
  sub('yt-tech', 'youtube', 'cat-tech'),
  sub('web-news', 'website', 'cat-news'),
  sub('social-news', 'social', 'cat-news'),
  sub('pod-tech', 'podcast', 'cat-tech', BOTH),
  sub('web-foreign', 'website', 'cat-foreign'),
]

const EPISODES = [
  episode('e-pod-free', 'pod-free', '2026-10-13T01:00:00.000Z'),
  episode('e-yt-tech', 'yt-tech', '2026-10-13T02:00:00.000Z'),
  episode('e-web-news', 'web-news', '2026-10-13T03:00:00.000Z'),
  episode('e-social-news', 'social-news', '2026-10-13T00:00:00.000Z', {
    source_type: 'social', episode_newsletters: null, social_content: '<p>Post</p>', social_spoiler: null, social_media: [],
  }),
  episode('e-pod-tech', 'pod-tech', '2026-10-13T04:00:00.000Z'),
  episode('e-web-foreign', 'web-foreign', '2026-10-13T05:00:00.000Z'),
]

for (const e of EPISODES) e.source_type ??= SUBSCRIPTIONS.find((s) => s.id === e.subscription_id).source_type

function makeDb(subscriptions = SUBSCRIPTIONS, categories = CATEGORIES) {
  return makeFakeSupabase({
    podcast_subscriptions: subscriptions,
    source_categories: categories,
    episodes: EPISODES,
  })
}

function recordingMailer() {
  const mails = []
  return { mails, sendEmail: async (mail) => { mails.push(mail) } }
}

const ids = (items) => items.map((item) => item.id)

test('the daily digest is ordered by the user\'s categories, type order within, uncategorised last', async () => {
  const db = makeDb()
  const { mails, sendEmail } = recordingMailer()
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })

  const digest = mails.find((mail) => mail.mode === 'daily')
  assert.deepEqual(ids(digest.items), [
    'e-web-news', 'e-social-news', // Weltgeschehen (position 0): website before social
    'e-pod-tech', 'e-yt-tech', // Technik (position 1): podcast before YouTube
    'e-pod-free', 'e-web-foreign', // no (own) category
  ])
  const categoryOf = (id) => digest.items.find((item) => item.id === id).category
  assert.deepEqual(categoryOf('e-web-news'), { id: 'cat-news', name: 'Weltgeschehen', position: 0 })
  assert.equal(categoryOf('e-pod-free'), null)
  assert.equal(categoryOf('e-web-foreign'), null, 'a category of another user is never shown')
})

test('categories are read for the user only', async () => {
  const db = makeDb()
  const reads = []
  const from = db.from.bind(db)
  db.from = (table) => {
    const query = from(table)
    if (table !== 'source_categories') return query
    return { ...query, select: (...args) => { const b = query.select(...args); const eq = b.eq; b.eq = (c, v) => { reads.push([c, v]); return eq(c, v) }; return b } }
  }
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail: async () => {}, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
  assert.deepEqual(reads, [['user_id', 'user-1']])
})

test('categories change neither immediate mails nor claims or delivery state', async () => {
  const withCategories = makeDb()
  const without = makeDb(SUBSCRIPTIONS.map((s) => ({ ...s, category_id: null })), [])
  const runs = []
  for (const db of [withCategories, without]) {
    const { mails, sendEmail } = recordingMailer()
    const result = await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
    runs.push({
      result,
      mails: mails.map((mail) => ({ mode: mail.mode, subject: mail.subject, ids: ids(mail.items).sort() })),
      deliveries: db.data.newsletter_deliveries.map(({ episode_id, target, status }) => `${episode_id}:${target}:${status}`).sort(),
      statuses: db.data.episodes.map((e) => `${e.id}:${e.status}`).sort(),
    })
  }
  assert.deepEqual(runs[0], runs[1])
  assert.deepEqual(runs[0].mails.filter((mail) => mail.mode === 'immediate').map((mail) => mail.ids), [['e-pod-tech']])
})

test('an immediate-only send does not read categories at all', async () => {
  const db = makeDb()
  const tables = []
  const from = db.from.bind(db)
  db.from = (table) => { tables.push(table); return from(table) }
  const { mails, sendEmail } = recordingMailer()
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF })
  assert.equal(mails.length, 1)
  assert.equal(mails[0].items[0].category, null)
  assert.ok(!tables.includes('source_categories'))
})

test('after a category was deleted its sources are uncategorised and still delivered', async () => {
  // ON DELETE SET NULL (category_id): the source stays, only the assignment is gone.
  const db = makeDb(SUBSCRIPTIONS.map((s) => (s.category_id === 'cat-news' ? { ...s, category_id: null } : s)), CATEGORIES.filter((c) => c.id !== 'cat-news'))
  const { mails, sendEmail } = recordingMailer()
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
  const digest = mails.find((mail) => mail.mode === 'daily')
  assert.deepEqual(ids(digest.items), ['e-pod-tech', 'e-yt-tech', 'e-pod-free', 'e-web-news', 'e-web-foreign', 'e-social-news'])
  assert.equal(digest.items.length, EPISODES.length)
})

test('a failed category read does not hold back the digest: it is sent without categories', async () => {
  const db = makeDb()
  const from = db.from.bind(db)
  db.from = (table) => table === 'source_categories'
    ? { select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }
    : from(table)
  const { mails, sendEmail } = recordingMailer()
  await sendNewsletterToUser({ supabase: db, user: USER, sendEmail, now: NOW, recentCutoff: CUTOFF, includeDaily: true })
  const digest = mails.find((mail) => mail.mode === 'daily')
  assert.equal(digest.items.length, EPISODES.length)
  assert.ok(digest.items.every((item) => item.category === null))
})
