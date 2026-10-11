// Social sources (Kanban #39/#40) are one source type with several platforms. This module
// picks the platform of an entered profile and of a stored source and hands over to its
// client (mastodon.mjs, bluesky.mjs), which share the normalised post format.

import { fetchBlueskyPosts, isBlueskyDid, parseBlueskyInput, resolveBlueskyAccount, SOCIAL_PLATFORM_BLUESKY } from './bluesky.mjs'
import { fetchMastodonPosts, parseMastodonInput, resolveMastodonAccount, SOCIAL_PLATFORM_MASTODON } from './mastodon.mjs'

/** Platform of an entered profile URL, handle or DID; Mastodon forms are checked first. */
export function detectSocialPlatform(input) {
  if (parseMastodonInput(input)) return SOCIAL_PLATFORM_MASTODON
  if (parseBlueskyInput(input)) return SOCIAL_PLATFORM_BLUESKY
  return null
}

/**
 * Resolves the entered profile with its platform's client; see resolveMastodonAccount.
 * @param {{ input: unknown, fetchImpl?: typeof fetch, lookup?: any, parseXml: (xml: string) => Promise<any> }} options
 * @returns {Promise<
 *   | { ok: true, preview: { title: string, description: string | null, imageUrl: string | null, feedUrl: string, handle: string, accountId: string | null, platform: 'mastodon' | 'bluesky' } }
 *   | { ok: false, status: number, errorKey: string }
 * >}
 */
export async function resolveSocialAccount(options) {
  const platform = detectSocialPlatform(options.input)
  if (platform === SOCIAL_PLATFORM_MASTODON) return resolveMastodonAccount(options)
  if (platform === SOCIAL_PLATFORM_BLUESKY) return resolveBlueskyAccount(options)
  return { ok: false, status: 400, errorKey: 'socialErrorInvalidInput' }
}

/** Posts of a stored social source for the feed check: `{ posts, note?, handle? }`. */
export function fetchSocialPosts(options) {
  return options.subscription.social_platform === SOCIAL_PLATFORM_BLUESKY ? fetchBlueskyPosts(options) : fetchMastodonPosts(options)
}

/** Public profile page of a social source (Bluesky by DID, so it survives handle changes). */
export function socialProfileUrl({ social_platform, feed_url, social_account_id }) {
  if (social_platform === SOCIAL_PLATFORM_BLUESKY) {
    return isBlueskyDid(social_account_id) ? `https://bsky.app/profile/${social_account_id}` : feed_url
  }
  // Mastodon: feed_url is the profile's RSS feed (https://<instance>/@<user>.rss).
  return feed_url.replace(/\.rss$/, '')
}
