// Feed check stage of the worker pipeline: imports new episodes from all podcast feeds and
// YouTube channels on a fixed interval (YouTube with the yt-dlp fallback when the channel
// feed is down). New episodes are transcribed by the same loop right afterwards.

import { checkAllFeeds } from '../src/lib/feeds/check-feeds.mjs'

export async function runFeedCheck({ supabase, parseXml, now, log, fetchImpl, youtubeFallback }) {
  const summary = await checkAllFeeds({ supabase, parseXml, now, fetchImpl, youtubeFallback })
  log(summary.errors > 0 ? 'warn' : 'info', 'feed_check', summary)
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
