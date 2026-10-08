import assert from 'node:assert/strict'
import test from 'node:test'
import { generateEmailHTML, generateEmailPlainText } from '../../src/lib/email/template.mjs'

const item = (podcastTitle, episodeTitle) => ({
  podcastTitle,
  episodeTitle,
  intro: 'Kurz.',
  bulletPoints: ['Thema'],
  keyTakeaways: [],
  actionItems: [],
  quotes: [],
  speakers: [],
  reflection: null,
  audioUrl: 'https://cdn.example/a.mp3',
})

const ONE = [item('Hotel <Matze>', 'Folge 1')]
const TWO = [...ONE, item('Lage der Nation', 'Folge 2')]

test('daily digest keeps the daily wording (also as default)', () => {
  for (const html of [generateEmailHTML('m@x.de', TWO, 'https://s', 'de', 'daily'), generateEmailHTML('m@x.de', TWO, 'https://s')]) {
    assert.match(html, /Deine täglichen Podcast-Highlights/)
    assert.match(html, /hier sind deine neuen Podcast-Zusammenfassungen:/)
    assert.match(html, /<title>Deine neuen Podcast-Updates<\/title>/)
  }
  const text = generateEmailPlainText(TWO, 'https://s')
  assert.ok(text.startsWith('Deine neuen Podcast-Updates\n'))
  assert.match(text, /hier sind deine neuen Podcast-Zusammenfassungen:/)
})

test('immediate mail announces the new episode instead of the daily digest', () => {
  const html = generateEmailHTML('m@x.de', ONE, 'https://s', 'de', 'immediate')
  assert.doesNotMatch(html, /täglich/i)
  assert.match(html, /Neue Folge, frisch zusammengefasst/)
  assert.match(html, /gerade ist eine neue Folge von „Hotel &lt;Matze&gt;“ erschienen\. Hier ist deine Zusammenfassung:/)
  assert.match(html, /<title>Neue Folge: Hotel &lt;Matze&gt;<\/title>/)

  const text = generateEmailPlainText(ONE, 'https://s', 'de', 'immediate')
  assert.doesNotMatch(text, /täglich/i)
  assert.ok(text.startsWith('Neue Folge: Hotel <Matze>\n'))
  assert.match(text, /gerade ist eine neue Folge von „Hotel <Matze>“ erschienen\./)
})

test('immediate wording in English', () => {
  const html = generateEmailHTML('m@x.de', ONE, 'https://s', 'en', 'immediate')
  assert.match(html, /New episode, freshly summarized/)
  assert.match(html, /a new episode of “Hotel &lt;Matze&gt;” just came out\./)
  assert.doesNotMatch(html, /daily/i)
})

test('immediate mode with several episodes falls back to the digest wording', () => {
  const html = generateEmailHTML('m@x.de', TWO, 'https://s', 'de', 'immediate')
  assert.match(html, /Deine täglichen Podcast-Highlights/)
})

test('website articles link to the article instead of "listen" and get article wording when sent immediately', () => {
  const article = { ...item('Stadtblog', 'Das neue Wärmenetz'), audioUrl: 'https://blog.example.com/artikel', sourceType: 'website' }
  const html = generateEmailHTML('m@x.de', [article], 'https://s', 'de', 'immediate')
  assert.match(html, /Artikel lesen/)
  assert.doesNotMatch(html, /Episode anhören/)
  assert.match(html, /<title>Neuer Artikel: Stadtblog<\/title>/)
  assert.match(html, /gerade ist ein neuer Artikel von „Stadtblog“ erschienen/)

  const text = generateEmailPlainText([article], 'https://s', 'en', 'immediate')
  assert.match(text, /→ Read article: https:\/\/blog\.example\.com\/artikel/)
  assert.ok(text.startsWith('New article: Stadtblog\n'))

  // Mixed digest: each item keeps its own link text.
  const mixed = generateEmailPlainText([ONE[0], article], 'https://s', 'de', 'daily')
  assert.match(mixed, /→ Episode anhören: https:\/\/cdn\.example\/a\.mp3/)
  assert.match(mixed, /→ Artikel lesen: https:\/\/blog\.example\.com\/artikel/)
})

// ─── Kanban #38: overview and grouping ───────────────────────────────

const typed = (id, sourceType, publishedAt) => ({
  ...item(`Quelle ${id}`, `Titel ${id}`),
  id,
  sourceType,
  publishedAt,
  intro: `Intro ${id}`,
})
const DIGEST = [
  typed('w', 'website', '2026-10-07T01:00:00.000Z'),
  typed('y', 'youtube', '2026-10-07T02:00:00.000Z'),
  typed('p', 'podcast', '2026-10-07T03:00:00.000Z'),
]
const OVERVIEW = {
  summary: 'Quer durch alle <Quellen>.',
  themes: ['Energie: „Quelle p“ und „Quelle w“'],
  connections: ['„Quelle y“ widerspricht „Quelle p“'],
  reflection: 'Bleibt spannend.',
  itemCount: 3,
}

test('digest shows the highlighted overview first, then the groups podcast → YouTube → Website (RSS)', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  const order = ['<!-- Overview -->', 'Das Wichtigste aus 3 Inhalten', 'Quer durch alle &lt;Quellen&gt;.', 'Kernthemen', 'Zusammenhänge &amp; Spannungen', 'Bleibt spannend.',
    'Podcasts (1)', 'Intro p', 'YouTube (1)', 'Intro y', 'Website (RSS) (1)', 'Intro w']
  let last = -1
  for (const marker of order) {
    const index = html.indexOf(marker)
    assert.ok(index > last, `${marker} out of order`)
    last = index
  }
  assert.match(html, /border-left: 6px solid #9FC131/)
  assert.match(html, /KI-Überblick auf Basis der 3 Zusammenfassungen unten/)
  assert.doesNotMatch(html, /<Quellen>/)

  const text = generateEmailPlainText(DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  const textOrder = ['ÜBERBLICK – Das Wichtigste aus 3 Inhalten', 'Quer durch alle <Quellen>.', 'KERNTHEMEN:', 'ZUSAMMENHÄNGE & SPANNUNGEN:', 'EINORDNUNG: Bleibt spannend.',
    '▌ PODCASTS (1)', 'Intro p', '▌ YOUTUBE (1)', 'Intro y', '▌ WEBSITE (RSS) (1)', 'Intro w']
  last = -1
  for (const marker of textOrder) {
    const index = text.indexOf(marker)
    assert.ok(index > last, `${marker} out of order (text)`)
    last = index
  }
})

test('overview and groups in English', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'en', 'daily', OVERVIEW)
  assert.match(html, /The essentials from 3 items/)
  assert.match(html, /Key themes/)
  assert.match(html, /Connections &amp; tensions/)
  assert.match(html, /Website \(RSS\) \(1\)/)
  assert.match(generateEmailPlainText(DIGEST, 'https://s', 'en', 'daily', OVERVIEW), /OVERVIEW – The essentials from 3 items/)
})

test('without an overview the digest is still grouped; a single item or an immediate mail shows no overview', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily')
  assert.doesNotMatch(html, /<!-- Overview -->/)
  assert.ok(html.indexOf('Podcasts (1)') < html.indexOf('Website (RSS) (1)'))

  const single = [DIGEST[2]]
  assert.doesNotMatch(generateEmailHTML('m@x.de', single, 'https://s', 'de', 'daily', OVERVIEW), /<!-- Overview -->/)
  const immediate = generateEmailHTML('m@x.de', single, 'https://s', 'de', 'immediate', OVERVIEW)
  assert.doesNotMatch(immediate, /<!-- Overview -->|Podcasts \(1\)/)
  assert.doesNotMatch(generateEmailPlainText(single, 'https://s', 'de', 'immediate', OVERVIEW), /ÜBERBLICK|▌/)

  const empty = { summary: '  ', themes: [], connections: ['x'], reflection: null }
  assert.doesNotMatch(generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', empty), /<!-- Overview -->/)
})

test('an item without a summary gets a notice instead of an empty block', () => {
  const missing = { ...typed('leer', 'podcast', null), intro: '', bulletPoints: [], keyTakeaways: [] }
  const html = generateEmailHTML('m@x.de', [missing, DIGEST[0]], 'https://s', 'de', 'daily')
  assert.match(html, /Für diesen Inhalt liegt keine Zusammenfassung vor\./)
  assert.match(html, /Titel leer/)
  assert.match(generateEmailPlainText([missing], 'https://s', 'en', 'daily'), /No summary is available for this item\./)
})
