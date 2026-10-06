// Validation of a new Website (RSS) source: fetches the entered URL (feed or web page with an
// advertised feed), parses it and classifies it. Used by POST /api/websites/validate; fetch,
// DNS lookup and XML parser are injected so the flow runs under node:test.

import { fetchPublicText, PublicUrlError } from '../net/public-url.mjs'
import { classifyWebsiteFeed, detectFeedFormat, findFeedLinks, isYouTubeUrl } from './feed.mjs'

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5'

/**
 * @param {{ input: unknown, fetchImpl?: typeof fetch, lookup?: any, parseXml: (xml: string) => Promise<any> }} options
 * @returns {Promise<
 *   | { ok: true, preview: { title: string, description: string | null, imageUrl: string | null, feedUrl: string, feedFormat: 'rss' | 'atom', contentMode: 'full_text' | 'excerpt' | 'empty' } }
 *   | { ok: false, status: number, errorKey: string, suggestedType?: 'podcast' | 'youtube' }
 * >}
 */
export async function validateWebsiteFeed({ input, fetchImpl = fetch, lookup = null, parseXml }) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw || raw.length > 2000) return { ok: false, status: 400, errorKey: 'websiteErrorInvalidUrl' }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return { ok: false, status: 400, errorKey: 'websiteErrorInvalidUrl' }
  const candidate = hasScheme ? raw : `https://${raw}`
  try {
    new URL(candidate)
  } catch {
    return { ok: false, status: 400, errorKey: 'websiteErrorInvalidUrl' }
  }
  if (isYouTubeUrl(candidate)) return { ok: false, status: 422, errorKey: 'websiteErrorIsYoutube', suggestedType: 'youtube' }

  try {
    let page = await fetchPublicText(candidate, { fetchImpl, lookup, headers: { Accept: FEED_ACCEPT } })
    if (!page.ok) return { ok: false, status: 422, errorKey: page.status === 401 || page.status === 403 ? 'websiteErrorAccessDenied' : 'websiteErrorFetch' }

    let format = detectFeedFormat(page.text)
    if (!format) {
      // A web page instead of a feed: follow the first feed it advertises.
      const [feedLink] = findFeedLinks(page.text, page.url)
      if (!feedLink) return { ok: false, status: 422, errorKey: 'websiteErrorNoFeedFound' }
      if (isYouTubeUrl(feedLink)) return { ok: false, status: 422, errorKey: 'websiteErrorIsYoutube', suggestedType: 'youtube' }
      page = await fetchPublicText(feedLink, { fetchImpl, lookup, headers: { Accept: FEED_ACCEPT } })
      if (!page.ok) return { ok: false, status: 422, errorKey: 'websiteErrorFetch' }
      format = detectFeedFormat(page.text)
      if (!format) return { ok: false, status: 422, errorKey: 'websiteErrorInvalidFeed' }
    }

    let feed
    try {
      feed = await parseXml(page.text)
    } catch {
      return { ok: false, status: 422, errorKey: 'websiteErrorInvalidFeed' }
    }
    const result = classifyWebsiteFeed({ feed, feedUrl: page.url, format })
    if (!result.ok) return { status: 422, ...result }
    const { ok: _ok, ...meta } = result
    return { ok: true, preview: { ...meta, feedUrl: page.url } }
  } catch (err) {
    if (err instanceof PublicUrlError) {
      return { ok: false, status: 400, errorKey: err.code === 'not_allowed' ? 'websiteErrorNotAllowed' : err.code === 'invalid_url' ? 'websiteErrorInvalidUrl' : 'websiteErrorFetch' }
    }
    return { ok: false, status: 422, errorKey: 'websiteErrorFetch' }
  }
}
