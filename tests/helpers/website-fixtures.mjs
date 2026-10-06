// Shared fixtures for Website (RSS) tests: RSS 2.0 and Atom feeds, article pages and a fake
// fetch that answers per URL.

export const LONG_PARAGRAPH =
  'Die Stadtwerke haben ihre Planung für das neue Wärmenetz vorgestellt und erklären ausführlich, ' +
  'welche Straßen zuerst angeschlossen werden, welche Kosten auf Eigentümer zukommen und wie die Förderung funktioniert.'

export function longText(paragraphs = 12) {
  return Array.from({ length: paragraphs }, (_, i) => `Absatz ${i + 1}: ${LONG_PARAGRAPH}`).join('\n\n')
}

export function longHtml(paragraphs = 12) {
  return Array.from({ length: paragraphs }, (_, i) => `<p>Absatz ${i + 1}: ${LONG_PARAGRAPH}</p>`).join('\n')
}

export function rssFeed({ title = 'Stadtblog', items = [], image = 'https://blog.example.com/logo.png' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>${title}</title>
  <link>https://blog.example.com/</link>
  <description>Nachrichten aus der Stadt</description>
  ${image ? `<image><url>${image}</url><title>${title}</title><link>https://blog.example.com/</link></image>` : ''}
  ${items.map((item) => `<item>
    <title>${item.title}</title>
    ${item.link ? `<link>${item.link}</link>` : ''}
    ${item.guid ? `<guid>${item.guid}</guid>` : ''}
    <pubDate>${new Date(item.published).toUTCString()}</pubDate>
    ${item.description !== undefined ? `<description><![CDATA[${item.description}]]></description>` : ''}
    ${item.content !== undefined ? `<content:encoded><![CDATA[${item.content}]]></content:encoded>` : ''}
    ${item.enclosure ? `<enclosure url="${item.enclosure}" type="audio/mpeg" length="1000"/>` : ''}
  </item>`).join('\n')}
</channel>
</rss>`
}

export function atomFeed({ title = 'Technik-Magazin', entries = [] } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${title}</title>
  <subtitle>Analysen und Hintergründe</subtitle>
  <logo>https://mag.example.org/logo.png</logo>
  <id>urn:uuid:mag</id>
  <updated>2026-10-05T10:00:00Z</updated>
  ${entries.map((entry) => `<entry>
    <title>${entry.title}</title>
    <id>${entry.id}</id>
    ${entry.link ? `<link rel="alternate" href="${entry.link}"/>` : ''}
    <published>${entry.published}</published>
    <updated>${entry.published}</updated>
    ${entry.summary !== undefined ? `<summary type="html"><![CDATA[${entry.summary}]]></summary>` : ''}
    ${entry.content !== undefined ? `<content type="html"><![CDATA[${entry.content}]]></content>` : ''}
  </entry>`).join('\n')}
</feed>`
}

export function articlePage({ body = longHtml(), head = '', extra = '' } = {}) {
  return `<!doctype html><html><head><title>Artikel</title>${head}</head><body>
<header><nav><a href="/">Start</a> <a href="/ressorts">Ressorts</a></nav></header>
<main><article><h1>Das neue Wärmenetz</h1>${body}</article>
<aside>Weitere Artikel: Verkehr, Kultur, Sport</aside></main>
${extra}
<footer>Impressum · Datenschutz</footer>
<script>window.tracking = true</script>
</body></html>`
}

/**
 * fetch stand-in: `routes[url]` is `{ status?, body?, headers? }` or a function returning one;
 * unknown URLs answer 404. Every requested URL is recorded in `calls`.
 */
export function fakeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push(url)
    const route = typeof routes[url] === 'function' ? routes[url](init) : routes[url]
    if (route instanceof Error) throw route
    const { status = 200, body = '', headers = {} } = route ?? { status: 404 }
    return new Response(status === 204 || (status >= 300 && status < 400) ? null : body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    })
  }
  impl.calls = calls
  return impl
}

/** DNS lookup stand-in resolving every host to a public address unless listed in `privateHosts`. */
export function fakeLookup(privateHosts = {}) {
  return async (hostname) => [{ address: privateHosts[hostname] ?? '93.184.216.34', family: 4 }]
}
