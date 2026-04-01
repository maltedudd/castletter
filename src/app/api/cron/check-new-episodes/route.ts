import { NextRequest, NextResponse } from 'next/server'
import Parser from 'rss-parser'
import crypto from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

const parser = new Parser()

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const MAX_NEW_EPISODES_PER_FEED = 50
const CHUNK_SIZE = 10 // Process 10 feeds in parallel

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  let totalNewEpisodes = 0
  let totalErrors = 0

  try {
    // Fetch all subscriptions
    const { data: subscriptions, error: subError } = await supabase
      .from('podcast_subscriptions')
      .select('id, feed_url, title, created_at')
      .limit(100)

    if (subError || !subscriptions) {
      return NextResponse.json(
        { error: 'Failed to fetch subscriptions', details: subError?.message },
        { status: 500 }
      )
    }

    // Process feeds in chunks
    for (let i = 0; i < subscriptions.length; i += CHUNK_SIZE) {
      const chunk = subscriptions.slice(i, i + CHUNK_SIZE)
      const results = await Promise.allSettled(
        chunk.map((sub) => processSubscription(supabase, sub))
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalNewEpisodes += result.value.newEpisodes
          if (result.value.error) totalErrors++
        } else {
          totalErrors++
        }
      }
    }

    return NextResponse.json({
      success: true,
      subscriptionsChecked: subscriptions.length,
      newEpisodes: totalNewEpisodes,
      errors: totalErrors,
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Cron job failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

interface Subscription {
  id: string
  feed_url: string
  title: string
  created_at: string
}

async function processSubscription(
  supabase: ReturnType<typeof createAdminClient>,
  subscription: Subscription
): Promise<{ newEpisodes: number; error?: string }> {
  try {
    // Fetch XML manually to handle malformed feeds
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const response = await fetch(subscription.feed_url, { signal: controller.signal })
    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching feed`)
    }

    const xml = await response.text()
    const feed = await parser.parseString(xml)
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)
    // Only pick up episodes published after the subscription was created.
    // This prevents the first feed check from importing weeks of backlog.
    const subscribedAt = new Date(subscription.created_at)
    const cutoffDate = subscribedAt > thirtyDaysAgo ? subscribedAt : thirtyDaysAgo

    // Get existing GUIDs for this subscription to check duplicates
    const { data: existingEpisodes } = await supabase
      .from('episodes')
      .select('guid')
      .eq('subscription_id', subscription.id)

    const existingGuids = new Set(
      (existingEpisodes || []).map((e: { guid: string }) => e.guid)
    )

    // Filter and prepare new episodes
    const newEpisodes = (feed.items || [])
      .filter((item) => {
        // Must have audio
        if (!item.enclosure?.url) return false

        // Parse publish date
        const pubDate = item.pubDate ? new Date(item.pubDate) : null
        if (!pubDate || isNaN(pubDate.getTime())) return false

        // Only episodes published after subscription was created (or 30 days, whichever is newer)
        if (pubDate < cutoffDate) return false

        // Not in the future
        if (pubDate > now) return false

        // Deduplicate
        const guid = item.guid || generateGuid(subscription.feed_url, item.title || '', item.pubDate || '')
        if (existingGuids.has(guid)) return false

        return true
      })
      .slice(0, MAX_NEW_EPISODES_PER_FEED)
      .map((item) => ({
        subscription_id: subscription.id,
        guid: item.guid || generateGuid(subscription.feed_url, item.title || '', item.pubDate || ''),
        title: item.title || 'Untitled Episode',
        description: item.contentSnippet || item.content || null,
        audio_url: item.enclosure!.url,
        duration_seconds: parseDuration(item.itunes?.duration),
        published_at: new Date(item.pubDate!).toISOString(),
        status: 'pending_transcription',
      }))

    // Insert new episodes
    if (newEpisodes.length > 0) {
      const { error: insertError } = await supabase
        .from('episodes')
        .insert(newEpisodes)

      if (insertError) {
        throw new Error(`Insert failed: ${insertError.message}`)
      }
    }

    // Log success
    await supabase.from('feed_check_logs').insert({
      subscription_id: subscription.id,
      status: 'success',
      episodes_found: newEpisodes.length,
    })

    return { newEpisodes: newEpisodes.length }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    // Log error
    await supabase.from('feed_check_logs').insert({
      subscription_id: subscription.id,
      status: 'error',
      error_message: errorMessage,
    })

    return { newEpisodes: 0, error: errorMessage }
  }
}

/** Generate a GUID from feed URL + title + pubDate when none exists */
function generateGuid(feedUrl: string, title: string, pubDate: string): string {
  return crypto
    .createHash('sha256')
    .update(`${feedUrl}:${title}:${pubDate}`)
    .digest('hex')
}

/** Parse itunes:duration to seconds. Supports "HH:MM:SS", "MM:SS", or raw seconds */
function parseDuration(duration: string | number | undefined): number | null {
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
