// Newsletter part of the worker pipeline: generate newsletters for transcribed episodes
// (followed by an immediate send for users who want it) and an hourly send sweep for daily
// digests. Side effects are injected like in worker-core.mjs.

import {
  generateNewsletterForEpisode,
  getPodcastRef,
  resetStaleGeneratingEpisodes,
} from '../src/lib/newsletter/generate.mjs'
import {
  deliverImmediatelyIfWanted,
  isDailyDigestDue,
  resetStaleSendingEpisodes,
  sendNewsletterToUser,
} from '../src/lib/newsletter/delivery.mjs'
import { getEpisodeAgeCutoff } from './worker-core.mjs'

const GENERATION_COLUMNS =
  'id, title, transcript, published_at, error_message, source_type, podcast_subscriptions!inner(title, user_id)'

/**
 * Generates the newsletter for the oldest `transcribed` episode inside the age cutoff and
 * mails it right away if its podcast is set to immediate delivery. Returns `{ worked }` so the loop
 * keeps going while there is a backlog.
 */
export async function runGenerationOnce(deps) {
  const { supabase, config, now, log, openrouter, sendEmail } = deps
  const cutoff = getEpisodeAgeCutoff(now(), config.maxEpisodeAgeDays)

  const staleReset = await resetStaleGeneratingEpisodes(supabase, cutoff, now())
  if (staleReset > 0) log('info', 'stale_generation_reset', { count: staleReset })

  const { data: candidates, error } = await supabase
    .from('episodes')
    .select(GENERATION_COLUMNS)
    .eq('status', 'transcribed')
    .gte('published_at', cutoff)
    .order('published_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`transcribed-Episoden konnten nicht gelesen werden: ${error.message}`)

  const episode = candidates?.[0]
  if (!episode) return { worked: false, outcome: 'idle' }

  const startedAt = Date.now()
  const outcome = await generateNewsletterForEpisode({
    supabase,
    openrouter,
    model: config.openrouter.newsletterModel,
    episode,
    now: now(),
  })
  log(outcome === 'ready' ? 'info' : 'warn', `newsletter_${outcome}`, {
    episodeId: episode.id,
    title: episode.title,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  })

  if (outcome === 'ready') {
    try {
      const mailsSent = await deliverImmediatelyIfWanted({
        supabase,
        userId: getPodcastRef(episode)?.user_id,
        episodeId: episode.id,
        sendEmail,
        now: now(),
        recentCutoff: cutoff,
      })
      if (mailsSent > 0) log('info', 'newsletter_sent_immediately', { episodeId: episode.id })
    } catch (err) {
      // Episode stays `newsletter_ready`; the next send sweep retries it.
      log('error', 'immediate_send_failed', { episodeId: episode.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { worked: true, outcome }
}

/**
 * For every user: episodes of immediate podcasts that could not be mailed right after
 * generation (fallback), plus the digest of their daily podcasts once their UTC delivery
 * hour has come – with the integrated overview in the user's style when `summarizeDigest`
 * is set. Errors for one user do not stop the others.
 */
export async function runSendSweep(deps) {
  const { supabase, config, now, log, sendEmail, summarizeDigest = null } = deps
  const currentHourUTC = now().getUTCHours()
  const cutoff = getEpisodeAgeCutoff(now(), config.maxEpisodeAgeDays)

  const staleSendingReset = await resetStaleSendingEpisodes(supabase, now())

  const { data: users, error } = await supabase
    .from('user_settings')
    .select('user_id, newsletter_email, newsletter_delivery_hour, summary_tone, summary_prompt_addition')
  if (error) throw new Error(`Einstellungen konnten nicht gelesen werden: ${error.message}`)

  const summary = { users: 0, dailyDue: 0, mailsSent: 0, episodesSent: 0, errors: 0, staleSendingReset }
  for (const user of users ?? []) {
    const includeDaily = isDailyDigestDue(user, currentHourUTC)
    summary.users++
    if (includeDaily) summary.dailyDue++
    try {
      const result = await sendNewsletterToUser({
        supabase, user, sendEmail, now: now(), recentCutoff: cutoff, includeDaily, summarizeDigest,
        onOverviewError: (err) => log('warn', 'digest_overview_failed', {
          userId: user.user_id, error: err instanceof Error ? err.message : String(err),
        }),
      })
      summary.mailsSent += result.mailsSent
      summary.episodesSent += result.episodesSent
    } catch (err) {
      summary.errors++
      log('error', 'send_failed', { userId: user.user_id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  log('info', 'send_sweep', { hourUTC: currentHourUTC, ...summary })
  return summary
}

/**
 * Lets the send sweep run like an hourly cron: due once per UTC hour (and right after
 * start). The hour only counts as done after `markDone`, so a failed sweep is retried on
 * the next loop pass instead of skipping that hour's digests.
 */
export function createHourlyGate() {
  let doneKey = null
  const keyOf = (date) => date.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  return {
    isDue: (date) => keyOf(date) !== doneKey,
    markDone: (date) => { doneKey = keyOf(date) },
  }
}
