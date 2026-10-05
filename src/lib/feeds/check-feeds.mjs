// Feed check shared by the Vercel cron route and the Docker worker: reads every enabled
// source — podcast RSS feeds and YouTube channel Atom feeds — and stores new episodes/videos
// as `pending_transcription`, the common entry point of the transcription/newsletter pipeline.
// Fetch, XML parser and Supabase client are injected so the rules run under node:test.

import crypto from 'node:crypto'
import { buildYouTubeFeedUrl, buildYouTubeWatchUrl, parseYouTubeFeed, YOUTUBE_REQUEST_HEADERS } from '../youtube/channel.mjs'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_NEW_EPISODES_PER_FEED = 50
const CHUNK_SIZE = 10 // Process 10 feeds in parallel
const FEED_TIMEOUT_MS = 10_000
const MAX_SUBSCRIPTIONS = 100

/**
 * Checks all subscriptions (in parallel chunks). A failing feed is logged in
 * `feed_check_logs` and counted, never aborting the others.
 *
 * `parseXml(xml)` must return `{ items }` like rss-parser's `parseString`.
 */
export async function checkAllFeeds({ supabase, fetchImpl = fetch, parseXml, now = () => new Date() }) {
  const { data: rows, error } = await supabase
    .from('podcast_subscriptions')
    .select('id, feed_url, title, created_at, source_type, youtube_channel_id, enabled')
    .limit(MAX_SUBSCRIPTIONS)
  if (error || !rows) {
    throw new Error(`Failed to fetch subscriptions: ${error?.message ?? 'no data'}`)
  }
  const subscriptions = rows.filter((subscription) => subscription.enabled !== false)

  const summary = { subscriptionsChecked: subscriptions.length, newEpisodes: 0, errors: 0 }
  for (let i = 0; i < subscriptions.length; i += CHUNK_SIZE) {
    const chunk = subscriptions.slice(i, i + CHUNK_SIZE)
    const results = await Promise.allSettled(
      chunk.map((subscription) =>
        subscription.source_type === 'youtube'
          ? checkYouTubeChannel({ supabase, fetchImpl, subscription, now: now() })
          : checkSubscription({ supabase, fetchImpl, parseXml, subscription, now: now() })
      )
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        summary.newEpisodes += result.value.newEpisodes
        if (result.value.error) summary.errors++
      } else {
        summary.errors++
      }
    }
  }
  return summary
}

async function checkSubscription({ supabase, fetchImpl, parseXml, subscription, now }) {
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

    const newEpisodes = selectNewEpisodes({ items: feed.items || [], subscription, existingGuids, now })

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

    return { newEpisodes: newEpisodes.length }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    await supabase.from('feed_check_logs').insert({
      subscription_id: subscription.id,
      status: 'error',
      error_message: errorMessage,
    })

    return { newEpisodes: 0, error: errorMessage }
  }
}

/**
 * YouTube channel: reads the official channel-wide Atom feed (always built from the stored
 * channel ID) and imports each upload at most once, keyed by `yt:video:<videoId>` on the
 * existing (subscription_id, guid) unique constraint. The result of every check is also
 * persisted on the source itself, so the admin UI can show an actionable error state.
 */
async function checkYouTubeChannel({ supabase, fetchImpl, subscription, now }) {
  let result
  try {
    const feedUrl = buildYouTubeFeedUrl(subscription.youtube_channel_id)
    const response = await fetchImpl(feedUrl, {
      headers: YOUTUBE_REQUEST_HEADERS,
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'YouTube-Feed nicht gefunden (HTTP 404) – Kanal gelöscht oder Channel-ID falsch'
          : `HTTP ${response.status} beim Abruf des YouTube-Feeds`
      )
    }
    const feed = parseYouTubeFeed(await response.text())
    if (feed.channelId && feed.channelId !== subscription.youtube_channel_id) {
      throw new Error(`YouTube-Feed gehört zu Kanal ${feed.channelId} statt ${subscription.youtube_channel_id}`)
    }

    const { data: existingEpisodes, error: existingError } = await supabase
      .from('episodes')
      .select('guid')
      .eq('subscription_id', subscription.id)
    if (existingError) throw new Error(`Vorhandene Videos konnten nicht gelesen werden: ${existingError.message}`)
    const existingGuids = new Set((existingEpisodes || []).map((e) => e.guid))

    const newVideos = selectNewYouTubeVideos({ entries: feed.entries, subscription, existingGuids, now })
    if (newVideos.length > 0) {
      const { error: insertError } = await supabase
        .from('episodes')
        .upsert(newVideos, { onConflict: 'subscription_id,guid', ignoreDuplicates: true })
      if (insertError) throw new Error(`Insert failed: ${insertError.message}`)
    }
    result = { newEpisodes: newVideos.length }
  } catch (err) {
    result = { newEpisodes: 0, error: err instanceof Error ? err.message : 'Unknown error' }
  }

  await supabase.from('feed_check_logs').insert(
    result.error
      ? { subscription_id: subscription.id, status: 'error', error_message: result.error }
      : { subscription_id: subscription.id, status: 'success', episodes_found: result.newEpisodes }
  )
  await supabase
    .from('podcast_subscriptions')
    .update({
      last_checked_at: now.toISOString(),
      last_check_status: result.error ? 'error' : 'success',
      last_check_error: result.error ?? null,
    })
    .eq('id', subscription.id)

  return result
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
