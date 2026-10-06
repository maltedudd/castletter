// YouTube channel sources: turning admin input (channel ID, channel URL, @handle) into a
// stable channel ID, and reading the official channel-wide Atom feed. Dependency-free and
// fetch-injected, shared by the Next.js resolve route, the feed check and the worker.
//
// Only fixed https://www.youtube.com URLs built from validated IDs/paths are fetched, never a
// user-supplied host, so this needs no SSRF guard.

const YOUTUBE_ORIGIN = 'https://www.youtube.com'
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const HANDLE_PATTERN = /^[\p{L}\p{N}._-]{1,100}$/u
const LEGACY_NAME_PATTERN = /^[\p{L}\p{N}._-]{1,100}$/u
const FETCH_TIMEOUT_MS = 10_000

// Without these cookies, requests from EU servers are redirected to the consent page.
export const YOUTUBE_REQUEST_HEADERS = {
  Cookie: 'SOCS=CAI; CONSENT=YES+',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent': 'Mozilla/5.0 (compatible; Castletter/1.0; +https://castletter.io)',
}

/** Resolution failure with a machine-readable `code` for the API route / UI. */
export class YouTubeChannelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'YouTubeChannelError'
    this.code = code
  }
}

export function isYouTubeChannelId(value) {
  return typeof value === 'string' && CHANNEL_ID_PATTERN.test(value)
}

export function isYouTubeVideoId(value) {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value)
}

export function buildYouTubeFeedUrl(channelId) {
  if (!isYouTubeChannelId(channelId)) throw new Error(`Ungültige YouTube-Channel-ID: ${channelId}`)
  return `${YOUTUBE_ORIGIN}/feeds/videos.xml?channel_id=${channelId}`
}

export function buildYouTubeWatchUrl(videoId) {
  if (!isYouTubeVideoId(videoId)) throw new Error(`Ungültige YouTube-Video-ID: ${videoId}`)
  return `${YOUTUBE_ORIGIN}/watch?v=${videoId}`
}

/**
 * Classifies admin input without network access:
 * - `{ kind: 'channel_id', channelId }` for a raw ID, /channel/<id> URL or feed URL,
 * - `{ kind: 'page', path }` for @handles and legacy /c/ or /user/ URLs (needs a page lookup),
 * - `{ kind: 'invalid' }` for everything else (videos, playlists, other hosts).
 */
export function parseChannelInput(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (!input) return { kind: 'invalid' }
  if (isYouTubeChannelId(input)) return { kind: 'channel_id', channelId: input }
  if (input.startsWith('@')) return handleResult(input.slice(1))

  let url
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    return { kind: 'invalid' }
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return { kind: 'invalid' }

  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode)
  const [first, second] = segments
  if (first === 'channel' && isYouTubeChannelId(second)) return { kind: 'channel_id', channelId: second }
  if (first === 'feeds' && second === 'videos.xml') {
    const channelId = url.searchParams.get('channel_id')
    return isYouTubeChannelId(channelId) ? { kind: 'channel_id', channelId } : { kind: 'invalid' }
  }
  if (first?.startsWith('@')) return handleResult(first.slice(1))
  if ((first === 'c' || first === 'user') && second && LEGACY_NAME_PATTERN.test(second)) {
    return { kind: 'page', path: `/${first}/${encodeURIComponent(second)}` }
  }
  return { kind: 'invalid' }
}

function handleResult(handle) {
  return HANDLE_PATTERN.test(handle) ? { kind: 'page', path: `/@${encodeURIComponent(handle)}` } : { kind: 'invalid' }
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Resolves admin input to `{ channelId, title, description, thumbnailUrl, feedUrl }`.
 * The channel feed is always fetched, so a stored source is known to have a readable feed.
 */
export async function resolveYouTubeChannel({ input, fetchImpl = fetch }) {
  const parsed = parseChannelInput(input)
  if (parsed.kind === 'invalid') {
    throw new YouTubeChannelError(
      'invalid_input',
      'Bitte gib eine YouTube-Channel-ID (UC…), eine Kanal-URL oder ein @Handle ein. Video- und Playlist-Links werden nicht unterstützt.'
    )
  }

  let channelId = parsed.kind === 'channel_id' ? parsed.channelId : null
  let pageMeta = { title: null, description: null, thumbnailUrl: null }

  if (parsed.kind === 'page') {
    const html = await fetchYouTubeText(fetchImpl, `${YOUTUBE_ORIGIN}${parsed.path}`)
    if (html === null) throw new YouTubeChannelError('channel_not_found', 'Kanal nicht gefunden – bitte Handle bzw. URL prüfen.')
    channelId = extractChannelIdFromHtml(html)
    if (!channelId) {
      throw new YouTubeChannelError('channel_not_found', 'Auf der Kanalseite wurde keine Channel-ID gefunden – bitte die Channel-ID (UC…) direkt eingeben.')
    }
    pageMeta = extractChannelMetaFromHtml(html)
  } else {
    // Best effort: avatar and description only exist on the channel page, not in the feed.
    const html = await fetchYouTubeText(fetchImpl, `${YOUTUBE_ORIGIN}/channel/${channelId}`).catch(() => null)
    if (html) pageMeta = extractChannelMetaFromHtml(html)
  }

  const feedUrl = buildYouTubeFeedUrl(channelId)
  let feed
  try {
    const xml = await fetchYouTubeText(fetchImpl, feedUrl)
    if (xml === null) throw new Error('nicht gefunden')
    feed = parseYouTubeFeed(xml)
  } catch (err) {
    throw new YouTubeChannelError(
      'feed_unavailable',
      `Der YouTube-Feed dieses Kanals ist nicht abrufbar (${err instanceof Error ? err.message : 'unbekannt'}).`
    )
  }

  return {
    channelId,
    title: feed.title || pageMeta.title || channelId,
    description: pageMeta.description,
    thumbnailUrl: pageMeta.thumbnailUrl,
    feedUrl,
  }
}

/**
 * Shorts are not marked in the Atom feed. `/shorts/<id>` serves Shorts directly (200) and
 * redirects regular videos to `/watch` (303). Any other answer (rate limit, consent page,
 * deleted video) is inconclusive and throws, so the caller can retry later.
 */
export async function isYouTubeShort({ videoId, fetchImpl = fetch }) {
  if (!isYouTubeVideoId(videoId)) throw new Error(`Ungültige YouTube-Video-ID: ${videoId}`)
  const response = await fetchImpl(`${YOUTUBE_ORIGIN}/shorts/${videoId}`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: YOUTUBE_REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (response.status === 200) return true
  const location = response.headers?.get?.('location') ?? ''
  if (response.status >= 300 && response.status < 400 && /^https:\/\/www\.youtube\.com\/watch\?/.test(location)) {
    return false
  }
  throw new Error(`HTTP ${response.status}`)
}

/** GET with consent cookies; resolves `null` for 404, throws for other failures. */
async function fetchYouTubeText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: YOUTUBE_REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

export function extractChannelIdFromHtml(html) {
  const patterns = [
    /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
    /<meta[^>]+itemprop="(?:identifier|channelId)"[^>]+content="(UC[A-Za-z0-9_-]{22})"/,
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    /<meta[^>]+property="og:url"[^>]+content="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) return match[1]
  }
  return null
}

export function extractChannelMetaFromHtml(html) {
  const meta = (property) => {
    const match = html.match(new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]*)"`))
    return match ? decodeXml(match[1]).trim() || null : null
  }
  return {
    title: meta('og:title'),
    thumbnailUrl: meta('og:image'),
    description: meta('og:description'),
  }
}

/**
 * Parses YouTube's channel Atom feed (`/feeds/videos.xml?channel_id=…`) into
 * `{ channelId, title, entries: [{ videoId, title, published, description, thumbnailUrl }] }`.
 * The format is small and stable, so a targeted parser avoids an XML dependency in the worker.
 */
export function parseYouTubeFeed(xml) {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) {
    throw new Error('Kein gültiger YouTube-Feed (kein Atom-<feed>)')
  }
  const firstEntry = xml.search(/<entry[\s>]/)
  const head = firstEntry === -1 ? xml : xml.slice(0, firstEntry)

  const entries = []
  for (const match of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)) {
    const body = match[1]
    const idFromEntry = textOf(body, 'id')?.match(/^yt:video:(.+)$/)?.[1]
    const videoId = textOf(body, 'yt:videoId') || idFromEntry
    if (!isYouTubeVideoId(videoId)) continue
    entries.push({
      videoId,
      title: textOf(body, 'title') || textOf(body, 'media:title') || '',
      published: textOf(body, 'published'),
      description: textOf(body, 'media:description') || null,
      thumbnailUrl: attrOf(body, 'media:thumbnail', 'url'),
    })
  }

  return {
    channelId: normalizeFeedChannelId(textOf(head, 'yt:channelId')),
    title: textOf(head, 'title'),
    entries,
  }
}

/**
 * The feed head carries the channel ID without its "UC" prefix (`<yt:channelId>Dx6L…`),
 * the entries with it. Restores the stable form; anything else is returned unchanged so a
 * real mismatch is still detected.
 */
function normalizeFeedChannelId(value) {
  if (!value || isYouTubeChannelId(value)) return value
  return isYouTubeChannelId(`UC${value}`) ? `UC${value}` : value
}

function textOf(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  if (!match) return null
  const raw = match[1]
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return (cdata ? cdata[1] : decodeXml(raw)).trim() || null
}

function attrOf(xml, tag, attr) {
  const match = xml.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`))
  return match ? decodeXml(match[1]) : null
}

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]
  })
}
