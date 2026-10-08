// Shared fixtures for Mastodon (social) tests: API account/status JSON, the public RSS feed of
// a profile and a fake fetch that answers per URL (JSON or text) and records the requests.

export const INSTANCE = 'https://social.example'
export const ACCOUNT_ID = '109000000000000001'
export const RSS_URL = `${INSTANCE}/@anna.rss`

export function account(overrides = {}) {
  return {
    id: ACCOUNT_ID,
    username: 'anna',
    acct: 'anna',
    display_name: 'Anna Beispiel',
    note: '<p>Schreibt über <a href="https://social.example/tags/stadt">#Stadt</a> &amp; Verkehr</p>',
    avatar: 'https://files.social.example/accounts/avatars/anna.png',
    url: `${INSTANCE}/@anna`,
    ...overrides,
  }
}

/** A public status of @anna (API format); `id` doubles as the path of its URL. */
export function status(id, overrides = {}) {
  return {
    id,
    created_at: '2026-10-05T10:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    uri: `${INSTANCE}/users/anna/statuses/${id}`,
    url: `${INSTANCE}/@anna/${id}`,
    content: `<p>Post ${id}</p>`,
    reblog: null,
    account: { id: ACCOUNT_ID, username: 'anna', acct: 'anna' },
    media_attachments: [],
    card: null,
    ...overrides,
  }
}

/** Mastodon's public profile feed (`/@user.rss`, RSS 2.0 with Media RSS). */
export function mastodonRss({ title = 'Anna Beispiel', items = [] } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:webfeeds="http://webfeeds.org/rss/1.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${title}</title>
    <description>Öffentliche Beiträge von @anna@social.example</description>
    <link>${INSTANCE}/@anna</link>
    <image><url>https://files.social.example/accounts/avatars/anna.png</url><title>${title}</title><link>${INSTANCE}/@anna</link></image>
    <generator>Mastodon v4.3.0</generator>
    ${items.map((item) => `<item>
      <guid isPermaLink="true">${item.url}</guid>
      <link>${item.url}</link>
      <pubDate>${new Date(item.published).toUTCString()}</pubDate>
      <description>${escapeXml(item.html)}</description>
      ${(item.media ?? []).map((m) => `<media:content url="${m.url}" type="${m.type ?? 'image/jpeg'}" fileSize="1000" medium="${m.medium ?? 'image'}">
        <media:rating scheme="urn:simple">nonadult</media:rating>
        ${m.description ? `<media:description type="plain">${escapeXml(m.description)}</media:description>` : ''}
        ${m.thumbnail ? `<media:thumbnail url="${m.thumbnail}"/>` : ''}
      </media:content>`).join('\n')}
    </item>`).join('\n')}
  </channel>
</rss>`
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * fetch stand-in: `routes[url]` is `{ status = 200, json | body }`; unknown URLs answer 404.
 * Every requested URL is pushed to `fetchImpl.calls`.
 */
export function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const route = routes[url] ?? { status: 404, body: 'not found' }
    const status = route.status ?? 200
    const body = route.json !== undefined ? JSON.stringify(route.json) : route.body ?? ''
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => body,
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}
