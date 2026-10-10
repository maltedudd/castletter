// Feed check stage of the worker pipeline: imports new episodes from all podcast feeds and
// YouTube channels on a fixed interval (YouTube with the yt-dlp fallback when the channel
// feed is down). New episodes are transcribed by the same loop right afterwards. Social posts
// need no transcription: posts of "immediate" social sources are mailed right after the check.

import { checkAllFeeds } from '../src/lib/feeds/check-feeds.mjs'
import { deliverImmediatelyIfWanted } from '../src/lib/newsletter/delivery.mjs'
import { getEpisodeAgeCutoff } from './worker-core.mjs'

export async function runFeedCheck({ supabase, parseXml, now, log, fetchImpl, youtubeFallback, sendEmail = null, config = null }) {
  const { socialUserIds = [], ...summary } = await checkAllFeeds({ supabase, parseXml, now, fetchImpl, youtubeFallback })
  log(summary.errors > 0 ? 'warn' : 'info', 'feed_check', summary)

  // Without mail delivery (newsletters disabled) the posts wait for a later send.
  if (sendEmail && config) {
    const recentCutoff = getEpisodeAgeCutoff(now(), config.maxEpisodeAgeDays)
    for (const userId of socialUserIds) {
      try {
        const mailsSent = await deliverImmediatelyIfWanted({ supabase, userId, sendEmail, now: now(), recentCutoff })
        if (mailsSent > 0) log('info', 'social_posts_sent_immediately', { userId, mailsSent })
      } catch (err) {
        // Posts stay `newsletter_ready`; the hourly send sweep retries them.
        log('error', 'immediate_send_failed', { userId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return summary
}

/**
 * Due on start and then every `intervalMs` after the last successful run. Only `markDone`
 * moves the schedule forward, so a failed run is retried on the next loop pass.
 */
export function createIntervalGate(intervalMs) {
  let lastDone = null
  return {
    isDue: (date) => lastDone === null || date.getTime() - lastDone >= intervalMs,
    markDone: (date) => { lastDone = date.getTime() },
  }
}
