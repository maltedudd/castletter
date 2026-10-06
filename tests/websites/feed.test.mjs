import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import {
  classifyWebsiteFeed,
  detectFeedFormat,
  findFeedLinks,
  getItemLink,
  getItemText,
  isFullFeedText,
  isTruncatedText,
  isYouTubeUrl,
} from '../../src/lib/websites/feed.mjs'
import { detectPaywall, extractMainContent, htmlToText } from '../../src/lib/websites/html.mjs'
import { articlePage, atomFeed, longHtml, longText, rssFeed } from '../helpers/website-fixtures.mjs'

const parser = new Parser({ customFields: { feed: ['subtitle', 'logo', 'icon'] } })
const parse = (xml) => parser.parseString(xml)

test('detectFeedFormat erkennt RSS 2.0, RSS 1.0 (RDF) und Atom, HTML nicht', () => {
  assert.equal(detectFeedFormat(rssFeed()), 'rss')
  assert.equal(detectFeedFormat('<?xml version="1.0"?><rdf:RDF xmlns:rdf="x"><channel/></rdf:RDF>'), 'rss')
  assert.equal(detectFeedFormat(atomFeed()), 'atom')
  assert.equal(detectFeedFormat('<!doctype html><html><body>Hallo</body></html>'), null)
  assert.equal(detectFeedFormat(''), null)
})

test('RSS-Feed mit vollständigem content:encoded → Website-Feed mit Volltext, Bild und Format', async () => {
  const xml = rssFeed({
    items: [1, 2, 3].map((n) => ({
      title: `Beitrag ${n}`, link: `https://blog.example.com/${n}`, guid: `g${n}`,
      published: '2026-10-05T10:00:00Z', description: 'Kurz…', content: longHtml(),
    })),
  })
  const result = classifyWebsiteFeed({ feed: await parse(xml), feedUrl: 'https://blog.example.com/feed', format: 'rss' })
  assert.deepEqual(result, {
    ok: true,
    title: 'Stadtblog',
    description: 'Nachrichten aus der Stadt',
    imageUrl: 'https://blog.example.com/logo.png',
    feedFormat: 'rss',
    contentMode: 'full_text',
  })
})

test('Atom-Feed mit Kurzfassungen → Inhaltstyp excerpt, Untertitel und Logo aus dem Feed-Kopf', async () => {
  const xml = atomFeed({
    entries: [1, 2].map((n) => ({
      title: `Analyse ${n}`, id: `urn:${n}`, link: `https://mag.example.org/a/${n}`,
      published: '2026-10-05T09:00:00Z', summary: 'Ein kurzer Anriss des Themas … <a href="#">Weiterlesen</a>',
    })),
  })
  const result = classifyWebsiteFeed({ feed: await parse(xml), feedUrl: 'https://mag.example.org/atom.xml', format: 'atom' })
  assert.equal(result.ok, true)
  assert.equal(result.feedFormat, 'atom')
  assert.equal(result.contentMode, 'excerpt')
  assert.equal(result.description, 'Analysen und Hintergründe')
  assert.equal(result.imageUrl, 'https://mag.example.org/logo.png')
})

test('Feed ohne Einträge → Inhaltstyp empty, Bild optional', async () => {
  const result = classifyWebsiteFeed({ feed: await parse(rssFeed({ image: null })), feedUrl: 'https://blog.example.com/feed', format: 'rss' })
  assert.equal(result.ok, true)
  assert.equal(result.contentMode, 'empty')
  assert.equal(result.imageUrl, null)
})

test('Podcast-Feed (Audio-Enclosures) → Fehler mit Empfehlung Podcast', async () => {
  const xml = rssFeed({
    items: [1, 2].map((n) => ({ title: `Folge ${n}`, guid: `p${n}`, published: '2026-10-05T10:00:00Z', description: 'Shownotes', enclosure: `https://cdn.example.com/${n}.mp3` })),
  })
  assert.deepEqual(
    classifyWebsiteFeed({ feed: await parse(xml), feedUrl: 'https://pod.example.com/feed', format: 'rss' }),
    { ok: false, errorKey: 'websiteErrorIsPodcast', suggestedType: 'podcast' }
  )
})

test('YouTube-URL → Fehler mit Empfehlung YouTube; ungültiger Feed → websiteErrorInvalidFeed', () => {
  assert.deepEqual(
    classifyWebsiteFeed({ feed: { title: 'Kanal', items: [] }, feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx', format: 'atom' }),
    { ok: false, errorKey: 'websiteErrorIsYoutube', suggestedType: 'youtube' }
  )
  assert.deepEqual(classifyWebsiteFeed({ feed: { items: [] }, feedUrl: 'https://x.example/feed', format: 'rss' }), { ok: false, errorKey: 'websiteErrorInvalidFeed' })
  assert.deepEqual(classifyWebsiteFeed({ feed: { title: 'X' }, feedUrl: 'https://x.example/', format: null }), { ok: false, errorKey: 'websiteErrorInvalidFeed' })
  assert.equal(isYouTubeUrl('https://youtu.be/abc'), true)
  assert.equal(isYouTubeUrl('https://notyoutube.com.example/'), false)
})

test('getItemText nimmt den längsten Text (content:encoded vor description) und entfernt den WordPress-Hinweis', () => {
  const text = getItemText({
    content: 'Kurz',
    'content:encoded': `<p>Erster &amp; <b>zweiter</b> Satz.</p><p>Neuer Absatz</p>\nThe post Titel appeared first on Blog.`,
  })
  assert.equal(text, 'Erster & zweiter Satz.\n\nNeuer Absatz')
  assert.equal(getItemText({}), '')
})

test('Kürzungsmarker und Volltext-Heuristik', () => {
  assert.equal(isTruncatedText('Ein Anriss […]'), true)
  assert.equal(isTruncatedText('Ein Anriss...'), true)
  assert.equal(isTruncatedText(`${longText(2)} Weiterlesen`), true)
  assert.equal(isTruncatedText(`${longText(2)} Continue reading →`), true)
  assert.equal(isTruncatedText(longText(2)), false)
  assert.equal(isFullFeedText(longText(12)), true)
  assert.equal(isFullFeedText('Zu kurz, aber vollständig.'), false)
  assert.equal(isFullFeedText(`${longText(12)} […]`), false)
})

test('getItemLink akzeptiert nur absolute http(s)-Links', () => {
  assert.equal(getItemLink({ link: 'https://blog.example.com/a' }), 'https://blog.example.com/a')
  assert.equal(getItemLink({ link: 'javascript:alert(1)' }), null)
  assert.equal(getItemLink({ link: '/relativ' }), null)
  assert.equal(getItemLink({}), null)
})

test('findFeedLinks liest beworbene RSS/Atom-Feeds einer Webseite relativ zur Seiten-URL', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/s.css">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed/">
    <link type="application/atom+xml" rel="alternate" href="https://blog.example.com/atom.xml?a=1&amp;b=2">
  </head></html>`
  assert.deepEqual(findFeedLinks(html, 'https://blog.example.com/start'), [
    'https://blog.example.com/feed/',
    'https://blog.example.com/atom.xml?a=1&b=2',
  ])
})

test('htmlToText: Absätze, Entities, Skripte entfernt', () => {
  assert.equal(htmlToText('<p>A&nbsp;&#228;&#x00FC;</p><script>x()</script><p>B<br>C</p>'), 'A äü\n\nB\nC')
})

test('extractMainContent nimmt den Artikel und lässt Navigation, Seitenleiste, Footer und Skripte weg', () => {
  const text = extractMainContent(articlePage())
  assert.match(text, /^Das neue Wärmenetz/)
  assert.match(text, /Absatz 12:/)
  assert.doesNotMatch(text, /Ressorts|Weitere Artikel|Impressum|tracking/)
})

test('extractMainContent bevorzugt itemprop=articleBody mit verschachtelten Elementen', () => {
  const html = `<body><div class="teaser">Andere Meldung</div>
    <div itemprop="articleBody"><div><p>Innen 1</p></div><p>Innen 2</p></div><div>Danach</div></body>`
  assert.equal(extractMainContent(html), 'Innen 1\n\nInnen 2')
})

test('detectPaywall erkennt schema.org isAccessibleForFree=false und typische Paywall-Container', () => {
  assert.deepEqual(detectPaywall('<script type="application/ld+json">{"isAccessibleForFree": false}</script>'), { declaredNotFree: true, markers: false })
  assert.deepEqual(detectPaywall('{"isAccessibleForFree":"False"}'), { declaredNotFree: true, markers: false })
  assert.deepEqual(detectPaywall('<div class="article paywall">Jetzt abonnieren</div>'), { declaredNotFree: false, markers: true })
  assert.deepEqual(detectPaywall('{"isAccessibleForFree": true}<p>frei</p>'), { declaredNotFree: false, markers: false })
})
