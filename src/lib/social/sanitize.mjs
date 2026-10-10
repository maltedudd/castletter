// Social posts (Kanban #39) are passed on without summary, so their HTML goes into mails and
// the archive as-is – after this allowlist sanitizer. Dependency-free and deliberately strict:
// only a handful of text formatting tags survive, every attribute except a checked http(s)
// `href` on links is dropped, text is decoded and re-escaped and open tags are balanced.

import { decodeEntities, htmlToText } from '../websites/html.mjs'

const ALLOWED_TAGS = new Set(['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li'])
const VOID_TAGS = new Set(['br'])
// Elements whose content is never post text (scripts, styles, embedded documents, forms).
const DROP_WITH_CONTENT = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'title', 'head', 'textarea', 'select', 'button', 'form']
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const HREF_PATTERN = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const LINK_REL = 'noopener noreferrer nofollow'

const MAX_TITLE_CHARS = 100

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(text) {
  return escapeText(text).replace(/"/g, '&quot;')
}

function dropElements(html) {
  let result = html.replace(/<!--[\s\S]*?(-->|$)/g, '')
  for (const tag of DROP_WITH_CONTENT) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi')
    let previous
    do {
      previous = result
      result = result.replace(pattern, '')
    } while (result !== previous)
    result = result.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '')
  }
  return result
}

/** Absolute http(s) URL of a link, or null (javascript:, data:, relative, malformed). */
export function safeHttpUrl(raw) {
  if (typeof raw !== 'string') return null
  // Browsers ignore control characters and whitespace inside schemes ("java\nscript:").
  const value = decodeEntities(raw).replace(/[\u0000- \u007f]/g, '')
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function linkHref(attributes) {
  const match = HREF_PATTERN.exec(attributes)
  return match ? safeHttpUrl(match[1] ?? match[2] ?? match[3] ?? '') : null
}

/**
 * Safe HTML of a social post: allowed formatting tags without attributes, http(s) links with
 * `rel="noopener noreferrer nofollow"`; everything else is removed, text content is kept.
 */
export function sanitizeSocialHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  const source = dropElements(html)
  const open = []
  let out = ''
  let last = 0

  const closeUntil = (index) => {
    while (open.length > index) out += `</${open.pop()}>`
  }

  for (const match of source.matchAll(TAG_PATTERN)) {
    out += escapeText(decodeEntities(source.slice(last, match.index)))
    last = match.index + match[0].length
    const closing = match[1] === '/'
    const tag = match[2].toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) continue

    if (closing) {
      const index = open.lastIndexOf(tag)
      if (index !== -1) closeUntil(index)
      continue
    }
    if (VOID_TAGS.has(tag)) {
      out += `<${tag}>`
      continue
    }
    if (tag === 'a') {
      const href = linkHref(match[3])
      if (!href) continue
      // Links never nest: an open link ends where the next one starts.
      const openLink = open.lastIndexOf('a')
      if (openLink !== -1) closeUntil(openLink)
      out += `<a href="${escapeAttribute(href)}" rel="${LINK_REL}">`
    } else {
      out += `<${tag}>`
    }
    open.push(tag)
  }
  out += escapeText(decodeEntities(source.slice(last)))
  closeUntil(0)
  return out
}

/** Plain text of a post (paragraphs and line breaks kept), e.g. for the plain-text mail. */
export function socialPostText(html) {
  return htmlToText(sanitizeSocialHtml(html))
}

function clip(text, maxChars) {
  const chars = Array.from(text)
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('').trimEnd()}…` : text
}

/**
 * Title of a post row (mail heading, immediate subject, archive): the content warning when
 * there is one – so nothing hidden behind it shows up in a subject line –, otherwise the
 * first line of the text, otherwise a neutral placeholder.
 */
export function socialPostTitle({ text, spoiler, hasMedia = false }) {
  const warning = typeof spoiler === 'string' ? spoiler.replace(/\s+/g, ' ').trim() : ''
  if (warning) return `CW: ${clip(warning, MAX_TITLE_CHARS - 4)}`
  const firstLine = String(text ?? '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).find(Boolean)
  if (firstLine) return clip(firstLine, MAX_TITLE_CHARS)
  return hasMedia ? 'Beitrag mit Medien' : 'Beitrag'
}
