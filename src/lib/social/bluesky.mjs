// Bluesky accounts as social sources (Kanban #40): parsing the entered profile URL, handle or
// DID, resolving the account over the public AT Protocol AppView without login (the profile's
// RSS feed on bsky.app as fallback) and normalising author-feed items and RSS items into the
// same posts as Mastodon (#39). The DID is the stable identity: it is stored as the account ID,
// builds the feed URL and every post link, so a handle change breaks neither the source nor
// the deduplication. Posts are passed on unchanged – no summary, no transcription.

import { fetchPublicText, PublicUrlError } from '../net/public-url.mjs'
import { detectFeedFormat } from '../websites/feed.mjs'
import { safeHttpUrl, sanitizeSocialHtml } from './sanitize.mjs'

export const SOCIAL_PLATFORM_BLUESKY = 'bluesky'

const APPVIEW = 'https://public.api.bsky.app/xrpc'
const WEB = 'https://bsky.app'
const WEB_HOSTS = ['bsky.app', 'www.bsky.app']
const AUTHOR_FEED_LIMIT = 40
const FETCH_TIMEOUT_MS = 10_000
const MAX_INPUT_CHARS = 500
const DID_PATTERN = /^did:(?:plc:[a-z2-7]{24}|web:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])$/
const HANDLE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// TLDs the AT Protocol never resolves as handles.
const DISALLOWED_TLDS = ['alt', 'arpa', 'example', 'internal', 'invalid', 'local', 'localhost', 'onion']
const INVALID_HANDLE = 'handle.invalid'
const POST_URI_PATTERN = /^at:\/\/(did:[a-z0-9:._-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]{1,512})$/
// Self-label of accounts that do not want to be shown to logged-out viewers.
const NO_UNAUTHENTICATED = '!no-unauthenticated'
// Labels for adult and graphic content become the post's content warning.
const WARNING_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media', 'gore']
// bsky.app's RSS feed replaces embeds with this line.
const RSS_EMBED_PLACEHOLDER = /^\s*\[contains quote post or other embedded content\]\s*$/gm
const JSON_ACCEPT = { Accept: 'application/json' }
const RSS_ACCEPT = { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' }

export function isBlueskyDid(value) {
  return typeof value === 'string' && DID_PATTERN.test(value)
}

function isHandle(value) {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    HANDLE_PATTERN.test(value) &&
    value !== INVALID_HANDLE &&
    !DISALLOWED_TLDS.includes(value.slice(value.lastIndexOf('.') + 1))
  )
}

/** `{ actor }` (lower-case handle or DID) of a valid handle or DID, else null. */
function toActor(value) {
  if (isBlueskyDid(value)) return { actor: value }
  const handle = value.toLowerCase()
  return isHandle(handle) ? { actor: handle } : null
}

/**
 * `{ actor }` of an entered profile URL (`https://bsky.app/profile/<handle|did>`, also with a
 * post path or without scheme), handle (`name.bsky.social`, `@name.example.org`) or DID
 * (`did:plc:…`, `did:web:…`); null for anything else, including Mastodon handles.
 */
export function parseBlueskyInput(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw || raw.length > MAX_INPUT_CHARS) return null
  if (raw.startsWith('did:')) return toActor(raw)

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (!hasScheme && !raw.includes('/')) return toActor(raw.replace(/^@/, ''))
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null

  let url
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.username || url.password || url.port || !WEB_HOSTS.includes(url.hostname)) return null
  const path = /^\/profile\/([^/]+)(?:\/.*)?$/.exec(url.pathname)
  if (!path) return null
  let actor
  try {
    actor = decodeURIComponent(path[1])
  } catch {
    return null
  }
  return toActor(actor.replace(/^@/, ''))
}

export function buildBlueskyProfileUrl(actor) {
  return `${APPVIEW}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
}

/** Own posts and own thread continuations; replies to others are left out by the AppView. */
export function buildBlueskyAuthorFeedUrl(did) {
  return `${APPVIEW}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&filter=posts_and_author_threads&limit=${AUTHOR_FEED_LIMIT}`
}

/** bsky.app's public profile feed; `actor` is a validated handle or DID (safe in the path). */
export function buildBlueskyRssUrl(actor) {
  return `${WEB}/profile/${actor}/rss`
}

export function blueskyPostUrl(did, rkey) {
  return `${WEB}/profile/${did}/post/${encodeURIComponent(rkey)}`
}

function parsePostUri(uri) {
  const match = typeof uri === 'string' ? POST_URI_PATTERN.exec(uri) : null
  return match && isBlueskyDid(match[1]) ? { did: match[1], rkey: match[2] } : null
}

function didOfUri(uri) {
  const match = typeof uri === 'string' ? /^at:\/\/(did:[^/]+)/.exec(uri) : null
  return match ? match[1] : null
}

function httpsUrl(value) {
  const url = safeHttpUrl(value)
  return url && url.startsWith('https:') ? url : null
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function labelValues(labels) {
  return (Array.isArray(labels) ? labels : []).map((label) => label?.val).filter((value) => typeof value === 'string')
}

function hidesFromLoggedOut(account) {
  return labelValues(account?.labels).includes(NO_UNAUTHENTICATED)
}

function verifiedHandle(value) {
  const handle = typeof value === 'string' ? value.toLowerCase() : ''
  return isHandle(handle) ? handle : null
}

/** Link target of a rich-text facet feature, or null (unknown feature, unsafe URI). */
function facetHref(feature) {
  switch (feature?.$type) {
    case 'app.bsky.richtext.facet#link':
      return safeHttpUrl(feature.uri ?? '')
    case 'app.bsky.richtext.facet#mention':
      return isBlueskyDid(feature.did) ? `${WEB}/profile/${feature.did}` : null
    case 'app.bsky.richtext.facet#tag':
      return typeof feature.tag === 'string' && feature.tag.trim() ? `${WEB}/hashtag/${encodeURIComponent(feature.tag.trim())}` : null
    default:
      return null
  }
}

const isCharBoundary = (bytes, index) => index === bytes.length || (bytes[index] & 0xc0) !== 0x80

/**
 * HTML of a post's plain text with its rich-text facets (links, mentions, hashtags). Facet
 * ranges are UTF-8 byte offsets; overlapping, out-of-range or unsafe facets stay plain text.
 * Blank lines separate paragraphs, single line breaks become `<br>`. The result still goes
 * through sanitizeSocialHtml before it is stored.
 */
export function blueskyTextToHtml(text, facets = []) {
  if (typeof text !== 'string' || !text.trim()) return ''
  const bytes = Buffer.from(text, 'utf8')
  const ranges = (Array.isArray(facets) ? facets : [])
    .map((facet) => {
      const start = facet?.index?.byteStart
      const end = facet?.index?.byteEnd
      const href = (Array.isArray(facet?.features) ? facet.features : []).map(facetHref).find(Boolean)
      if (!href || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > bytes.length) return null
      if (!isCharBoundary(bytes, start) || !isCharBoundary(bytes, end)) return null
      return { start, end, href }
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)

  let html = ''
  let position = 0
  for (const range of ranges) {
    if (range.start < position) continue
    html += escapeHtml(bytes.subarray(position, range.start).toString('utf8'))
    const label = bytes.subarray(range.start, range.end).toString('utf8').replace(/\s+/g, ' ')
    html += `<a href="${escapeHtml(range.href)}">${escapeHtml(label)}</a>`
    position = range.end
  }
  html += escapeHtml(bytes.subarray(position).toString('utf8'))

  return html
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** A quoted post as a media link (no quoted text); null for other records or hidden authors. */
function quoteMedia(record) {
  if (record?.$type !== 'app.bsky.embed.record#viewRecord' || hidesFromLoggedOut(record.author)) return null
  const target = parsePostUri(record.uri)
  if (!target) return null
  const handle = verifiedHandle(record.author?.handle)
  return { type: 'quote', url: blueskyPostUrl(target.did, target.rkey), previewUrl: null, description: handle ? `@${handle}` : null }
}

/** Images, video, link card and quoted post of an embed view (https URLs only). */
function embedMedia(embed, postUrl) {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view':
      return (Array.isArray(embed.images) ? embed.images : [])
        .map((image) => {
          const url = httpsUrl(image?.fullsize ?? '')
          return url ? { type: 'image', url, previewUrl: httpsUrl(image.thumb ?? ''), description: cleanText(image.alt) } : null
        })
        .filter(Boolean)
    case 'app.bsky.embed.video#view':
      // The video itself is an HLS playlist; mails and the archive link to the post instead.
      return [{ type: 'video', url: postUrl, previewUrl: httpsUrl(embed.thumbnail ?? ''), description: cleanText(embed.alt) }]
    case 'app.bsky.embed.external#view': {
      const url = httpsUrl(embed.external?.uri ?? '')
      return url ? [{ type: 'link', url, previewUrl: httpsUrl(embed.external.thumb ?? ''), description: cleanText(embed.external.title) }] : []
    }
    case 'app.bsky.embed.record#view':
      return [quoteMedia(embed.record)].filter(Boolean)
    case 'app.bsky.embed.recordWithMedia#view':
      return [...embedMedia(embed.media, postUrl), quoteMedia(embed.record?.record)].filter(Boolean)
    default:
      return []
  }
}

/** Content warning from self-labels of the record and labels on the post, or null. */
function warningOf(post) {
  const values = [...labelValues(post.record?.labels?.values), ...labelValues(post.labels)]
  const warnings = [...new Set(values.filter((value) => WARNING_LABELS.includes(value)))]
  return warnings.length > 0 ? warnings.join(', ') : null
}

/**
 * Normalised post of an author-feed item (`app.bsky.feed.defs#feedViewPost`) of the account
 * `did`, or null without a post URI or time. Reposts and posts by other authors count as
 * boosts; replies count as replies to others unless parent and root are the author's own.
 */
export function normalizeBlueskyFeedItem(item, { did }) {
  const post = item?.post
  const target = parsePostUri(post?.uri)
  const publishedAt = toIsoDate(post?.record?.createdAt) ?? toIsoDate(post?.indexedAt)
  if (!target || !publishedAt) return null

  const url = blueskyPostUrl(target.did, target.rkey)
  const reply = post.record?.reply
  return {
    guid: url,
    url,
    publishedAt,
    html: sanitizeSocialHtml(blueskyTextToHtml(post.record?.text, post.record?.facets)),
    spoiler: warningOf(post),
    media: embedMedia(post.embed, url),
    isBoost: item.reason?.$type === 'app.bsky.feed.defs#reasonRepost' || target.did !== did || post.author?.did !== did,
    isReplyToOther: Boolean(reply) && (didOfUri(reply.parent?.uri) !== did || didOfUri(reply.root?.uri) !== did),
    visibility: 'public',
  }
}

/**
 * Normalised post of an item of bsky.app's profile feed (rss-parser output), or null when its
 * GUID is not a post of `did`. The feed holds plain text without embeds and already leaves out
 * reposts and replies.
 */
export function normalizeBlueskyRssItem(item, { did }) {
  const target = parsePostUri(item?.guid)
  const publishedAt = toIsoDate(item?.isoDate ?? item?.pubDate)
  if (!target || target.did !== did || !publishedAt) return null
  const url = blueskyPostUrl(target.did, target.rkey)
  const text = typeof item.content === 'string' ? item.content : typeof item.description === 'string' ? item.description : ''
  return {
    guid: url,
    url,
    publishedAt,
    html: sanitizeSocialHtml(blueskyTextToHtml(text.replace(RSS_EMBED_PLACEHOLDER, ''))),
    spoiler: null,
    media: [],
    isBoost: false,
    isReplyToOther: false,
    visibility: 'public',
  }
}

/** DID of the account behind a parsed profile feed (from the item GUIDs), or null. */
function didOfFeed(feed) {
  const dids = new Set((feed?.items ?? []).map((item) => parsePostUri(item?.guid)?.did).filter(Boolean))
  return dids.size === 1 ? [...dids][0] : null
}

/** Handle in the channel link of the profile feed (`https://bsky.app/profile/<handle>`), or null. */
function handleOfFeed(feed) {
  const match = /^https:\/\/bsky\.app\/profile\/([^/]+)\/?$/.exec(typeof feed?.link === 'string' ? feed.link.trim() : '')
  return match ? verifiedHandle(match[1]) : null
}

function preview({ did, handle, title, description, imageUrl }) {
  return {
    title: cleanText(title)?.slice(0, 200) ?? (handle ? `@${handle}` : did),
    description: cleanText(description)?.slice(0, 1000) ?? null,
    imageUrl,
    feedUrl: buildBlueskyRssUrl(did),
    handle: handle ?? did,
    accountId: did,
    platform: SOCIAL_PLATFORM_BLUESKY,
  }
}

/**
 * Resolves the entered profile for the "add source" preview: `app.bsky.actor.getProfile`
 * (resolves the handle) first, the profile's RSS feed as fallback. Only accounts with a DID
 * are accepted – it is stored as `accountId` and builds `feedUrl`, so the source survives
 * handle changes. Accounts that hide from logged-out viewers are refused.
 *
 * @param {{ input: unknown, fetchImpl?: typeof fetch, lookup?: any, parseXml: (xml: string) => Promise<any> }} options
 * @returns {Promise<
 *   | { ok: true, preview: { title: string, description: string | null, imageUrl: string | null, feedUrl: string, handle: string, accountId: string, platform: 'bluesky' } }
 *   | { ok: false, status: number, errorKey: string }
 * >}
 */
export async function resolveBlueskyAccount({ input, fetchImpl = fetch, lookup = null, parseXml }) {
  const target = parseBlueskyInput(input)
  if (!target) return { ok: false, status: 400, errorKey: 'socialErrorInvalidInput' }
  const { actor } = target

  try {
    const page = await fetchPublicText(buildBlueskyProfileUrl(actor), { fetchImpl, lookup, headers: JSON_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
    // The AppView answers unknown, deactivated and suspended accounts with 400.
    if (page.status === 400) return { ok: false, status: 404, errorKey: 'socialErrorNotFound' }
    const profile = page.ok ? parseJson(page.text) : null
    if (profile && isBlueskyDid(profile.did)) {
      if (hidesFromLoggedOut(profile)) return { ok: false, status: 403, errorKey: 'socialErrorNotPublic' }
      return {
        ok: true,
        preview: preview({
          did: profile.did,
          handle: verifiedHandle(profile.handle),
          title: profile.displayName,
          description: profile.description,
          imageUrl: httpsUrl(profile.avatar ?? ''),
        }),
      }
    }

    const feed = await fetchPublicText(buildBlueskyRssUrl(actor), { fetchImpl, lookup, headers: RSS_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
    if (feed.ok && detectFeedFormat(feed.text) === 'rss') {
      const parsed = await parseXml(feed.text).catch(() => null)
      const did = isBlueskyDid(actor) ? actor : didOfFeed(parsed)
      if (parsed && did) {
        const handle = handleOfFeed(parsed) ?? (isBlueskyDid(actor) ? null : actor)
        // The channel title is "@handle - Display Name".
        const title = typeof parsed.title === 'string' ? parsed.title.replace(/^@\S+(?:\s+-\s+)?/, '') : null
        return { ok: true, preview: preview({ did, handle, title, description: parsed.description, imageUrl: null }) }
      }
    }
    if (page.status === 404 && feed.status === 404) return { ok: false, status: 404, errorKey: 'socialErrorNotFound' }
    return { ok: false, status: 422, errorKey: 'socialErrorFetch' }
  } catch (err) {
    if (err instanceof PublicUrlError) {
      return { ok: false, status: 400, errorKey: err.code === 'not_allowed' ? 'socialErrorNotAllowed' : 'socialErrorFetch' }
    }
    return { ok: false, status: 422, errorKey: 'socialErrorFetch' }
  }
}

class NotPublicError extends Error {}

/**
 * Posts of a Bluesky source for the feed check, read by its DID: the public author feed, or –
 * when the AppView fails – the DID-based RSS feed (then `note`). Returns `{ posts, note, handle }`
 * with the account's current verified handle when known. Throws when neither answered, when
 * the source has no valid DID or when the account hides from logged-out viewers.
 */
export async function fetchBlueskyPosts({ subscription, fetchImpl = fetch, parseXml }) {
  const did = subscription.social_account_id
  if (!isBlueskyDid(did)) throw new Error('Bluesky-Quelle ohne gültige DID')

  let apiError = null
  try {
    const page = await fetchPublicText(buildBlueskyAuthorFeedUrl(did), { fetchImpl, headers: JSON_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
    if (!page.ok) throw new Error(`HTTP ${page.status}`)
    const feed = parseJson(page.text)?.feed
    if (!Array.isArray(feed)) throw new Error('keine gültige Antwort')
    const self = feed.map((item) => item?.post?.author).find((author) => author?.did === did)
    if (hidesFromLoggedOut(self)) throw new NotPublicError('Account ist nicht öffentlich (nur mit Login sichtbar)')
    return { posts: feed.map((item) => normalizeBlueskyFeedItem(item, { did })).filter(Boolean), handle: verifiedHandle(self?.handle) ?? undefined }
  } catch (err) {
    if (err instanceof PublicUrlError || err instanceof NotPublicError) throw err
    apiError = err instanceof Error ? err.message : String(err)
  }

  const prefix = `Bluesky-API: ${apiError}; `
  const page = await fetchPublicText(buildBlueskyRssUrl(did), { fetchImpl, headers: RSS_ACCEPT, timeoutMs: FETCH_TIMEOUT_MS })
  if (!page.ok) throw new Error(`${prefix}RSS-Feed: HTTP ${page.status}`)
  let feed
  try {
    feed = await parseXml(page.text)
  } catch (err) {
    throw new Error(`${prefix}RSS-Feed ungültig: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    posts: (feed?.items ?? []).map((item) => normalizeBlueskyRssItem(item, { did })).filter(Boolean),
    note: `Bluesky-API nicht erreichbar (${apiError}) – Posts per RSS gelesen`,
    handle: handleOfFeed(feed) ?? undefined,
  }
}
