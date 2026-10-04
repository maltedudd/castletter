// Feed check shared by the Vercel cron route and the Docker worker: reads every podcast
// subscription's RSS feed and stores new episodes as `pending_transcription`.
// Fetch, XML parser and Supabase client are injected so the rules run under node:test.

import crypto from 'node:crypto'

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
  const { data: subscriptions, error } = await supabase
    .from('podcast_subscriptions')
    .select('id, feed_url, title, created_at')
    .limit(MAX_SUBSCRIPTIONS)
  if (error || !subscriptions) {
    throw new Error(`Failed to fetch subscriptions: ${error?.message ?? 'no data'}`)
  }

  const summary = { subscriptionsChecked: subscriptions.length, newEpisodes: 0, errors: 0 }
  for (let i = 0; i < subscriptions.length; i += CHUNK_SIZE) {
    const chunk = subscriptions.slice(i, i + CHUNK_SIZE)
    const results = await Promise.allSettled(
      chunk.map((subscription) => checkSubscription({ supabase, fetchImpl, parseXml, subscription, now: now() }))
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

/** Picks the feed items that should become new `pending_transcription` episodes. */
export function selectNewEpisodes({ items, subscription, existingGuids, now }) {
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)
  // Only pick up episodes published after the subscription was created.
  // This prevents the first feed check from importing weeks of backlog.
  const subscribedAt = new Date(subscription.created_at)
  const cutoffDate = subscribedAt > thirtyDaysAgo ? subscribedAt : thirtyDaysAgo
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
