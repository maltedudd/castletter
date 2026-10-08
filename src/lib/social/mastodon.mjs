// Mastodon accounts as social sources (Kanban #39): parsing the entered profile URL or
// @user@instance, resolving the account over the public API without login (RSS `/@user.rss`
// as fallback) and normalising API statuses and RSS items into posts. Posts are passed on
// unchanged – no summary, no transcription – after their HTML went through the sanitizer.
// Fetch, DNS lookup and XML parser are injected so everything runs under node:test.

import { fetchPublicText, isPrivateHost, PublicUrlError } from '../net/public-url.mjs'
import { detectFeedFormat } from '../websites/feed.mjs'
import { htmlToText } from '../websites/html.mjs'
import { safeHttpUrl, sanitizeSocialHtml } from './sanitize.mjs'

export const SOCIAL_PLATFORM_MASTODON = 'mastodon'
/** rss-parser `customFields` that keep Media RSS attachments of Mastodon feed items. */
export const MASTODON_RSS_CUSTOM_FIELDS = { item: [['media:content', 'mediaContent', { keepArray: true }]] }

const STATUSES_LIMIT = 40
const FETCH_TIMEOUT_MS = 10_000
const MAX_INPUT_CHARS = 500
const USERNAME = '[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?'
const HOSTNAME = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}'
const HANDLE_PATTERN = new RegExp(`^@?(${USERNAME})@(${HOSTNAME})$`)
const PROFILE_PATH_PATTERN = new RegExp(`^/(?:@(${USERNAME})(?:@(${HOSTNAME}))?|users/(${USERNAME}))(?:/[^?#]*)?/?$`)
const IMPORTED_VISIBILITIES = ['public', 'unlisted']
const JSON_ACCEPT = { Accept: 'application/json' }
const RSS_ACCEPT = { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' }
// Mastodon puts the content warning of a post in front of its RSS description.
const RSS_CONTENT_WARNING = /^\s*<p>\s*<strong>[^<]*<\/strong>([\s\S]*?)<\/p>\s*<hr\s*\/?>/i

/**
 * `{ username, host }` of an entered handle (`@user@instance`, `user@instance`) or profile URL
 * (`https://instance/@user`, `/@user/<post>`, `/users/user`, `/@user@home-instance`), or null.
 */
export function parseMastodonInput(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > MAX_INPUT_CHARS) return null

  const handle = HANDLE_PATTERN.exec(raw)
  if (handle) return publicAccount(handle[1], handle[2])

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null
  let url
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.port) return null
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const path = PROFILE_PATH_PATTERN.exec(pathname)
  if (!path) return null
  // `/@user@home` is a remote profile shown on another instance: the account lives at `home`.
  return publicAccount(path[1] ?? path[3], path[2] ?? url.hostname)
}

function publicAccount(username, host) {
  const hostname = host.toLowerCase()
  if (!new RegExp(`^${HOSTNAME}$`).test(hostname) || isPrivateHost(hostname)) return null
  return { username, host: hostname }
}

export function buildMastodonLookupUrl({ username, host }) {
  return `https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`
}

export function buildMastodonRssUrl(origin, username) {
  return `${origin}/@${username}.rss`
}

/** Public posts of an account; boosts and replies to others are excluded by the server. */
export function buildMastodonStatusesUrl(origin, accountId) {
  return `${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?exclude_replies=true&exclude_reblogs=true&limit=${STATUSES_LIMIT}`
}

function httpsUrl(value) {
  const url = safeHttpUrl(value)
  return url && url.startsWith('https:') ? url : null
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Normalised post of an API status, or null without a public http(s) link or a time.
 * `isReplyToOther` is false for thread continuations (replies to the author's own posts).
 */
export function normalizeMastodonStatus(status) {
  if (!status || typeof status !== 'object') return null
  const url = safeHttpUrl(status.url ?? '') ?? safeHttpUrl(status.uri ?? '')
  const publishedAt = toIsoDate(status.created_at)
  if (!url || !publishedAt) return null

  const media = (Array.isArray(status.media_attachments) ? status.media_attachments : [])
    .map((attachment) => {
      const mediaUrl = httpsUrl(attachment?.url ?? '') ?? httpsUrl(attachment?.remote_url ?? '')
      if (!mediaUrl) return null
      return {
        type: cleanText(attachment.type) ?? 'unknown',
        url: mediaUrl,
        previewUrl: httpsUrl(attachment.preview_url ?? ''),
        description: cleanText(attachment.description),
      }
    })
    .filter(Boolean)
  const cardUrl = httpsUrl(status.card?.url ?? '')
  if (cardUrl) {
    media.push({ type: 'link', url: cardUrl, previewUrl: httpsUrl(status.card.image ?? ''), description: cleanText(status.card.title) })
  }

  const ownAccountId = status.account?.id
  return {
    guid: url,
    url,
    publishedAt,
    html: sanitizeSocialHtml(status.content ?? ''),
    spoiler: cleanText(status.spoiler_text),
    media,
    isBoost: Boolean(status.reblog),
    isReplyToOther: Boolean(status.in_reply_to_id) && (ownAccountId == null || status.in_reply_to_account_id !== ownAccountId),
    visibility: cleanText(status.visibility) ?? 'public',
  }
}

/**
 * Default filter: no boosts, no replies to other accounts (thread continuations stay) and
 * only public/unlisted posts.
 */
export function isImportablePost(post) {
  return Boolean(post) && !post.isBoost && !post.isReplyToOther && IMPORTED_VISIBILITIES.includes(post.visibility)
}

/**
 * Normalised post of an item of the profile's RSS feed (rss-parser output with
 * MASTODON_RSS_CUSTOM_FIELDS), or null when it does not link to a post on `origin`.
 * Mastodon's feed already leaves out boosts and replies to others.
 */
export function normalizeMastodonRssItem(item, { origin }) {
  const url = safeHttpUrl(item?.guid ?? '') ?? safeHttpUrl(item?.link ?? '')
  const publishedAt = toIsoDate(item?.isoDate ?? item?.pubDate)
  if (!url || !publishedAt || new URL(url).origin !== origin) return null

  let html = typeof item.content === 'string' ? item.content : typeof item.description === 'string' ? item.description : ''
  let spoiler = null
  const warning = RSS_CONTENT_WARNING.exec(html)
  if (warning) {
    spoiler = cleanText(htmlToText(warning[1]))
    html = html.slice(warning[0].length)
  }

  const media = (Array.isArray(item.mediaContent) ? item.mediaContent : [])
    .map((entry) => {
      const mediaUrl = httpsUrl(entry?.$?.url ?? '')
      if (!mediaUrl) return null
      const description = entry['media:description']?.[0]
      return {
        type: cleanText(entry.$.medium) ?? 'unknown',
        url: mediaUrl,
        previewUrl: httpsUrl(entry['media:thumbnail']?.[0]?.$?.url ?? ''),
        description: cleanText(typeof description === 'string' ? description : description?._),
      }
    })
    .filter(Boolean)

  return { guid: url, url, publishedAt, html: sanitizeSocialHtml(html), spoiler, media, isBoost: false, isReplyToOther: false, visibility: 'public' }
}

function toIsoDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Resolves the entered profile for the "add source" preview: public API lookup first, the
 * profile's RSS feed as fallback (then without account ID, the feed check reads RSS only).
 * `feedUrl` (the RSS feed on the instance that answered) identifies the source.
 *
 * @param {{ input: unknown, fetchImpl?: typeof fetch, lookup?: any, parseXml: (xml: string) => Promise<any> }} options
 * @returns {Promise<
 *   | { ok: true, preview: { title: string, description: string | null, imageUrl: string | null, feedUrl: string, handle: string, accountId: string | null, platform: 'mastodon' } }
 *   | { ok: false, status: number, errorKey: string }
 * >}
 */
export async function resolveMastodonAccount({ input, fetchImpl = fetch, lookup = null, parseXml }) {
  const target = parseMastodonInput(input)
  if (!target) return { ok: false, status: 400, errorKey: 'socialErrorInvalidInput' }
  const handle = `${target.username}@${target.host}`

  try {
    const page = await fetchPublicText(buildMastodonLookupUrl(target), { fetchImpl, lookup, headers: JSON_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
    const account = page.ok ? parseJson(page.text) : null
    if (account && typeof account.username === 'string' && account.id != null) {
      const origin = new URL(page.url).origin
      const note = typeof account.note === 'string' ? htmlToText(account.note).slice(0, 1000) : ''
      return {
        ok: true,
        preview: {
          title: cleanText(account.display_name)?.slice(0, 200) ?? `@${handle}`,
          description: note || null,
          imageUrl: httpsUrl(account.avatar ?? ''),
          feedUrl: buildMastodonRssUrl(origin, account.username),
          handle,
          accountId: String(account.id),
          platform: SOCIAL_PLATFORM_MASTODON,
        },
      }
    }

    const feed = await fetchPublicText(buildMastodonRssUrl(`https://${target.host}`, target.username), { fetchImpl, lookup, headers: RSS_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
    if (feed.ok && detectFeedFormat(feed.text) === 'rss') {
      const parsed = await parseXml(feed.text).catch(() => null)
      if (parsed) {
        const description = cleanText(parsed.description)
        return {
          ok: true,
          preview: {
            title: cleanText(htmlToText(parsed.title ?? ''))?.slice(0, 200) ?? `@${handle}`,
            description: description ? htmlToText(description).slice(0, 1000) : null,
            imageUrl: httpsUrl(parsed.image?.url ?? ''),
            feedUrl: feed.url,
            handle,
            accountId: null,
            platform: SOCIAL_PLATFORM_MASTODON,
          },
        }
      }
    }
    if (page.status === 404 && feed.status === 404) return { ok: false, status: 404, errorKey: 'socialErrorNotFound' }
    return { ok: false, status: 422, errorKey: 'socialErrorFetch' }
  } catch (err) {
    if (err instanceof PublicUrlError) {
      return { ok: false, status: 400, errorKey: err.code === 'not_allowed' ? 'socialErrorNotAllowed' : err.code === 'invalid_url' ? 'socialErrorInvalidInput' : 'socialErrorFetch' }
    }
    return { ok: false, status: 422, errorKey: 'socialErrorFetch' }
  }
}

/**
 * Posts of a social source for the feed check: the public API when the account ID is known,
 * otherwise – or when the API fails – the RSS feed in `feed_url`. Returns `{ posts, note }`;
 * `note` says the API failed and RSS was used. Throws when neither answered. Every request goes
 * through `fetchPublicText`, so a manipulated `feed_url` never reaches an internal host.
 */
export async function fetchMastodonPosts({ subscription, fetchImpl = fetch, parseXml }) {
  let origin
  try {
    origin = new URL(subscription.feed_url).origin
  } catch {
    throw new Error(`Ungültige Feed-URL: ${subscription.feed_url}`)
  }

  let apiError = null
  if (subscription.social_account_id) {
    try {
      const page = await fetchPublicText(buildMastodonStatusesUrl(origin, subscription.social_account_id), { fetchImpl, headers: JSON_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
      if (!page.ok) throw new Error(`HTTP ${page.status}`)
      const statuses = parseJson(page.text)
      if (!Array.isArray(statuses)) throw new Error('keine gültige Antwort')
      return { posts: statuses.map(normalizeMastodonStatus).filter(Boolean) }
    } catch (err) {
      if (err instanceof PublicUrlError) throw err
      apiError = err instanceof Error ? err.message : String(err)
    }
  }

  const prefix = apiError ? `Mastodon-API: ${apiError}; ` : ''
  const page = await fetchPublicText(subscription.feed_url, { fetchImpl, headers: RSS_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
  if (!page.ok) throw new Error(`${prefix}RSS-Feed: HTTP ${page.status}`)
  let feed
  try {
    feed = await parseXml(page.text)
  } catch (err) {
    throw new Error(`${prefix}RSS-Feed ungültig: ${err instanceof Error ? err.message : String(err)}`)
  }
  const posts = (feed?.items ?? []).map((item) => normalizeMastodonRssItem(item, { origin })).filter(Boolean)
  return apiError
    ? { posts, note: `Mastodon-API nicht erreichbar (${apiError}) – Posts per RSS gelesen` }
    : { posts }
}
