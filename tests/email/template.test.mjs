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
