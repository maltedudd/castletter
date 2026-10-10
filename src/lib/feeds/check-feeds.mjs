// Feed check shared by the Vercel cron route and the Docker worker: reads every enabled
// source — podcast RSS feeds, YouTube channel Atom feeds and website RSS/Atom feeds — and
// stores new episodes/videos/articles as `pending_transcription`, the common entry point of the
// transcription/newsletter pipeline (website articles get their text there, without audio).
// Social posts (Mastodon) skip that pipeline: they are stored unchanged as `newsletter_ready`.
// Fetch, XML parser and Supabase client are injected so the rules run under node:test.

import crypto from 'node:crypto'
import {
  buildYouTubeFeedUrl,
  buildYouTubeWatchUrl,
  isYouTubeShort,
  parseYouTubeFeed,
  YOUTUBE_REQUEST_HEADERS,
} from '../youtube/channel.mjs'
import { getItemLink, getItemText } from '../websites/feed.mjs'
import { fetchMastodonPosts, isImportablePost } from '../social/mastodon.mjs'
import { sanitizeSocialHtml, socialPostText, socialPostTitle } from '../social/sanitize.mjs'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_NEW_EPISODES_PER_FEED = 50
const CHUNK_SIZE = 10 // Process 10 feeds in parallel
const FEED_TIMEOUT_MS = 10_000
const MAX_SUBSCRIPTIONS = 100
// Approximate upload dates (yt-dlp fallback) are only trusted when this far from the cut-off.
const APPROXIMATE_DATE_MARGIN_MS = 48 * 60 * 60 * 1000

/**
 * Checks all subscriptions (in parallel chunks). A failing feed is logged in
 * `feed_check_logs` and counted, never aborting the others.
 *
 * `parseXml(xml)` must return `{ items }` like rss-parser's `parseString`.
 * `youtubeFallback` (worker only, yt-dlp) is used when a YouTube channel feed is down:
 * `{ listUploads(channelId) → entries, fetchPublishTimes(videoIds) → { [videoId]: iso } }`.
 *
 * The summary lists `issues: [{ source, error | note }]` when any source failed or needed
 * the fallback, so logs show which source is affected, and `socialUserIds` (the owners of
 * social sources with new posts) so the caller can mail immediate posts right away.
 */
export async function checkAllFeeds({ supabase, fetchImpl = fetch, parseXml, now = () => new Date(), youtubeFallback = null }) {
  const { data: rows, error } = await supabase
    .from('podcast_subscriptions')
    .select('id, user_id, feed_url, title, created_at, source_type, youtube_channel_id, social_account_id, enabled')
    .limit(MAX_SUBSCRIPTIONS)
  if (error || !rows) {
    throw new Error(`Failed to fetch subscriptions: ${error?.message ?? 'no data'}`)
  }
  const subscriptions = rows.filter((subscription) => subscription.enabled !== false)

  /** @type {{ subscriptionsChecked: number, newEpisodes: number, errors: number, issues?: { source: string, error?: string, note?: string }[], socialUserIds?: string[] }} */
  const summary = { subscriptionsChecked: subscriptions.length, newEpisodes: 0, errors: 0 }
  const issues = []
  const socialUserIds = new Set()
  for (let i = 0; i < subscriptions.length; i += CHUNK_SIZE) {
    const chunk = subscriptions.slice(i, i + CHUNK_SIZE)
    const results = await Promise.allSettled(
      chunk.map((subscription) =>
        subscription.source_type === 'youtube'
          ? checkYouTubeChannel({ supabase, fetchImpl, subscription, now: now(), youtubeFallback })
          : subscription.source_type === 'social'
          ? checkSocialAccount({ supabase, fetchImpl, parseXml, subscription, now: now() })
          : checkSubscription({
              supabase, fetchImpl, parseXml, subscription, now: now(),
              selectItems: subscription.source_type === 'website' ? selectNewWebsiteItems : selectNewEpisodes,
            })
      )
    )
    results.forEach((result, index) => {
      const source = chunk[index].title
      if (result.status === 'fulfilled') {
        summary.newEpisodes += result.value.newEpisodes
        if (chunk[index].source_type === 'social' && result.value.newEpisodes > 0 && chunk[index].user_id) {
          socialUserIds.add(chunk[index].user_id)
        }
        if (result.value.error) {
          summary.errors++
          issues.push({ source, error: result.value.error })
        } else if (result.value.note) {
          issues.push({ source, note: result.value.note })
        }
      } else {
        summary.errors++
        issues.push({ source, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
      }
    })
  }
  if (issues.length > 0) summary.issues = issues
  if (socialUserIds.size > 0) summary.socialUserIds = [...socialUserIds]
  return summary
}

/** RSS/Atom feed of a podcast or website; `selectItems` picks the rows to import. */
async function checkSubscription({ supabase, fetchImpl, parseXml, subscription, now, selectItems }) {
  try {
    // Fetch XML manually to handle malformed feeds
    const response = await fetchImpl(subscription.feed_url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching feed`)
    }
    const feed = await parseXml(await response.text())

    // Get existing GUIDs for this subscription to check duplicates
    const { data: existingEpisodes } = await supabase
      .from('episodes')
      .select('guid')
      .eq('subscription_id', subscription.id)
    const existingGuids = new Set((existingEpisodes || []).map((e) => e.guid))

    const newEpisodes = selectItems({ items: feed.items || [], subscription, existingGuids, now })

    if (newEpisodes.length > 0) {
      // ignoreDuplicates: an overlapping run (or a GUID repeated inside the feed) must not
      // fail the whole batch on the (subscription_id, guid) unique constraint.
      const { error: insertError } = await supabase
        .from('episodes')
        .upsert(newEpisodes, { onConflict: 'subscription_id,guid', ignoreDuplicates: true })
      if (insertError) {
        throw new Error(`Insert failed: ${insertError.message}`)
      }
    }

    await supabase.from('feed_check_logs').insert({
      subscription_id: subscription.id,
      status: 'success',
      episodes_found: newEpisodes.length,
    })
    await persistCheckResult({ supabase, subscription, now })

    return { newEpisodes: newEpisodes.length }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    await supabase.from('feed_check_logs').insert({
      subscription_id: subscription.id,
      status: 'error',
      error_message: errorMessage,
    })
    await persistCheckResult({ supabase, subscription, now, error: errorMessage })

    return { newEpisodes: 0, error: errorMessage }
  }
}

/**
 * YouTube channel: reads the official channel-wide Atom feed (always built from the stored
 * channel ID) and imports each upload at most once, keyed by `yt:video:<videoId>` on the
 * existing (subscription_id, guid) unique constraint. The result of every check is also
 * persisted on the source itself (as for podcast feeds), so the UI can show an actionable error state.
 */
async function checkYouTubeChannel({ supabase, fetchImpl, subscription, now, youtubeFallback }) {
  let result
  try {
    let entries
    let note
    try {
      entries = await fetchYouTubeFeedEntries({ fetchImpl, subscription })
    } catch (feedError) {
      if (!youtubeFallback || feedError.noFallback) throw feedError
      try {
        entries = await youtubeFallback.listUploads(subscription.youtube_channel_id)
      } catch (fallbackError) {
        throw new Error(`${feedError.message}; Ausweichabruf per yt-dlp fehlgeschlagen: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
      }
      note = `${feedError.message} – Uploads per yt-dlp vom Videos-Tab gelesen`
    }

    const { data: existingEpisodes, error: existingError } = await supabase
      .from('episodes')
      .select('guid')
      .eq('subscription_id', subscription.id)
    if (existingError) throw new Error(`Vorhandene Videos konnten nicht gelesen werden: ${existingError.message}`)
    const existingGuids = new Set((existingEpisodes || []).map((e) => e.guid))

    const dated = await resolveApproximateDates({ entries, subscription, existingGuids, now, youtubeFallback })
    const candidates = selectNewYouTubeVideos({ entries: dated.entries, subscription, existingGuids, now })
    const { videos: newVideos, failures } = await dropShorts(candidates, fetchImpl)
    if (newVideos.length > 0) {
      const { error: insertError } = await supabase
        .from('episodes')
        .upsert(newVideos, { onConflict: 'subscription_id,guid', ignoreDuplicates: true })
      if (insertError) throw new Error(`Insert failed: ${insertError.message}`)
    }
    result = { newEpisodes: newVideos.length, note }
    // Held-back videos are not inserted, so the next run checks them again; nothing is lost.
    const heldBack = []
    if (dated.unresolved.length > 0) {
      heldBack.push(`Veröffentlichungsdatum für ${countVideos(dated.unresolved.length)} nicht ermittelbar (${dated.reason})`)
    }
    if (failures.length > 0) {
      heldBack.push(`Shorts-Prüfung für ${countVideos(failures.length)} fehlgeschlagen (${failures[0]})`)
    }
    if (heldBack.length > 0) {
      result.error = `${heldBack.join('; ')} – beim nächsten Lauf wird erneut geprüft`
    }
  } catch (err) {
    result = { newEpisodes: 0, error: err instanceof Error ? err.message : 'Unknown error' }
  }

  await supabase.from('feed_check_logs').insert(
    result.error
      ? { subscription_id: subscription.id, status: 'error', error_message: result.error, episodes_found: result.newEpisodes }
      : { subscription_id: subscription.id, status: 'success', episodes_found: result.newEpisodes, ...(result.note ? { error_message: result.note } : {}) }
  )
  await persistCheckResult({ supabase, subscription, now, error: result.error })

  return result
}

/**
 * Social account (Mastodon): public posts from the API, or the RSS feed as fallback (then a
 * `note`). New posts are stored unchanged and sanitised as `newsletter_ready`, so neither
 * transcription nor newsletter generation ever touches them; delivery mails them as they are.
 */
async function checkSocialAccount({ supabase, fetchImpl, parseXml, subscription, now }) {
  let result
  try {
    const { posts, note } = await fetchMastodonPosts({ subscription, fetchImpl, parseXml })

    const { data: existingEpisodes, error: existingError } = await supabase
      .from('episodes')
      .select('guid')
      .eq('subscription_id', subscription.id)
    if (existingError) throw new Error(`Vorhandene Posts konnten nicht gelesen werden: ${existingError.message}`)
    const existingGuids = new Set((existingEpisodes || []).map((e) => e.guid))

    const rows = selectNewSocialPosts({ posts, subscription, existingGuids, now })
    if (rows.length > 0) {
      const { error: insertError } = await supabase
        .from('episodes')
        .upsert(rows, { onConflict: 'subscription_id,guid', ignoreDuplicates: true })
      if (insertError) throw new Error(`Insert failed: ${insertError.message}`)
    }
    result = { newEpisodes: rows.length, note }
  } catch (err) {
    result = { newEpisodes: 0, error: err instanceof Error ? err.message : 'Unknown error' }
  }

  await supabase.from('feed_check_logs').insert(
    result.error
      ? { subscription_id: subscription.id, status: 'error', error_message: result.error }
      : { subscription_id: subscription.id, status: 'success', episodes_found: result.newEpisodes, ...(result.note ? { error_message: result.note } : {}) }
  )
  await persistCheckResult({ supabase, subscription, now, error: result.error })

  return result
}

/** Stores the latest check result on the source itself, so the sources UI can show it. */
async function persistCheckResult({ supabase, subscription, now, error }) {
  await supabase
    .from('podcast_subscriptions')
    .update({
      last_checked_at: now.toISOString(),
      last_check_status: error ? 'error' : 'success',
      last_check_error: error ?? null,
    })
    .eq('id', subscription.id)
}

/** Reads the official channel feed; throws with `noFallback` when retrying elsewhere is pointless. */
async function fetchYouTubeFeedEntries({ fetchImpl, subscription }) {
  const feedUrl = buildYouTubeFeedUrl(subscription.youtube_channel_id)
  const response = await fetchImpl(feedUrl, {
    headers: YOUTUBE_REQUEST_HEADERS,
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'YouTube-Feed nicht erreichbar (HTTP 404) – Störung bei YouTube oder Kanal gelöscht'
        : `HTTP ${response.status} beim Abruf des YouTube-Feeds`
    )
  }
  const feed = parseYouTubeFeed(await response.text())
  if (feed.channelId && feed.channelId !== subscription.youtube_channel_id) {
    throw Object.assign(
      new Error(`YouTube-Feed gehört zu Kanal ${feed.channelId} statt ${subscription.youtube_channel_id}`),
      { noFallback: true }
    )
  }
  return feed.entries
}

/**
 * Fallback entries carry approximate dates ("vor 2 Tagen"). Where that could flip the
 * cut-off decision for a not yet imported video, the exact time is looked up; videos without
 * one are held back (`unresolved`) instead of guessed.
 */
async function resolveApproximateDates({ entries, subscription, existingGuids, now, youtubeFallback }) {
  const cutoff = getImportCutoff(subscription, now).getTime()
  const nearCutoff = entries.filter((entry) => {
    if (!entry.approximate || existingGuids.has(`yt:video:${entry.videoId}`)) return false
    const published = entry.published ? new Date(entry.published).getTime() : NaN
    return Number.isNaN(published) || Math.abs(published - cutoff) <= APPROXIMATE_DATE_MARGIN_MS
  })
  if (nearCutoff.length === 0) return { entries, unresolved: [] }

  const ids = nearCutoff.map((entry) => entry.videoId)
  let exact = {}
  let reason = 'kein exaktes Datum'
  try {
    exact = await youtubeFallback.fetchPublishTimes(ids)
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  const unresolved = ids.filter((id) => !exact[id])
  const resolved = entries
    .filter((entry) => !unresolved.includes(entry.videoId))
    .map((entry) => (exact[entry.videoId] ? { ...entry, published: exact[entry.videoId], approximate: false } : entry))
  return { entries: resolved, unresolved, reason }
}

function countVideos(n) {
  return `${n} ${n === 1 ? 'Video' : 'Videos'}`
}

/**
 * Shorts are not newsletter material and are never imported. Checked sequentially (at most
 * one feed page of new videos per channel); an inconclusive check holds the video back.
 */
async function dropShorts(candidates, fetchImpl) {
  const videos = []
  const failures = []
  for (const video of candidates) {
    try {
      if (!(await isYouTubeShort({ videoId: video.youtube_video_id, fetchImpl }))) videos.push(video)
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { videos, failures }
}

/** Picks the channel uploads that should become new `pending_transcription` episodes. */
export function selectNewYouTubeVideos({ entries, subscription, existingGuids, now }) {
  const cutoffDate = getImportCutoff(subscription, now)
  const seen = new Set(existingGuids)
  const rows = []
  for (const entry of entries) {
    if (rows.length >= MAX_NEW_EPISODES_PER_FEED) break
    const guid = `yt:video:${entry.videoId}`
    const publishedAt = entry.published ? new Date(entry.published) : null
    if (!publishedAt || isNaN(publishedAt.getTime())) continue
    if (publishedAt < cutoffDate || publishedAt > now) continue
    if (seen.has(guid)) continue
    seen.add(guid)
    rows.push({
      subscription_id: subscription.id,
      guid,
      title: entry.title || 'Untitled Video',
      description: entry.description || null,
      audio_url: buildYouTubeWatchUrl(entry.videoId),
      duration_seconds: null,
      published_at: publishedAt.toISOString(),
      status: 'pending_transcription',
      source_type: 'youtube',
      youtube_video_id: entry.videoId,
    })
  }
  return rows
}

/**
 * Only pick up items published after the subscription was created (or 30 days back,
 * whichever is newer). This prevents the first feed check from importing weeks of backlog.
 */
function getImportCutoff(subscription, now) {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)
  const subscribedAt = new Date(subscription.created_at)
  return subscribedAt > thirtyDaysAgo ? subscribedAt : thirtyDaysAgo
}

/** Picks the feed items that should become new `pending_transcription` episodes. */
export function selectNewEpisodes({ items, subscription, existingGuids, now }) {
  const cutoffDate = getImportCutoff(subscription, now)
  const guidOf = (item) => item.guid || generateGuid(subscription.feed_url, item.title || '', item.pubDate || '')

  return items
    .filter((item) => {
      // Must have audio
      if (!item.enclosure?.url) return false

      const pubDate = item.pubDate ? new Date(item.pubDate) : null
      if (!pubDate || isNaN(pubDate.getTime())) return false

      // Only episodes published after subscription was created (or 30 days, whichever is newer)
      if (pubDate < cutoffDate) return false

      // Not in the future
      if (pubDate > now) return false

      return !existingGuids.has(guidOf(item))
    })
    .slice(0, MAX_NEW_EPISODES_PER_FEED)
    .map((item) => ({
      subscription_id: subscription.id,
      guid: guidOf(item),
      title: item.title || 'Untitled Episode',
      description: item.contentSnippet || item.content || null,
      audio_url: item.enclosure.url,
      duration_seconds: parseDuration(item.itunes?.duration),
      published_at: new Date(item.pubDate).toISOString(),
      status: 'pending_transcription',
    }))
}

/**
 * Picks the website feed items that should become new `pending_transcription` rows. The feed
 * text and the article link are stored with the row; the worker later decides whether the
 * feed text is complete or the public article has to be fetched. Duplicates inside the feed
 * and already imported items are skipped (key: guid › Atom id › link › hash).
 */
export function selectNewWebsiteItems({ items, subscription, existingGuids, now }) {
  const cutoffDate = getImportCutoff(subscription, now)
  const seen = new Set(existingGuids)
  const rows = []
  for (const item of items) {
    if (rows.length >= MAX_NEW_EPISODES_PER_FEED) break
    const published = item.isoDate || item.pubDate
    const publishedAt = published ? new Date(published) : null
    if (!publishedAt || isNaN(publishedAt.getTime())) continue
    if (publishedAt < cutoffDate || publishedAt > now) continue
    const articleUrl = getItemLink(item)
    const guid = firstNonEmpty(item.guid, item.id, articleUrl) || generateGuid(subscription.feed_url, item.title || '', published)
    if (seen.has(guid)) continue
    seen.add(guid)
    const text = getItemText(item)
    rows.push({
      subscription_id: subscription.id,
      guid,
      title: (item.title || '').trim() || 'Untitled Article',
      description: item.contentSnippet ? String(item.contentSnippet).slice(0, 500) : text.slice(0, 500) || null,
      // audio_url is NOT NULL for every episode row; for articles it holds the article link.
      audio_url: articleUrl ?? subscription.feed_url,
      duration_seconds: null,
      published_at: publishedAt.toISOString(),
      status: 'pending_transcription',
      source_type: 'website',
      article_url: articleUrl,
      feed_content: text || null,
    })
  }
  return rows
}

/**
 * Picks the social posts that become new `newsletter_ready` rows: no boosts, no replies to
 * other accounts (see isImportablePost), inside the import window, each post URL once.
 * `audio_url` (NOT NULL for every row) holds the link to the original post.
 */
export function selectNewSocialPosts({ posts, subscription, existingGuids, now }) {
  const cutoffDate = getImportCutoff(subscription, now)
  const seen = new Set(existingGuids)
  const rows = []
  for (const post of posts) {
    if (rows.length >= MAX_NEW_EPISODES_PER_FEED) break
    if (!isImportablePost(post)) continue
    const publishedAt = new Date(post.publishedAt)
    if (isNaN(publishedAt.getTime()) || publishedAt < cutoffDate || publishedAt > now) continue
    if (seen.has(post.guid)) continue
    seen.add(post.guid)
    const html = sanitizeSocialHtml(post.html)
    const text = socialPostText(html)
    const media = post.media ?? []
    rows.push({
      subscription_id: subscription.id,
      guid: post.guid,
      title: socialPostTitle({ text, spoiler: post.spoiler, hasMedia: media.length > 0 }),
      description: text.slice(0, 500) || null,
      audio_url: post.url,
      duration_seconds: null,
      published_at: publishedAt.toISOString(),
      status: 'newsletter_ready',
      source_type: 'social',
      social_content: html || null,
      social_spoiler: post.spoiler ?? null,
      social_media: media.length > 0 ? media : null,
    })
  }
  return rows
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null
}

/** Generate a GUID from feed URL + title + pubDate when none exists */
export function generateGuid(feedUrl, title, pubDate) {
  return crypto
    .createHash('sha256')
    .update(`${feedUrl}:${title}:${pubDate}`)
    .digest('hex')
}

/** Parse itunes:duration to seconds. Supports "HH:MM:SS", "MM:SS", or raw seconds */
export function parseDuration(duration) {
  if (!duration) return null

  if (typeof duration === 'number') return duration

  const parts = duration.split(':').map(Number)

  if (parts.some(isNaN)) return null

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  if (parts.length === 1) {
    return parts[0] // Already in seconds
  }

  return null
}
