// Newsletter delivery shared by the worker / send cron (daily digests + immediate fallback)
// and the generation step (immediate sends). The delivery mode is chosen per podcast
// subscription (`podcast_subscriptions.delivery_mode`). Dependency-free: the Supabase client and the mail sender
// are injected so claim/release behaviour can be tested without a database or Resend.

import { MIN_OVERVIEW_ITEMS, sortDigestItems } from './digest.mjs'
import { normalizeSummaryStyle } from './summary-style.mjs'

export const DELIVERY_MODES = ['daily', 'immediate']
export const DEFAULT_DELIVERY_MODE = 'daily'

// A `newsletter_sending` claim older than this means the run died between claiming and
// marking the episode sent; the send cron hands it back to `newsletter_ready`.
export const SENDING_LEASE_MS = 15 * 60 * 1000

const NEWSLETTER_COLUMNS =
  'id, title, audio_url, subscription_id, published_at, source_type, ' +
  'episode_newsletters!inner(intro, bullet_points, key_takeaways, action_items, quotes, speakers, reflection)'

export function normalizeDeliveryMode(mode) {
  return DELIVERY_MODES.includes(mode) ? mode : DEFAULT_DELIVERY_MODE
}

/** The daily digest of a user is due in their UTC delivery hour. */
export function isDailyDigestDue(settings, currentHourUTC) {
  return settings.newsletter_delivery_hour === currentHourUTC
}

export function buildNewsletterSubject(items, mode) {
  if (normalizeDeliveryMode(mode) === 'immediate' && items.length === 1) {
    return `${items[0].podcastTitle}: ${items[0].episodeTitle}`
  }
  return `Deine neuen Podcast-Updates (${items.length} ${items.length === 1 ? 'Episode' : 'Episoden'})`
}

/**
 * Claims episodes for sending with a compare-and-swap on `newsletter_ready`, so the send
 * cron and an immediate send from the generate cron never mail the same episode twice.
 * The claim time is kept in `newsletter_sent_at` (overwritten once actually sent).
 */
export async function claimEpisodesForSending(supabase, episodeIds, now = new Date()) {
  if (episodeIds.length === 0) return []
  const { data, error } = await supabase
    .from('episodes')
    .update({ status: 'newsletter_sending', newsletter_sent_at: now.toISOString() })
    .in('id', episodeIds)
    .eq('status', 'newsletter_ready')
    .select('id')
  if (error) throw new Error(`Episoden konnten nicht für den Versand reserviert werden: ${error.message}`)
  return (data ?? []).map((row) => row.id)
}

/**
 * Records one sent mail for the archive. Returns its id, or null when the record could not be
 * written – the mail is out already, so this must never fail the send.
 */
async function recordSentMail(supabase, { userId, mode, subject, episodeCount, now }) {
  try {
    const { data, error } = await supabase
      .from('newsletter_mails')
      .insert({ user_id: userId, mode, subject, episode_count: episodeCount, sent_at: now.toISOString() })
      .select('id')
    if (error) return null
    return data?.[0]?.id ?? null
  } catch {
    return null
  }
}

async function markEpisodesSent(supabase, episodeIds, now, mailId) {
  const { error } = await supabase
    .from('episodes')
    .update({
      status: 'newsletter_sent',
      newsletter_sent_at: now.toISOString(),
      ...(mailId ? { newsletter_mail_id: mailId } : {}),
    })
    .in('id', episodeIds)
    .eq('status', 'newsletter_sending')
    .select('id')
  if (error) throw new Error(`Episoden konnten nicht als versendet markiert werden: ${error.message}`)
}

async function releaseEpisodes(supabase, episodeIds) {
  await supabase
    .from('episodes')
    .update({ status: 'newsletter_ready', newsletter_sent_at: null })
    .in('id', episodeIds)
    .eq('status', 'newsletter_sending')
    .select('id')
}

/** Hands claims of crashed runs back to `newsletter_ready`. Returns how many were reset. */
export async function resetStaleSendingEpisodes(supabase, now = new Date()) {
  const cutoff = new Date(now.getTime() - SENDING_LEASE_MS).toISOString()
  const { data, error } = await supabase
    .from('episodes')
    .update({ status: 'newsletter_ready', newsletter_sent_at: null })
    .eq('status', 'newsletter_sending')
    .lt('newsletter_sent_at', cutoff)
    .select('id')
  if (error) throw new Error(`Hängende Versand-Reservierungen konnten nicht zurückgesetzt werden: ${error.message}`)
  return data?.length ?? 0
}

function toNewsletterItem(episode, podcastTitle) {
  const newsletter = Array.isArray(episode.episode_newsletters)
    ? episode.episode_newsletters[0]
    : episode.episode_newsletters

  return {
    id: episode.id,
    podcastTitle,
    episodeTitle: episode.title,
    intro: newsletter?.intro || '',
    bulletPoints: newsletter?.bullet_points || [],
    keyTakeaways: newsletter?.key_takeaways || [],
    actionItems: newsletter?.action_items || [],
    quotes: newsletter?.quotes || [],
    speakers: newsletter?.speakers || [],
    reflection: newsletter?.reflection || null,
    audioUrl: episode.audio_url,
    sourceType: episode.source_type ?? 'podcast',
    publishedAt: episode.published_at ?? null,
  }
}

/**
 * Sends the user's ready newsletters according to each podcast's delivery mode: one mail per
 * episode for `immediate` podcasts (always), one digest of all `daily` podcasts' episodes
 * only when `includeDaily` is set (the user's delivery hour). `episodeIds` restricts the send
 * to specific episodes (the immediate send right after generation). Only episodes this call
 * claimed are mailed; a failed send releases its claim and rethrows.
 *
 * `sendEmail({ to, subject, items, mode, overview })` must throw if the mail was not accepted;
 * `mode` ('immediate' | 'daily') selects the mail's introduction text. Items are in digest
 * order (podcast → YouTube → website, then publication time; see digest.mjs).
 *
 * `summarizeDigest(items, style)` (optional) creates the overview of a daily digest with at
 * least MIN_OVERVIEW_ITEMS items in the user's style (`user.summary_tone`,
 * `user.summary_prompt_addition`). If it fails, the digest is sent without an overview and
 * `onOverviewError(err)` is told – the overview never holds back a delivery.
 *
 * Every sent mail is recorded in `newsletter_mails` (the archive) and its episodes point to it.
 * If that record fails, the episodes are still marked sent – never mailed twice – and
 * `archiveErrors` counts the miss.
 */
export async function sendNewsletterToUser({
  supabase, user, sendEmail, now = new Date(), recentCutoff, episodeIds = null, includeDaily = false,
  summarizeDigest = null, onOverviewError = () => {},
}) {
  const result = { mailsSent: 0, episodesSent: 0 }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('podcast_subscriptions')
    .select('id, title, delivery_mode')
    .eq('user_id', user.user_id)
  if (subscriptionError) throw new Error(`Abos konnten nicht gelesen werden: ${subscriptionError.message}`)
  if (!subscriptions || subscriptions.length === 0) return result

  const subscriptionsById = new Map(subscriptions.map((s) => [s.id, s]))
  const modeOf = (episode) => normalizeDeliveryMode(subscriptionsById.get(episode.subscription_id)?.delivery_mode)

  // Recent episodes only, so a resumed run never mails an old backlog.
  let query = supabase
    .from('episodes')
    .select(NEWSLETTER_COLUMNS)
    .eq('status', 'newsletter_ready')
    .gte('published_at', recentCutoff)
    .in('subscription_id', [...subscriptionsById.keys()])
  if (episodeIds) query = query.in('id', episodeIds)
  const { data: episodes, error: episodeError } = await query.order('published_at', { ascending: true })
  if (episodeError) throw new Error(`Episoden konnten nicht gelesen werden: ${episodeError.message}`)
  if (!episodes || episodes.length === 0) return result

  const immediate = episodes.filter((episode) => modeOf(episode) === 'immediate')
  const daily = episodes.filter((episode) => modeOf(episode) === 'daily')
  const batches = immediate.map((episode) => ({ mode: 'immediate', episodes: [episode] }))
  if (includeDaily && daily.length > 0) batches.push({ mode: 'daily', episodes: daily })

  for (const batch of batches) {
    const claimedIds = new Set(await claimEpisodesForSending(supabase, batch.episodes.map((e) => e.id), now))
    const claimed = batch.episodes.filter((episode) => claimedIds.has(episode.id))
    if (claimed.length === 0) continue

    const items = sortDigestItems(claimed.map((episode) =>
      toNewsletterItem(episode, subscriptionsById.get(episode.subscription_id)?.title || 'Podcast')
    ))
    const ids = claimed.map((episode) => episode.id)
    const subject = buildNewsletterSubject(items, batch.mode)

    let overview = null
    if (batch.mode === 'daily' && summarizeDigest && items.length >= MIN_OVERVIEW_ITEMS) {
      try {
        overview = (await summarizeDigest(items, normalizeSummaryStyle(user))) ?? null
      } catch (err) {
        try { onOverviewError(err) } catch { /* reporting must not block the delivery */ }
      }
    }

    try {
      await sendEmail({ to: user.newsletter_email, subject, items, mode: batch.mode, overview })
    } catch (err) {
      await releaseEpisodes(supabase, ids)
      throw err
    }

    const mailId = await recordSentMail(supabase, { userId: user.user_id, mode: batch.mode, subject, episodeCount: ids.length, now })
    if (!mailId) result.archiveErrors = (result.archiveErrors ?? 0) + 1
    await markEpisodesSent(supabase, ids, now, mailId)
    result.mailsSent++
    result.episodesSent += ids.length
  }

  return result
}

/**
 * Right after a newsletter was generated: mails it if its podcast is set to immediate
 * delivery. Returns the number of mails sent (0 for daily podcasts or missing settings).
 */
export async function deliverImmediatelyIfWanted({ supabase, userId, episodeId, sendEmail, now = new Date(), recentCutoff }) {
  if (!userId) return 0

  const { data: settings, error } = await supabase
    .from('user_settings')
    .select('user_id, newsletter_email')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Einstellungen konnten nicht gelesen werden: ${error.message}`)
  if (!settings) return 0

  // includeDaily stays off: an episode of a daily podcast waits for the digest.
  const { mailsSent } = await sendNewsletterToUser({
    supabase, user: settings, sendEmail, now, recentCutoff, episodeIds: [episodeId],
  })
  return mailsSent
}
