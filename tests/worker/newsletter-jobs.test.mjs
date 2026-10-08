import assert from 'node:assert/strict'
import test from 'node:test'
import { runGenerationOnce, runSendSweep, createHourlyGate } from '../../worker/newsletter-jobs.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T07:10:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString()

const MODEL_OUTPUT = '## Zusammenfassung\nKurz.\n\n## Hauptthemen\n- Thema\n\n## Wichtige Aussagen und Erkenntnisse\n- Aussage'

function makeDeps(db, overrides = {}) {
  const logs = []
  const mails = []
  return {
    logs,
    mails,
    supabase: db,
    config: { maxEpisodeAgeDays: 7, openrouter: { newsletterModel: 'google/gemini-2.5-flash' } },
    now: () => NOW,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    openrouter: { chat: { completions: { create: async () => ({ choices: [{ message: { content: MODEL_OUTPUT } }] }) } } },
    sendEmail: async (mail) => { mails.push(mail) },
    ...overrides,
  }
}

function tables({ mode = 'daily', hour = 7, episodes }) {
  return {
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: hour }],
    podcast_subscriptions: [{ id: 'sub-1', title: 'Lage der Nation', user_id: 'user-1', delivery_mode: mode }],
    episode_newsletters: [],
    episodes,
  }
}

/** The fake has no joins: expose stored newsletters on episode rows like PostgREST would. */
function withNewsletterJoin(db) {
  const originalFrom = db.from.bind(db)
  db.from = (table) => {
    if (table === 'episodes') {
      for (const row of db.data.episodes) {
        const newsletter = db.data.episode_newsletters.find((n) => n.episode_id === row.id)
        if (newsletter) row.episode_newsletters = newsletter
      }
    }
    return originalFrom(table)
  }
}

function transcribed(id, publishedDaysAgo, extra = {}) {
  return {
    id,
    title: `Episode ${id}`,
    transcript: 'Transkript',
    audio_url: `https://cdn.example/${id}.mp3`,
    subscription_id: 'sub-1',
    status: 'transcribed',
    error_message: null,
    newsletter_sent_at: null,
    published_at: daysAgo(publishedDaysAgo),
    podcast_subscriptions: { title: 'Lage der Nation', user_id: 'user-1' },
    ...extra,
  }
}

test('generation picks the oldest transcribed episode inside the cutoff (not only 48h)', async () => {
  const db = makeFakeSupabase(tables({ episodes: [transcribed('new', 1), transcribed('falcke', 4), transcribed('ancient', 30)] }))
  const deps = makeDeps(db)

  const result = await runGenerationOnce(deps)

  assert.deepEqual(result, { worked: true, outcome: 'ready' })
  const byId = Object.fromEntries(db.data.episodes.map((e) => [e.id, e]))
  assert.equal(byId.falcke.status, 'newsletter_ready')
  assert.equal(byId.new.status, 'transcribed')
  assert.equal(byId.ancient.status, 'transcribed')
  assert.equal(db.data.episode_newsletters[0].episode_id, 'falcke')
  assert.equal(deps.mails.length, 0, 'daily users get no immediate mail')
})

test('generation mails immediately for podcasts with immediate delivery', async () => {
  const db = makeFakeSupabase(tables({ mode: 'immediate', episodes: [transcribed('ep', 1)] }))
  withNewsletterJoin(db)
  const deps = makeDeps(db)

  await runGenerationOnce(deps)

  assert.equal(deps.mails.length, 1)
  assert.equal(deps.mails[0].subject, 'Lage der Nation: Episode ep')
  assert.equal(db.data.episodes[0].status, 'newsletter_sent')
  assert.ok(deps.logs.some((l) => l.msg === 'newsletter_sent_immediately'))
})

test('a failing immediate send keeps the episode ready for the sweep', async () => {
  const db = makeFakeSupabase(tables({ mode: 'immediate', episodes: [transcribed('ep', 1)] }))
  withNewsletterJoin(db)
  const deps = makeDeps(db, { sendEmail: async () => { throw new Error('Resend error: down') } })

  const result = await runGenerationOnce(deps)

  assert.equal(result.outcome, 'ready')
  assert.equal(db.data.episodes[0].status, 'newsletter_ready')
  assert.ok(deps.logs.some((l) => l.msg === 'immediate_send_failed'))
})

test('generation is idle without transcribed episodes', async () => {
  const db = makeFakeSupabase(tables({ episodes: [transcribed('done', 1, { status: 'newsletter_sent' })] }))
  assert.deepEqual(await runGenerationOnce(makeDeps(db)), { worked: false, outcome: 'idle' })
})

function readyEpisode(id, publishedDaysAgo) {
  return {
    ...transcribed(id, publishedDaysAgo),
    status: 'newsletter_ready',
    episode_newsletters: { intro: `intro ${id}`, bullet_points: [], key_takeaways: [], action_items: [], quotes: [], speakers: [], reflection: null },
  }
}

test('send sweep mails the daily digest in the user\'s hour, including episodes older than 48h', async () => {
  const db = makeFakeSupabase(tables({ hour: 7, episodes: [readyEpisode('a', 1), readyEpisode('falcke', 4)] }))
  const deps = makeDeps(db)

  const summary = await runSendSweep(deps)

  assert.deepEqual(summary, { users: 1, dailyDue: 1, mailsSent: 1, episodesSent: 2, errors: 0, staleSendingReset: 0 })
  assert.equal(deps.mails[0].subject, 'Deine neuen Podcast-Updates (2 Episoden)')
})

test('send sweep keeps daily podcasts for later outside the delivery hour', async () => {
  const db = makeFakeSupabase(tables({ hour: 9, episodes: [readyEpisode('a', 1)] }))
  const deps = makeDeps(db)

  const summary = await runSendSweep(deps)

  assert.equal(summary.dailyDue, 0)
  assert.equal(deps.mails.length, 0)
  assert.equal(db.data.episodes[0].status, 'newsletter_ready')
})

test('send sweep serves immediate podcasts every hour as fallback', async () => {
  const db = makeFakeSupabase(tables({ mode: 'immediate', hour: 3, episodes: [readyEpisode('a', 1), readyEpisode('b', 2)] }))
  const deps = makeDeps(db)

  const summary = await runSendSweep(deps)

  assert.equal(summary.mailsSent, 2)
  assert.ok(deps.mails.every((m) => m.items.length === 1))
})

test('a failing user is logged and counted, not thrown', async () => {
  const db = makeFakeSupabase(tables({ hour: 7, episodes: [readyEpisode('a', 1)] }))
  const deps = makeDeps(db, { sendEmail: async () => { throw new Error('Resend error: down') } })

  const summary = await runSendSweep(deps)

  assert.equal(summary.errors, 1)
  assert.ok(deps.logs.some((l) => l.msg === 'send_failed'))
})

test('hourly gate is due once per UTC hour and only after markDone', () => {
  const gate = createHourlyGate()
  const at = (iso) => new Date(iso)

  assert.equal(gate.isDue(at('2026-10-04T07:00:05Z')), true)
  // Sweep failed: not marked, so still due on the next pass.
  assert.equal(gate.isDue(at('2026-10-04T07:01:05Z')), true)
  gate.markDone(at('2026-10-04T07:01:05Z'))
  assert.equal(gate.isDue(at('2026-10-04T07:59:59Z')), false)
  assert.equal(gate.isDue(at('2026-10-04T08:00:00Z')), true)
})

test('send sweep with mixed podcasts: immediate always, daily digest only in the hour', async () => {
  const db = makeFakeSupabase({
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 9 }],
    podcast_subscriptions: [
      { id: 'sub-1', title: 'Lage der Nation', user_id: 'user-1', delivery_mode: 'daily' },
      { id: 'sub-2', title: 'Hotel Matze', user_id: 'user-1', delivery_mode: 'immediate' },
    ],
    episode_newsletters: [],
    episodes: [readyEpisode('daily', 1), { ...readyEpisode('now', 1), subscription_id: 'sub-2' }],
  })
  const deps = makeDeps(db)

  const summary = await runSendSweep(deps)

  assert.equal(summary.dailyDue, 0)
  assert.deepEqual(deps.mails.map((m) => m.subject), ['Hotel Matze: Episode now'])
  assert.equal(db.data.episodes.find((e) => e.id === 'daily').status, 'newsletter_ready')
})

test('send sweep creates the digest overview in the user\'s style and logs a failed overview', async () => {
  const data = tables({ hour: 7, episodes: [readyEpisode('a', 1), readyEpisode('b', 2)] })
  data.user_settings[0] = { ...data.user_settings[0], summary_tone: 'warm', summary_prompt_addition: 'Mit Beispielen' }
  const styles = []
  const overview = { summary: 'Querschnitt.', themes: [], connections: [], reflection: null, itemCount: 2 }
  const deps = makeDeps(makeFakeSupabase(data), { summarizeDigest: async (items, style) => { styles.push(style); return overview } })

  await runSendSweep(deps)

  assert.deepEqual(styles, [{ tone: 'warm', promptAddition: 'Mit Beispielen' }])
  assert.deepEqual(deps.mails[0].overview, overview)

  const failing = makeDeps(makeFakeSupabase(tables({ hour: 7, episodes: [readyEpisode('a', 1), readyEpisode('b', 2)] })), {
    summarizeDigest: async () => { throw new Error('model down') },
  })
  const summary = await runSendSweep(failing)
  assert.equal(summary.mailsSent, 1)
  assert.equal(failing.mails[0].overview, null)
  assert.ok(failing.logs.some((l) => l.msg === 'digest_overview_failed' && l.level === 'warn' && l.error === 'model down'))
})
