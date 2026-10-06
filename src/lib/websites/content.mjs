// Text of a Website (RSS) item for summarisation, without audio or STT: the complete text from
// the feed when it has one, otherwise only the linked public article page. Paywalls, logins and
// missing full text end in a permanent, machine-readable reason – they are never worked around
// and never summarised from a teaser.

import { PermanentError } from '../transcription/audio-transcriber.mjs'
import { fetchPublicText, PublicUrlError } from '../net/public-url.mjs'
import { detectPaywall, extractMainContent } from './html.mjs'
import { isFullFeedText, isTruncatedText, MIN_ARTICLE_TEXT_CHARS } from './feed.mjs'

export const WEBSITE_ERROR_CODES = {
  paywalled: 'paywalled',
  accessRestricted: 'access_restricted',
  contentIncomplete: 'content_incomplete',
  articleUnavailable: 'article_unavailable',
  articleFetchFailed: 'article_fetch_failed',
}

// Redirect targets that mean "log in / subscribe first" instead of the article.
const LOGIN_PATH = /\/(login|log-in|signin|sign-in|anmelden|einloggen|register|registrierung|subscribe|subscription|abo|abonnement|paywall|account\/login)(\/|\?|$|\.)/i

/** No usable public full text; retrying will not help. */
export class WebsitePermanentError extends PermanentError {
  constructor(code, message) {
    super(message)
    this.name = 'WebsitePermanentError'
    this.code = code
  }
}

/** Worth retrying later (server error, timeout, network). */
export class WebsiteTemporaryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WebsiteTemporaryError'
    this.code = code
  }
}

/**
 * @param {{ episode: { feed_content?: string | null, article_url?: string | null }, fetchImpl?: typeof fetch, lookup?: any, timeoutMs?: number }} options
 * @returns {Promise<{ transcript: string, source: 'feed_content' | 'article' }>}
 */
export async function resolveWebsiteContent({ episode, fetchImpl = fetch, lookup = null, timeoutMs }) {
  const feedText = typeof episode.feed_content === 'string' ? episode.feed_content.trim() : ''
  if (isFullFeedText(feedText)) return { transcript: feedText, source: 'feed_content' }

  if (!episode.article_url) {
    throw new WebsitePermanentError(
      WEBSITE_ERROR_CODES.contentIncomplete,
      'Feed enthält nur eine Kurzfassung und keinen Link zum vollständigen Artikel'
    )
  }

  let page
  try {
    page = await fetchPublicText(episode.article_url, {
      fetchImpl,
      lookup,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      ...(timeoutMs ? { timeoutMs } : {}),
    })
  } catch (err) {
    if (err instanceof PublicUrlError) {
      throw new WebsitePermanentError(WEBSITE_ERROR_CODES.articleUnavailable, `Artikel-URL nicht abrufbar: ${err.message}`)
    }
    throw new WebsiteTemporaryError(
      WEBSITE_ERROR_CODES.articleFetchFailed,
      `Artikel konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  if ([401, 402, 403].includes(page.status)) {
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.accessRestricted, `Artikel nur mit Anmeldung oder Abo zugänglich (HTTP ${page.status})`)
  }
  if ([404, 410].includes(page.status)) {
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.articleUnavailable, `Artikel nicht gefunden (HTTP ${page.status})`)
  }
  if (!page.ok) {
    if (page.status === 429 || page.status >= 500) {
      throw new WebsiteTemporaryError(WEBSITE_ERROR_CODES.articleFetchFailed, `HTTP ${page.status} beim Abruf des Artikels`)
    }
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.articleUnavailable, `HTTP ${page.status} beim Abruf des Artikels`)
  }
  if (page.redirected && LOGIN_PATH.test(new URL(page.url).pathname) && !LOGIN_PATH.test(new URL(episode.article_url).pathname)) {
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.accessRestricted, 'Artikel leitet auf eine Anmelde- oder Abo-Seite weiter')
  }
  if (page.contentType && !/html|xml/i.test(page.contentType)) {
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.contentIncomplete, `Artikel ist keine Webseite (${page.contentType})`)
  }

  const paywall = detectPaywall(page.text)
  const articleText = extractMainContent(page.text)
  const enough = articleText.length >= MIN_ARTICLE_TEXT_CHARS
  // The schema.org marker means the full text is reserved for paying readers, even when the
  // page delivers it hidden in the HTML – using it would circumvent the paywall.
  if (paywall.declaredNotFree || (paywall.markers && !enough)) {
    throw new WebsitePermanentError(WEBSITE_ERROR_CODES.paywalled, 'Artikel liegt hinter einer Paywall – kein vollständiger öffentlicher Text')
  }
  if (articleText.length < feedText.length && feedText.length >= MIN_ARTICLE_TEXT_CHARS && !isTruncatedText(feedText)) {
    // A short post: the public page holds no more than the uncut feed text, so that is complete.
    return { transcript: feedText, source: 'feed_content' }
  }
  if (!enough || articleText.length < feedText.length) {
    throw new WebsitePermanentError(
      WEBSITE_ERROR_CODES.contentIncomplete,
      `Kein vollständiger öffentlicher Text gefunden (Feed ${feedText.length}, Artikel ${articleText.length} Zeichen)`
    )
  }
  return { transcript: articleText, source: 'article' }
}
