// Newsletter delivery shared by the worker / send cron (daily digests + immediate fallback)
// and the generation step (immediate sends). Every source has two independent delivery
// targets – immediate mail and daily digest (Kanban #43, see delivery-targets.mjs) – and each
// target of an episode is claimed and marked sent on its own in `newsletter_deliveries`.
// Dependency-free: the Supabase client and the mail sender are injected so claim/release
// behaviour can be tested without a database or Resend.

import { isPodcastOnly, MIN_OVERVIEW_ITEMS, sortDigestItems } from './digest.mjs'
import { wantedTargetsOf } from './delivery-targets.mjs'
import { categoryOf } from '../sources/categories.mjs'
import { normalizeSummaryStyle } from './summary-style.mjs'

export const DELIVERY_MODES = ['daily', 'immediate']
export const DEFAULT_DELIVERY_MODE = 'daily'

// A delivery claim (`newsletter_deliveries.status = 'sending'`, or a legacy episode in
// `newsletter_sending`) older than this means the run died between claiming and marking it
// sent; the send cron hands it back.
export const SENDING_LEASE_MS = 15 * 60 * 1000

// Left join: social posts (Kanban #39) are mailed unchanged and have no newsletter row; every
// other episode still needs one (see hasDeliverableContent).
const NEWSLETTER_COLUMNS =
  'id, title, audio_url, subscription_id, published_at, source_type, social_content, social_spoiler, social_media, ' +
  'episode_newsletters(intro, bullet_points, key_takeaways, action_items, quotes, speakers, reflection)'

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
  // Only a pure podcast digest is named after podcasts; any other mix is source-neutral.
  if (isPodcastOnly(items)) {
    return `Deine neuen Podcast-Updates (${items.length} ${items.length === 1 ? 'Episode' : 'Episoden'})`
  }
  return `Dein Castletter: ${items.length} ${items.length === 1 ? 'neuer Inhalt' : 'neue Inhalte'}`
}

/**
 * Claims one delivery target of episodes: one `newsletter_deliveries` row per (episode,
 * target), inserted with ON CONFLICT DO NOTHING. Only the rows this call inserted come back,
 * so the send cron and an immediate send from the generation step never mail the same
 * episode to the same target twice. Returns the claimed episode ids.
 */
export async function claimDeliveries(supabase, { userId, episodeIds, target, now = new Date() }) {
  if (episodeIds.length === 0) return []
  const rows = episodeIds.map((episodeId) => ({
    user_id: userId,
    episode_id: episodeId,
    target,
    status: 'sending',
    claimed_at: now.toISOString(),
  }))
  const { data, error } = await supabase
    .from('newsletter_deliveries')
    .upsert(rows, { onConflict: 'episode_id,target', ignoreDuplicates: true })
    .select('episode_id')
  if (error) throw new Error(`Episoden konnten nicht für den Versand reserviert werden: ${error.message}`)
  return (data ?? []).map((row) => row.episode_id)
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

async function markDeliveriesSent(supabase, { episodeIds, target, now, mailId }) {
  const { error } = await supabase
    .from('newsletter_deliveries')
    .update({ status: 'sent', sent_at: now.toISOString(), mail_id: mailId })
    .in('episode_id', episodeIds)
    .eq('target', target)
    .eq('status', 'sending')
    .select('id')
  if (error) throw new Error(`Episoden konnten nicht als versendet markiert werden: ${error.message}`)
  if (!mailId) return
  // Legacy pointer to the latest mail, read by code from before Kanban #43.
  await supabase
    .from('episodes')
    .update({ newsletter_mail_id: mailId })
    .in('id', episodeIds)
    .select('id')
}

async function releaseDeliveries(supabase, { episodeIds, target }) {
  await supabase
    .from('newsletter_deliveries')
    .delete()
    .in('episode_id', episodeIds)
    .eq('target', target)
    .eq('status', 'sending')
}

/**
 * An episode is `newsletter_sent` once every target its source wants has been mailed; until
 * then it stays `newsletter_ready` (e.g. sent immediately, waiting for the digest).
 */
async function markEpisodesComplete(supabase, episodeIds, now) {
  if (episodeIds.length === 0) return
  const { error } = await supabase
    .from('episodes')
    .update({ status: 'newsletter_sent', newsletter_sent_at: now.toISOString() })
    .in('id', episodeIds)
    .eq('status', 'newsletter_ready')
    .select('id')
  if (error) throw new Error(`Episoden konnten nicht als versendet markiert werden: ${error.message}`)
}

/**
 * Hands claims of crashed runs back: delivery rows still `sending` after the lease are removed
 * (that target is retried), legacy episode claims from before Kanban #43 go back to
 * `newsletter_ready`. Returns how many were reset.
 */
export async function resetStaleSendingEpisodes(supabase, now = new Date()) {
  const cutoff = new Date(now.getTime() - SENDING_LEASE_MS).toISOString()
  const { data: deliveries, error: deliveryError } = await supabase
    .from('newsletter_deliveries')
    .delete()
    .eq('status', 'sending')
    .lt('claimed_at', cutoff)
    .select('id')
  if (deliveryError) throw new Error(`Hängende Versand-Reservierungen konnten nicht zurückgesetzt werden: ${deliveryError.message}`)

  const { data, error } = await supabase
    .from('episodes')
    .update({ status: 'newsletter_ready', newsletter_sent_at: null })
    .eq('status', 'newsletter_sending')
    .lt('newsletter_sent_at', cutoff)
    .select('id')
  if (error) throw new Error(`Hängende Versand-Reservierungen konnten nicht zurückgesetzt werden: ${error.message}`)
  return (deliveries?.length ?? 0) + (data?.length ?? 0)
}

/** Delivery rows of episodes: `Map<episodeId, Map<target, status>>`. */
async function loadDeliveries(supabase, episodeIds) {
  const { data, error } = await supabase
    .from('newsletter_deliveries')
    .select('episode_id, target, status')
    .in('episode_id', episodeIds)
  if (error) throw new Error(`Zustellstatus konnte nicht gelesen werden: ${error.message}`)
  const byEpisode = new Map()
  for (const row of data ?? []) {
    if (!byEpisode.has(row.episode_id)) byEpisode.set(row.episode_id, new Map())
    byEpisode.get(row.episode_id).set(row.target, row.status)
  }
  return byEpisode
}

function newsletterOf(episode) {
  return (Array.isArray(episode.episode_newsletters) ? episode.episode_newsletters[0] : episode.episode_newsletters) ?? null
}

/** Social posts are mailed as they are; everything else only with its stored newsletter. */
function hasDeliverableContent(episode) {
  return episode.source_type === 'social' || newsletterOf(episode) !== null
}

/**
 * The user's source categories by id (Kanban #48). They only order the digest, so a failed read
 * sends the digest without categories instead of holding it back.
 */
async function loadCategories(supabase, userId) {
  const { data, error } = await supabase
    .from('source_categories')
    .select('id, name, position')
    .eq('user_id', userId)
  if (error) return new Map()
  return new Map((data ?? []).map((category) => [category.id, category]))
}

function toNewsletterItem(episode, subscription, categoriesById) {
  const newsletter = newsletterOf(episode)

  const item = {
    id: episode.id,
    podcastTitle: subscription?.title || 'Podcast',
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
    category: categoryOf(subscription, categoriesById),
  }
  if (episode.source_type === 'social') {
    // The original post (sanitised HTML), its content warning and media – never summarised.
    item.social = {
      html: episode.social_content ?? '',
      spoiler: episode.social_spoiler ?? null,
      media: Array.isArray(episode.social_media) ? episode.social_media : [],
    }
  }
  return item
}

/**
 * Sends the user's ready newsletters according to each source's delivery targets (Kanban #43):
 * one mail per episode for sources with immediate delivery (always), one digest of all
 * episodes of sources with daily delivery only when `includeDaily` is set (the user's delivery
 * hour). A source with both targets gets both – the immediate mail never uses up the digest
 * entry. `episodeIds` restricts the send to specific episodes (the immediate send right after
 * generation). Each target is claimed per episode; only claims of this call are mailed, and a
 * failed send releases its claims and rethrows. An episode becomes `newsletter_sent` once all
 * of its source's targets are delivered.
 *
 * `sendEmail({ to, subject, items, mode, overview })` must throw if the mail was not accepted;
 * `mode` ('immediate' | 'daily') selects the mail's introduction text. Items are in digest
 * order: by the user's source categories (uncategorised last, Kanban #48), within each
 * podcasts, YouTube, Website (RSS), Social, each chronological (see sortDigestItems). Every
 * item carries its `category` ({ id, name, position } or null); categories are only read for a
 * digest and change nothing about claims or delivery state.
 *
 * `summarizeDigest(items, style)` (optional) creates the overview of a daily digest with at
 * least MIN_OVERVIEW_ITEMS items in the user's style (`user.summary_tone`,
 * `user.summary_prompt_addition`). If it fails, the digest is sent without an overview and
 * `onOverviewError(err)` is told – the overview never holds back a delivery.
 *
 * Every sent mail is recorded in `newsletter_mails` (the archive); its delivery rows point to
 * it. If that record fails, the deliveries are still marked sent – never mailed twice – and
 * `archiveErrors` counts the miss.
 */
export async function sendNewsletterToUser({
  supabase, user, sendEmail, now = new Date(), recentCutoff, episodeIds = null, includeDaily = false,
  summarizeDigest = null, onOverviewError = () => {},
}) {
  const result = { mailsSent: 0, episodesSent: 0 }

  const { data: subscriptions, error: subscriptionError } = await supabase
    .from('podcast_subscriptions')
    .select('id, title, delivery_mode, deliver_immediately, deliver_daily, category_id')
    .eq('user_id', user.user_id)
  if (subscriptionError) throw new Error(`Abos konnten nicht gelesen werden: ${subscriptionError.message}`)
  if (!subscriptions || subscriptions.length === 0) return result

  const subscriptionsById = new Map(subscriptions.map((s) => [s.id, s]))
  const wantedOf = (episode) => wantedTargetsOf(subscriptionsById.get(episode.subscription_id))

  // Recent episodes only, so a resumed run never mails an old backlog.
  let query = supabase
    .from('episodes')
    .select(NEWSLETTER_COLUMNS)
    .eq('status', 'newsletter_ready')
    .gte('published_at', recentCutoff)
    .in('subscription_id', [...subscriptionsById.keys()])
  if (episodeIds) query = query.in('id', episodeIds)
  const { data: rows, error: episodeError } = await query.order('published_at', { ascending: true })
  if (episodeError) throw new Error(`Episoden konnten nicht gelesen werden: ${episodeError.message}`)
  const episodes = (rows ?? []).filter(hasDeliverableContent)
  if (episodes.length === 0) return result

  // Targets already claimed or sent are skipped; the rest is open.
  const deliveries = await loadDeliveries(supabase, episodes.map((episode) => episode.id))
  const stateOf = (episode, target) => deliveries.get(episode.id)?.get(target) ?? null
  const isOpen = (target) => (episode) => wantedOf(episode).includes(target) && stateOf(episode, target) === null
  const isComplete = (episode) => wantedOf(episode).every((target) => stateOf(episode, target) === 'sent')

  // Everything delivered already (e.g. a target was switched off after the other one was sent).
  await markEpisodesComplete(supabase, episodes.filter(isComplete).map((episode) => episode.id), now)

  const immediate = episodes.filter(isOpen('immediate'))
  const daily = episodes.filter(isOpen('daily'))
  const batches = immediate.map((episode) => ({ mode: 'immediate', episodes: [episode] }))
  if (includeDaily && daily.length > 0) batches.push({ mode: 'daily', episodes: daily })
  const categoriesById = includeDaily && daily.length > 0 ? await loadCategories(supabase, user.user_id) : new Map()

  for (const batch of batches) {
    const claimedIds = new Set(await claimDeliveries(supabase, {
      userId: user.user_id, episodeIds: batch.episodes.map((e) => e.id), target: batch.mode, now,
    }))
    const claimed = batch.episodes.filter((episode) => claimedIds.has(episode.id))
    if (claimed.length === 0) continue

    const items = sortDigestItems(claimed.map((episode) =>
      toNewsletterItem(episode, subscriptionsById.get(episode.subscription_id), categoriesById)
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
      await releaseDeliveries(supabase, { episodeIds: ids, target: batch.mode })
      throw err
    }

    const mailId = await recordSentMail(supabase, { userId: user.user_id, mode: batch.mode, subject, episodeCount: ids.length, now })
    if (!mailId) result.archiveErrors = (result.archiveErrors ?? 0) + 1
    await markDeliveriesSent(supabase, { episodeIds: ids, target: batch.mode, now, mailId })
    // Read back: a concurrent run may have delivered the other target in the meantime.
    for (const [id, targets] of await loadDeliveries(supabase, ids)) deliveries.set(id, targets)
    await markEpisodesComplete(supabase, claimed.filter(isComplete).map((episode) => episode.id), now)
    result.mailsSent++
    result.episodesSent += ids.length
  }

  return result
}

/**
 * Right after a newsletter was generated: mails it if its source has immediate delivery on.
 * Without `episodeId` (after a feed check imported social posts) every ready episode of the
 * user's immediate sources is mailed. Returns the number of mails sent (0 for daily-only
 * sources or missing settings).
 */
export async function deliverImmediatelyIfWanted({ supabase, userId, episodeId = null, sendEmail, now = new Date(), recentCutoff }) {
  if (!userId) return 0

  const { data: settings, error } = await supabase
    .from('user_settings')
    .select('user_id, newsletter_email')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Einstellungen konnten nicht gelesen werden: ${error.message}`)
  if (!settings) return 0

  // includeDaily stays off: the daily target of an episode waits for the digest.
  const { mailsSent } = await sendNewsletterToUser({
    supabase, user: settings, sendEmail, now, recentCutoff, episodeIds: episodeId ? [episodeId] : null,
  })
  return mailsSent
}
