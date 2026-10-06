import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { validateWebsiteFeed } from '../../src/lib/websites/validate.mjs'
import { assertPublicUrl, isPrivateHost, PublicUrlError } from '../../src/lib/net/public-url.mjs'
import { atomFeed, fakeFetch, fakeLookup, longHtml, rssFeed } from '../helpers/website-fixtures.mjs'

const parser = new Parser({ customFields: { feed: ['subtitle', 'logo', 'icon'] } })
const parseXml = (xml) => parser.parseString(xml)
const FULL_RSS = rssFeed({
  items: [{ title: 'Beitrag', link: 'https://blog.example.com/1', guid: 'g1', published: '2026-10-05T10:00:00Z', content: longHtml() }],
})

test('RSS-Feed-URL → Vorschau mit Titel, Beschreibung, Bild, Format und Inhaltstyp', async () => {
  const fetchImpl = fakeFetch({ 'https://blog.example.com/feed': { body: FULL_RSS, headers: { 'content-type': 'application/rss+xml' } } })
  const result = await validateWebsiteFeed({ input: ' https://blog.example.com/feed ', fetchImpl, lookup: fakeLookup(), parseXml })
  assert.deepEqual(result, {
    ok: true,
    preview: {
      title: 'Stadtblog',
      description: 'Nachrichten aus der Stadt',
      imageUrl: 'https://blog.example.com/logo.png',
      feedFormat: 'rss',
      contentMode: 'full_text',
      feedUrl: 'https://blog.example.com/feed',
    },
  })
})

test('Webseiten-URL ohne Schema → beworbener Atom-Feed wird gefunden und gespeichert', async () => {
  const fetchImpl = fakeFetch({
    'https://mag.example.org/': { body: '<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>' },
    'https://mag.example.org/atom.xml': { body: atomFeed({ entries: [] }), headers: { 'content-type': 'application/atom+xml' } },
  })
  const result = await validateWebsiteFeed({ input: 'mag.example.org', fetchImpl, parseXml })
  assert.equal(result.ok, true)
  assert.equal(result.preview.feedUrl, 'https://mag.example.org/atom.xml')
  assert.equal(result.preview.feedFormat, 'atom')
  assert.equal(result.preview.contentMode, 'empty')
})

test('Fehler sind übersetzbare Schlüssel; Podcast/YouTube mit Quelltyp-Empfehlung', async () => {
  const podcast = rssFeed({ items: [{ title: 'Folge', guid: 'p', published: '2026-10-05T10:00:00Z', enclosure: 'https://cdn.example.com/1.mp3' }] })
  const cases = [
    [{ input: '' }, { status: 400, errorKey: 'websiteErrorInvalidUrl' }],
    [{ input: 'https://www.youtube.com/@kanal' }, { status: 422, errorKey: 'websiteErrorIsYoutube', suggestedType: 'youtube' }],
    [{ input: 'https://pod.example.com/feed', routes: { 'https://pod.example.com/feed': { body: podcast } } }, { status: 422, errorKey: 'websiteErrorIsPodcast', suggestedType: 'podcast' }],
    [{ input: 'https://site.example.com/', routes: { 'https://site.example.com/': { body: '<html><body>Kein Feed</body></html>' } } }, { status: 422, errorKey: 'websiteErrorNoFeedFound' }],
    [{ input: 'https://site.example.com/feed', routes: { 'https://site.example.com/feed': { status: 500 } } }, { status: 422, errorKey: 'websiteErrorFetch' }],
    [{ input: 'https://site.example.com/feed', routes: { 'https://site.example.com/feed': { status: 403 } } }, { status: 422, errorKey: 'websiteErrorAccessDenied' }],
    [{ input: 'https://site.example.com/feed', routes: { 'https://site.example.com/feed': new TypeError('fetch failed') } }, { status: 422, errorKey: 'websiteErrorFetch' }],
    [{ input: 'https://site.example.com/feed', routes: { 'https://site.example.com/feed': { body: '<rss><channel><item>' } } }, { status: 422, errorKey: 'websiteErrorInvalidFeed' }],
    [{ input: 'http://localhost:3000/feed' }, { status: 400, errorKey: 'websiteErrorNotAllowed' }],
    [{ input: 'ftp://example.com/feed' }, { status: 400, errorKey: 'websiteErrorInvalidUrl' }],
  ]
  for (const [{ input, routes = {} }, expected] of cases) {
    const result = await validateWebsiteFeed({ input, fetchImpl: fakeFetch(routes), parseXml })
    assert.deepEqual(result, { ok: false, ...expected }, `Eingabe ${input}`)
  }
})

test('isPrivateHost/assertPublicUrl blockieren interne Ziele', async () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '[::1]', 'fd00::1', 'db.internal', 'router.local', '100.64.0.1']) {
    assert.equal(isPrivateHost(host), true, host)
  }
  assert.equal(isPrivateHost('blog.example.com'), false)
  assert.equal(isPrivateHost('8.8.8.8'), false)
  await assert.rejects(assertPublicUrl('https://user:pw@example.com/'), PublicUrlError)
  await assert.rejects(assertPublicUrl('https://evil.example.com/', { lookup: fakeLookup({ 'evil.example.com': '127.0.0.1' }) }), PublicUrlError)
  assert.equal((await assertPublicUrl('https://blog.example.com/x', { lookup: fakeLookup() })).href, 'https://blog.example.com/x')
})
