// Website (RSS) sources: recognising RSS/Atom feeds of public websites, telling them apart from
// podcast and YouTube feeds, and judging whether a feed item carries the complete text.
// Pure functions over rss-parser output and raw XML/HTML, shared by the validate route and the
// feed check.

import { htmlToText } from './html.mjs'

// A feed text shorter than this is treated as an excerpt and the linked article is fetched.
export const MIN_FULL_FEED_TEXT_CHARS = 1500
// Below this length an article page has no usable main text (teaser, paywall, error page).
export const MIN_ARTICLE_TEXT_CHARS = 800
const MAX_STORED_TEXT_CHARS = 200_000

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i
const TRUNCATION_TAIL = /(…|\.\.\.|\[…\]|\[\.\.\.\]|\(…\)|\(\.\.\.\))\s*$/
const READ_MORE = /\b(read more|continue reading|keep reading|read the (full|rest)|full (story|article)|weiterlesen|mehr lesen|zum (vollständigen )?artikel|ganzen artikel|artikel lesen|den ganzen beitrag)\b/i
// WordPress appends this to complete and truncated posts alike; it says nothing about length.
const WORDPRESS_FOOTER = /\n*The post .{1,300} appeared first on .{1,200}\.?\s*$/i

/** @typedef {'rss' | 'atom'} FeedFormat */
/** @typedef {'full_text' | 'excerpt' | 'empty'} ContentMode */

export function isYouTubeUrl(rawUrl) {
  try {
    return YOUTUBE_HOSTS.test(new URL(String(rawUrl)).hostname)
  } catch {
    return false
  }
}

/** `rss` for RSS 0.9x/1.0 (RDF)/2.0, `atom` for Atom, `null` for anything else (e.g. HTML). */
export function detectFeedFormat(text) {
  if (typeof text !== 'string') return null
  const head = text.slice(0, 4000).replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart()
  if (/^(<!DOCTYPE[^>]*>\s*)?<(\w+:)?feed[\s>]/i.test(head)) return 'atom'
  if (/^(<!DOCTYPE[^>]*>\s*)?<(rss|rdf:RDF)[\s>]/i.test(head)) return 'rss'
  return null
}

/** RSS/Atom feeds advertised by an HTML page (`<link rel="alternate" type="application/rss+xml">`). */
export function findFeedLinks(html, baseUrl) {
  if (typeof html !== 'string') return []
  const links = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
    const rel = attr('rel')?.toLowerCase().split(/\s+/) ?? []
    const type = attr('type')?.toLowerCase() ?? ''
    const href = attr('href')
    if (!href || !rel.includes('alternate') || !/application\/(rss|atom)\+xml/.test(type)) continue
    try {
      links.push(new URL(href.replace(/&amp;/g, '&'), baseUrl).href)
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...new Set(links)]
}

/** Longest readable body of a feed item: content:encoded (RSS) › content › summary/description. */
export function getItemText(item) {
  const candidates = [item?.['content:encoded'], item?.content, item?.summary, item?.description]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => htmlToText(value).replace(WORDPRESS_FOOTER, '').trim())
  const text = candidates.reduce((best, value) => (value.length > best.length ? value : best), '')
  return text.slice(0, MAX_STORED_TEXT_CHARS)
}

/** Excerpt markers at the end of a feed text („…“, „[…]“, „Weiterlesen“, „Read more“). */
export function isTruncatedText(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (TRUNCATION_TAIL.test(value)) return true
  return READ_MORE.test(value.slice(-200))
}

/** Complete text in the feed itself: long enough and not cut off with an excerpt marker. */
export function isFullFeedText(text) {
  return typeof text === 'string' && text.trim().length >= MIN_FULL_FEED_TEXT_CHARS && !isTruncatedText(text)
}

function hasAudioEnclosure(item) {
  const enclosure = item?.enclosure
  if (!enclosure?.url) return false
  const type = String(enclosure.type ?? '').toLowerCase()
  return type.startsWith('audio/') || (!type && /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i.test(enclosure.url))
}

/** Absolute public http(s) link of a feed item, or null. */
export function getItemLink(item) {
  const link = typeof item?.link === 'string' ? item.link.trim() : ''
  if (!link) return null
  try {
    const url = new URL(link)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/**
 * Decides whether a parsed feed is a website feed. Returns the preview fields, or an error
 * key with a suggested source type for podcast/YouTube feeds.
 *
 * @param {{ feed: any, feedUrl: string, format: FeedFormat | null }} options
 * @returns {{ ok: true, title: string, description: string | null, imageUrl: string | null, feedFormat: FeedFormat, contentMode: ContentMode }
 *   | { ok: false, errorKey: string, suggestedType?: 'podcast' | 'youtube' }}
 */
export function classifyWebsiteFeed({ feed, feedUrl, format }) {
  if (isYouTubeUrl(feedUrl)) return { ok: false, errorKey: 'websiteErrorIsYoutube', suggestedType: 'youtube' }
  if (!format || !feed || typeof feed.title !== 'string' || !feed.title.trim()) {
    return { ok: false, errorKey: 'websiteErrorInvalidFeed' }
  }
  const items = Array.isArray(feed.items) ? feed.items : []
  const audioItems = items.filter(hasAudioEnclosure).length
  if (items.length > 0 && audioItems * 2 >= items.length) {
    return { ok: false, errorKey: 'websiteErrorIsPodcast', suggestedType: 'podcast' }
  }

  const sample = items.slice(0, 10)
  const fullItems = sample.filter((item) => isFullFeedText(getItemText(item))).length
  /** @type {ContentMode} */
  const contentMode = sample.length === 0 ? 'empty' : fullItems * 2 >= sample.length ? 'full_text' : 'excerpt'

  const description = [feed.description, feed.subtitle].find((value) => typeof value === 'string' && value.trim())
  const image = [feed.image?.url, feed.logo, feed.icon, feed.itunes?.image].find((value) => typeof value === 'string' && /^https:\/\//i.test(value))
  return {
    ok: true,
    title: htmlToText(feed.title).slice(0, 200) || feed.title.trim(),
    description: description ? htmlToText(description).slice(0, 1000) : null,
    imageUrl: image ?? null,
    feedFormat: format,
    contentMode,
  }
}
