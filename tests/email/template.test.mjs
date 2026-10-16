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

// ─── Kanban #38/#42: overview, sections, website length ─────────────

const typed = (id, sourceType, publishedAt) => ({
  ...item(`Quelle ${id}`, `Titel ${id}`),
  id,
  sourceType,
  publishedAt,
  intro: `Intro ${id}.`,
  audioUrl: `https://example.com/${id}`,
})
// Given in digest order (the delivery sorts, see sortDigestItems); the template groups.
const DIGEST = [
  typed('p', 'podcast', '2026-10-07T03:00:00.000Z'),
  typed('y', 'youtube', '2026-10-07T02:00:00.000Z'),
  typed('w', 'website', '2026-10-07T01:00:00.000Z'),
]
const src = (id, sourceType) => ({ id, sourceType, sourceTitle: `Quelle ${id}`, title: `Titel ${id}`, url: `https://example.com/${id}?a=1&b=<2>` })
const OVERVIEW = {
  themes: [
    { text: 'Wärmewende: Kommunen müssen bis 2028 planen <jetzt>.', sources: [src('p', 'podcast'), src('w', 'website')] },
    { text: 'Ohne Quelle wird nicht gezeigt.', sources: [] },
  ],
  connections: [{ text: '„Quelle y“ widerspricht „Quelle p“ bei den Kosten.', sources: [src('y', 'youtube'), src('p', 'podcast')] }],
  reflection: 'Die Kosten bleiben offen.',
  itemCount: 3,
}

function assertInOrder(text, markers, label) {
  let last = -1
  for (const marker of markers) {
    const index = text.indexOf(marker)
    assert.ok(index > last, `${marker} out of order (${label})`)
    last = index
  }
}

test('digest shows the overview first – starting with the key themes – then the sections podcasts → YouTube → Website (RSS)', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  assertInOrder(html, ['<!-- Overview -->', 'Das Wichtigste aus 3 Inhalten', 'Kernthemen', 'Wärmewende: Kommunen müssen bis 2028 planen &lt;jetzt&gt;.',
    'Zusammenhänge &amp; Spannungen', 'Die Kosten bleiben offen.', 'Jeder Punkt verlinkt die Beiträge',
    '<!-- Section: Podcasts -->', 'Intro p.', '<!-- Section: YouTube -->', 'Intro y.', '<!-- Section: Website (RSS) -->', 'Intro w.'], 'html')
  assert.match(html, /border-left: 6px solid #9FC131/)
  assert.doesNotMatch(html, /<jetzt>/)
  assert.doesNotMatch(html, /Ohne Quelle wird nicht gezeigt/, 'points without a linked source are not shown')
  // Nothing between the overview title and the first key theme: no introductory paragraph.
  const overview = html.slice(html.indexOf('Das Wichtigste aus 3 Inhalten'), html.indexOf('Kernthemen'))
  assert.doesNotMatch(overview, /<p /)

  const text = generateEmailPlainText(DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  assertInOrder(text, ['ÜBERBLICK – Das Wichtigste aus 3 Inhalten\n\nKERNTHEMEN:', '  • Wärmewende: Kommunen müssen bis 2028 planen <jetzt>.',
    'ZUSAMMENHÄNGE & SPANNUNGEN:', 'EINORDNUNG: Die Kosten bleiben offen.',
    '▬▬ PODCASTS ▬▬', 'Intro p.', '▬▬ YOUTUBE ▬▬', 'Intro y.', '▬▬ WEBSITE (RSS) ▬▬', 'Intro w.'], 'text')
})

test('Kanban #42: every key theme links its original items directly, with meaningful link texts', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  const theme = html.slice(html.indexOf('Wärmewende:'), html.indexOf('</li>', html.indexOf('Wärmewende:')))
  assert.match(theme, /Quellen: <a href="https:\/\/example\.com\/p\?a=1&amp;b=&lt;2&gt;"[^>]*>Quelle p – Titel p<\/a> · <a href="https:\/\/example\.com\/w\?a=1&amp;b=&lt;2&gt;"[^>]*>Quelle w – Titel w<\/a>/)
  const connection = html.slice(html.indexOf('„Quelle y“ widerspricht'), html.indexOf('</li>', html.indexOf('„Quelle y“ widerspricht')))
  assert.match(connection, />Quelle y – Titel y<\/a> · <a [^>]*>Quelle p – Titel p<\/a>/)

  const text = generateEmailPlainText(DIGEST, 'https://s', 'de', 'daily', OVERVIEW)
  assert.ok(text.includes('  • Wärmewende: Kommunen müssen bis 2028 planen <jetzt>.\n    → Quelle p – Titel p: https://example.com/p?a=1&b=<2>\n    → Quelle w – Titel w: https://example.com/w?a=1&b=<2>\n'))
  assert.ok(text.includes('    → Quelle y – Titel y: https://example.com/y?a=1&b=<2>\n    → Quelle p – Titel p: https://example.com/p?a=1&b=<2>'))
})

test('overview and sections in English', () => {
  const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', 'en', 'daily', OVERVIEW)
  assert.match(html, /The essentials from 3 items/)
  assert.match(html, /Key themes/)
  assert.match(html, /Sources: <a /)
  assert.match(html, /Connections &amp; tensions/)
  assert.match(html, /Every point links the items it is drawn from/)
  assert.match(html, /<!-- Section: Website \(RSS\) -->/)
  const text = generateEmailPlainText(DIGEST, 'https://s', 'en', 'daily', OVERVIEW)
  assert.match(text, /OVERVIEW – The essentials from 3 items/)
  assert.match(text, /▬▬ PODCASTS ▬▬/)
})

test('Kanban #42: a mixed digest has source-neutral wording; a podcast-only digest keeps the podcast wording', () => {
  for (const [locale, title, tagline, body] of [
    ['de', 'Dein Castletter', 'Dein täglicher Überblick über deine Quellen', 'hier ist das Neue aus deinen Quellen:'],
    ['en', 'Your Castletter', 'Your daily overview of your sources', 'here is what is new from your sources:'],
  ]) {
    const html = generateEmailHTML('m@x.de', DIGEST, 'https://s', locale, 'daily')
    assert.ok(html.includes(`<title>${title}</title>`), locale)
    assert.ok(html.includes(tagline), locale)
    assert.ok(html.includes(body), locale)
    assert.doesNotMatch(html.slice(0, html.indexOf('<!-- Section')), /Podcast-(Highlights|Zusammenfassungen|Updates)|podcast (highlights|summaries|updates)/)
    assert.ok(generateEmailPlainText(DIGEST, 'https://s', locale, 'daily').startsWith(`${title}\n`), locale)
  }
  const podcasts = [typed('p1', 'podcast', null), typed('p2', undefined, null)]
  assert.match(generateEmailHTML('m@x.de', podcasts, 'https://s', 'de', 'daily'), /<title>Deine neuen Podcast-Updates<\/title>/)
})

test('Kanban #42: Website (RSS) articles show title, link and at most three sentences; podcasts and videos stay complete', () => {
  const long = {
    ...typed('w', 'website', null),
    intro: 'Erster Satz. Zweiter Satz mit z. B. Details. Dritter Satz. Vierter Satz darf nicht erscheinen. Fünfter auch nicht.',
    bulletPoints: ['ARTIKEL-STICHPUNKT'],
    keyTakeaways: ['ARTIKEL-AUSSAGE'],
    reflection: 'ARTIKEL-EINORDNUNG',
  }
  const pod = { ...typed('p', 'podcast', null), intro: 'P1. P2. P3. P4. P5.', bulletPoints: ['POD-THEMA'], keyTakeaways: ['POD-AUSSAGE'], reflection: 'POD-EINORDNUNG' }
  const yt = { ...typed('y', 'youtube', null), intro: 'Y1. Y2. Y3. Y4.', bulletPoints: ['YT-THEMA'], actionItems: ['YT-TIPP'] }

  for (const output of [
    generateEmailHTML('m@x.de', [pod, yt, long], 'https://s', 'de', 'daily'),
    generateEmailPlainText([pod, yt, long], 'https://s', 'de', 'daily'),
  ]) {
    assert.ok(output.includes('Erster Satz. Zweiter Satz mit z. B. Details. Dritter Satz.'))
    assert.doesNotMatch(output, /Vierter Satz|Fünfter|ARTIKEL-STICHPUNKT|ARTIKEL-AUSSAGE|ARTIKEL-EINORDNUNG/)
    for (const kept of ['P1. P2. P3. P4. P5.', 'POD-THEMA', 'POD-AUSSAGE', 'POD-EINORDNUNG', 'Y1. Y2. Y3. Y4.', 'YT-THEMA', 'YT-TIPP']) {
      assert.ok(output.includes(kept), kept)
    }
  }

  const html = generateEmailHTML('m@x.de', [pod, long], 'https://s', 'de', 'daily')
  const article = html.slice(html.indexOf('<!-- Section: Website (RSS) -->'))
  assertInOrder(article, ['Quelle w', '<a href="https://example.com/w"', 'Titel w</a>', 'Erster Satz.', 'Artikel lesen'], 'website html')
  const text = generateEmailPlainText([pod, long], 'https://s', 'de', 'daily')
  assert.ok(text.includes('Quelle w\nTitel w\n→ Artikel lesen: https://example.com/w\nErster Satz. Zweiter Satz mit z. B. Details. Dritter Satz.'))

  // Also in an immediate mail.
  const immediate = generateEmailPlainText([long], 'https://s', 'de', 'immediate')
  assert.doesNotMatch(immediate, /Vierter Satz|ARTIKEL-STICHPUNKT/)
  assert.doesNotMatch(immediate, /▬▬/, 'an immediate mail has no section heading')
})

test('Kanban #42: Social posts keep their own section and full text, never shortened like websites', () => {
  const social = {
    ...typed('s', 'social', null),
    intro: '',
    bulletPoints: [],
    social: { html: '<p>Post Satz eins. Satz zwei. Satz drei. Satz vier. Satz fünf.</p>', spoiler: null, media: [] },
  }
  const html = generateEmailHTML('m@x.de', [social, DIGEST[2]], 'https://s', 'de', 'daily')
  assertInOrder(html, ['<!-- Section: Website (RSS) -->', 'Intro w.', '<!-- Section: Social -->', 'Social-Beiträge', 'Satz vier. Satz fünf.'], 'social html')
  const text = generateEmailPlainText([social, DIGEST[2]], 'https://s', 'en', 'daily')
  assertInOrder(text, ['▬▬ WEBSITE (RSS) ▬▬', 'Intro w.', '▬▬ SOCIAL POSTS ▬▬', 'Satz vier. Satz fünf.'], 'social text')
  // Unknown types land in their own last section.
  const other = generateEmailPlainText([typed('x', 'newsletter', null), DIGEST[0]], 'https://s', 'de', 'daily')
  assertInOrder(other, ['▬▬ PODCASTS ▬▬', '▬▬ WEITERE INHALTE ▬▬', 'Intro x.'], 'other')
})

test('a single item, an immediate mail or an empty overview shows no overview block', () => {
  assert.doesNotMatch(generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily'), /<!-- Overview -->/)

  const single = [DIGEST[2]]
  assert.doesNotMatch(generateEmailHTML('m@x.de', single, 'https://s', 'de', 'daily', OVERVIEW), /<!-- Overview -->/)
  assert.doesNotMatch(generateEmailHTML('m@x.de', single, 'https://s', 'de', 'immediate', OVERVIEW), /<!-- Overview -->/)
  assert.doesNotMatch(generateEmailPlainText(single, 'https://s', 'de', 'immediate', OVERVIEW), /ÜBERBLICK/)

  const empty = { themes: [{ text: 'Ohne Link', sources: [] }], connections: [{ text: 'x', sources: [src('p', 'podcast')] }], reflection: null }
  assert.doesNotMatch(generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', empty), /<!-- Overview -->/)
})

test('an item without a summary gets a notice instead of an empty block', () => {
  const missing = { ...typed('leer', 'podcast', null), intro: '', bulletPoints: [], keyTakeaways: [] }
  const html = generateEmailHTML('m@x.de', [missing, DIGEST[0]], 'https://s', 'de', 'daily')
  assert.match(html, /Für diesen Inhalt liegt keine Zusammenfassung vor\./)
  assert.match(html, /Titel leer/)
  assert.match(generateEmailPlainText([missing], 'https://s', 'en', 'daily'), /No summary is available for this item\./)
})

// ─── Kanban #39: social posts, unchanged ─────────────────────────────

const post = (id, overrides = {}) => ({
  ...item('Anna Beispiel', `Post ${id}`),
  id,
  sourceType: 'social',
  publishedAt: '2026-10-07T04:00:00.000Z',
  intro: '',
  bulletPoints: [],
  audioUrl: `https://social.example/@anna/${id}`,
  social: {
    html: `<p>Originaltext ${id} <a href="https://example.org/x">Link</a></p>`,
    spoiler: null,
    media: [],
  },
  ...overrides,
})

test('an immediate social post shows its original text, link and post wording – no summary notice', () => {
  const html = generateEmailHTML('m@x.de', [post('1')], 'https://s', 'de', 'immediate')
  assert.match(html, /<title>Neuer Beitrag: Anna Beispiel<\/title>/)
  assert.match(html, /„Anna Beispiel“ hat einen neuen Beitrag veröffentlicht/)
  assert.match(html, /<p>Originaltext 1 <a href="https:\/\/example\.org\/x" rel="noopener noreferrer nofollow">Link<\/a><\/p>/)
  assert.match(html, /href="https:\/\/social\.example\/@anna\/1"[^>]*>[\s\S]*Beitrag ansehen/)
  assert.doesNotMatch(html, /keine Zusammenfassung|zusammengefasst|Hauptthemen/)

  const text = generateEmailPlainText([post('1')], 'https://s', 'de', 'immediate')
  assert.ok(text.startsWith('Neuer Beitrag: Anna Beispiel\n'))
  assert.match(text, /Originaltext 1 Link/)
  assert.match(text, /→ Beitrag ansehen: https:\/\/social\.example\/@anna\/1/)
  assert.doesNotMatch(text, /No summary|keine Zusammenfassung/)
})

test('the post HTML is sanitised again when rendered', () => {
  const evil = post('2', { social: { html: '<p onclick="x()">Hi<script>alert(1)</script><img src="https://t.example/p.gif"><a href="javascript:alert(1)">x</a></p>', spoiler: null, media: [] } })
  const html = generateEmailHTML('m@x.de', [evil], 'https://s', 'de', 'immediate')
  assert.doesNotMatch(html, /<script|onclick|javascript:|t\.example/)
  assert.match(html, /<p>Hix<\/p>/)
})

test('a content warning is shown in front of the text, in HTML and plain text', () => {
  const warned = post('3', { episodeTitle: 'CW: Politik', social: { html: '<p>Heikel</p>', spoiler: 'Politik <laut>', media: [] } })
  const html = generateEmailHTML('m@x.de', [warned], 'https://s', 'de', 'immediate')
  assert.match(html, /Inhaltswarnung: Politik &lt;laut&gt;/)
  assert.ok(html.indexOf('Inhaltswarnung') < html.indexOf('<p>Heikel</p>'))

  const text = generateEmailPlainText([warned], 'https://s', 'en', 'immediate')
  assert.match(text, /Content warning: Politik <laut>\n\nHeikel/)
})

test('media and link previews are listed as links, never loaded as images', () => {
  const media = [
    { type: 'image', url: 'https://files.social.example/a.jpg', previewUrl: 'https://files.social.example/a_s.jpg', description: 'Ein <Bild>' },
    { type: 'video', url: 'https://files.social.example/v.mp4', previewUrl: null, description: null },
    { type: 'link', url: 'https://example.org/artikel', previewUrl: 'https://example.org/a.jpg', description: 'Artikel' },
    { type: 'image', url: 'javascript:alert(1)', previewUrl: null, description: 'böse' },
  ]
  const html = generateEmailHTML('m@x.de', [post('4', { social: { html: '<p>Mit Medien</p>', spoiler: null, media } })], 'https://s', 'de', 'immediate')
  assert.match(html, /<a href="https:\/\/files\.social\.example\/a\.jpg"[^>]*>Bild: Ein &lt;Bild&gt;<\/a>/)
  assert.match(html, /<a href="https:\/\/files\.social\.example\/v\.mp4"[^>]*>Video<\/a>/)
  assert.match(html, /<a href="https:\/\/example\.org\/artikel"[^>]*>Link: Artikel<\/a>/)
  assert.doesNotMatch(html, /<img|javascript:|böse/)

  const text = generateEmailPlainText([post('4', { social: { html: '<p>Mit Medien</p>', spoiler: null, media } })], 'https://s', 'de', 'immediate')
  assert.match(text, /Bild: Ein <Bild> – https:\/\/files\.social\.example\/a\.jpg/)
  assert.match(text, /Video – https:\/\/files\.social\.example\/v\.mp4/)
})

test('Kanban #40: a quoted Bluesky post is listed as a link labelled as quote, in both languages', () => {
  const quote = { type: 'quote', url: 'https://bsky.app/profile/did:plc:zyxwvutsrqponmlkjihgfedc/post/3kq', previewUrl: null, description: '@bob.example.org' }
  const bluesky = post('5', { audioUrl: 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3ka', social: { html: '<p>Zitat</p>', spoiler: null, media: [quote] } })
  const html = generateEmailHTML('m@x.de', [bluesky], 'https://s', 'de', 'immediate')
  assert.match(html, /<a href="https:\/\/bsky\.app\/profile\/did:plc:zyxwvutsrqponmlkjihgfedc\/post\/3kq"[^>]*>Zitierter Beitrag: @bob\.example\.org<\/a>/)
  assert.match(html, /href="https:\/\/bsky\.app\/profile\/did:plc:abcdefghijklmnopqrstuvwx\/post\/3ka"[^>]*>[\s\S]*Beitrag ansehen/)
  const text = generateEmailPlainText([bluesky], 'https://s', 'en', 'immediate')
  assert.match(text, /Quoted post: @bob\.example\.org – https:\/\/bsky\.app\/profile\/did:plc:zyxwvutsrqponmlkjihgfedc\/post\/3kq/)
})

test('daily digest: summaries first, then social posts in their own section', () => {
  const items = [...DIGEST, post('s1', { publishedAt: '2026-10-07T00:30:00.000Z' })]
  const html = generateEmailHTML('m@x.de', items, 'https://s', 'de', 'daily', OVERVIEW)
  const order = ['<!-- Overview -->', 'Intro p', 'Intro y', 'Intro w', 'Social-Beiträge', 'Originaltext s1']
  const positions = order.map((part) => html.indexOf(part))
  assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)

  const text = generateEmailPlainText(items, 'https://s', 'en', 'daily')
  assert.ok(text.indexOf('Intro w') < text.indexOf('SOCIAL POSTS'))
  assert.ok(text.indexOf('SOCIAL POSTS') < text.indexOf('Originaltext s1'))

  // Without social posts there is no social section.
  assert.doesNotMatch(generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily'), /Social-Beiträge/)
})

// ─── Kanban #48: user categories ────────────────────────────────────

const NEWS = { id: 'cat-news', name: 'Welt & <Politik>', position: 0 }
const TECH = { id: 'cat-tech', name: 'Technik', position: 1 }
const socialItem = (id) => ({
  ...typed(id, 'social', '2026-10-07T00:00:00.000Z'), intro: '', bulletPoints: [], keyTakeaways: [],
  social: { html: `<p>Post ${id}</p>`, spoiler: null, media: [] },
})
// Like assertInOrder, but markers may repeat (each one is searched after the previous one).
function assertSequence(text, markers, label) {
  let from = 0
  for (const marker of markers) {
    const index = text.indexOf(marker, from)
    assert.ok(index >= 0, `${marker} missing or out of order (${label})`)
    from = index + marker.length
  }
}

// In digest order, as sendNewsletterToUser hands them over (see sortDigestItems).
const CATEGORISED = [
  { ...typed('n-web', 'website', '2026-10-07T01:00:00.000Z'), category: NEWS },
  { ...socialItem('n-social'), category: NEWS },
  { ...typed('t-pod', 'podcast', '2026-10-07T03:00:00.000Z'), category: TECH },
  { ...typed('t-yt', 'youtube', '2026-10-07T04:00:00.000Z'), category: TECH },
  { ...typed('f-pod', 'podcast', '2026-10-07T02:00:00.000Z'), category: null },
  { ...socialItem('f-social'), category: null },
]

test('Kanban #48: digest shows each non-empty category as a heading in the user\'s order, its type sections inside, "Weitere Quellen" last', () => {
  const html = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'de', 'daily', OVERVIEW)
  assertSequence(html, ['<!-- Overview -->',
    '<!-- Category: Welt &amp; &lt;Politik&gt; -->', '>Welt &amp; &lt;Politik&gt;</h2>', '<!-- Section: Website (RSS) -->', 'Intro n-web.', '<!-- Section: Social -->', 'Post n-social',
    '<!-- Category: Technik -->', '>Technik</h2>', '<!-- Section: Podcasts -->', 'Intro t-pod.', '<!-- Section: YouTube -->', 'Intro t-yt.',
    '<!-- Category: Weitere Quellen -->', '>Weitere Quellen</h2>', '<!-- Section: Podcasts -->', 'Intro f-pod.', '<!-- Section: Social -->', 'Post f-social'], 'html')
  assert.doesNotMatch(html, /<Politik>/, 'category names are escaped')
  // Type headings inside a category are sub-headings (h3), the category is the h2.
  const tech = html.slice(html.indexOf('<!-- Category: Technik -->'), html.indexOf('<!-- Category: Weitere Quellen -->'))
  assert.match(tech, /<h3[^>]*>Podcasts<\/h3>/)
  assert.match(tech, /<h3[^>]*>YouTube<\/h3>/)
  assert.equal((html.match(/Unverändert weitergeleitet, ohne Zusammenfassung\./g) ?? []).length, 2, 'social note under each social sub-heading')

  const text = generateEmailPlainText(CATEGORISED, 'https://s', 'de', 'daily', OVERVIEW)
  assertSequence(text, ['KERNTHEMEN:',
    '■■ Welt & <Politik> ■■', '▬▬ WEBSITE (RSS) ▬▬', 'Intro n-web.', '▬▬ SOCIAL-BEITRÄGE ▬▬', 'Post n-social',
    '■■ Technik ■■', '▬▬ PODCASTS ▬▬', 'Intro t-pod.', '▬▬ YOUTUBE ▬▬', 'Intro t-yt.',
    '■■ Weitere Quellen ■■', '▬▬ PODCASTS ▬▬', 'Intro f-pod.', '▬▬ SOCIAL-BEITRÄGE ▬▬', 'Post f-social'], 'text')
})

test('Kanban #48: English label for uncategorised sources; no "more sources" heading when every item has a category', () => {
  const html = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'en', 'daily')
  assert.match(html, />More sources<\/h2>/)
  assert.match(generateEmailPlainText(CATEGORISED, 'https://s', 'en', 'daily'), /■■ More sources ■■/)

  const onlyCategorised = CATEGORISED.filter((item) => item.category)
  assert.doesNotMatch(generateEmailHTML('m@x.de', onlyCategorised, 'https://s', 'de', 'daily'), /Weitere Quellen/)
  assert.doesNotMatch(generateEmailPlainText(onlyCategorised, 'https://s', 'de', 'daily'), /Weitere Quellen/)
})

test('Kanban #48: without categories the digest is rendered exactly as before', () => {
  const plain = DIGEST.map((item) => ({ ...item, category: null }))
  assert.equal(generateEmailHTML('m@x.de', plain, 'https://s', 'de', 'daily', OVERVIEW), generateEmailHTML('m@x.de', DIGEST, 'https://s', 'de', 'daily', OVERVIEW))
  assert.equal(generateEmailPlainText(plain, 'https://s', 'de', 'daily', OVERVIEW), generateEmailPlainText(DIGEST, 'https://s', 'de', 'daily', OVERVIEW))
  const html = generateEmailHTML('m@x.de', plain, 'https://s', 'de', 'daily')
  assert.doesNotMatch(html, /<!-- Category:|Weitere Quellen/)
  assert.match(html, /<h2[^>]*>Podcasts<\/h2>/, 'type sections stay top-level headings')
})

test('Kanban #48: an immediate mail never shows a category heading', () => {
  const single = [{ ...typed('t-pod', 'podcast', null), category: TECH }]
  const html = generateEmailHTML('m@x.de', single, 'https://s', 'de', 'immediate')
  assert.doesNotMatch(html, /<!-- Category:|<!-- Section:|Technik/)
  assert.doesNotMatch(generateEmailPlainText(single, 'https://s', 'de', 'immediate'), /■■|▬▬|Technik/)
})

// ─── Kanban #50: overview by category ───────────────────────────────

const CATEGORY_OVERVIEW = {
  intro: { text: 'Die Wahl ist entschieden <jetzt>, das Chip-Gesetz kommt.', sources: [src('t-pod', 'podcast'), src('n-web', 'website')] },
  categories: [
    { category: { id: 'cat-news', name: 'Welt & <Politik>' }, text: 'Der Artikel nennt die Koalition & die Zahlen.', sources: [src('n-web', 'website')] },
    { category: { id: 'cat-tech', name: 'Technik' }, text: 'Das Chip-Gesetz kommt im Frühjahr.', sources: [src('t-pod', 'podcast'), src('t-yt', 'youtube')] },
    { category: { id: 'cat-x', name: 'Ohne Beleg' }, text: 'Wird nicht gezeigt.', sources: [] },
    { category: null, text: 'Der freie Podcast nennt einen Termin.', sources: [src('f-pod', 'podcast')] },
  ],
  itemCount: 4,
}

test('Kanban #50: the overview starts with the introduction, then one paragraph per category, "Weitere Quellen" last', () => {
  const html = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'de', 'daily', CATEGORY_OVERVIEW)
  assertSequence(html, ['<!-- Overview -->', 'Überblick', 'Das Wichtigste aus 4 Inhalten',
    '>Auf einen Blick</h3>', 'Die Wahl ist entschieden &lt;jetzt&gt;, das Chip-Gesetz kommt.', 'Quellen:', 'href="https://example.com/t-pod?a=1&amp;b=&lt;2&gt;"', 'Quelle n-web – Titel n-web',
    '>Welt &amp; &lt;Politik&gt;</h3>', 'Der Artikel nennt die Koalition &amp; die Zahlen.', 'Quelle n-web – Titel n-web',
    '>Technik</h3>', 'Das Chip-Gesetz kommt im Frühjahr.', 'Quelle t-pod – Titel t-pod', 'Quelle t-yt – Titel t-yt',
    '>Weitere Quellen</h3>', 'Der freie Podcast nennt einen Termin.', 'Quelle f-pod – Titel f-pod',
    'nach deinen Kategorien gegliedert',
    // The digest below keeps its category headings.
    '<!-- Category: Welt &amp; &lt;Politik&gt; -->'], 'html')
  const overview = html.slice(html.indexOf('<!-- Overview -->'), html.indexOf('<!-- Category:'))
  assert.doesNotMatch(overview, /<Politik>|<jetzt>/, 'category names and texts are escaped')
  assert.doesNotMatch(overview, /Ohne Beleg|Wird nicht gezeigt|Kernthemen/)

  const text = generateEmailPlainText(CATEGORISED, 'https://s', 'de', 'daily', CATEGORY_OVERVIEW)
  assertSequence(text, ['ÜBERBLICK – Das Wichtigste aus 4 Inhalten',
    'AUF EINEN BLICK:', '  Die Wahl ist entschieden <jetzt>, das Chip-Gesetz kommt.', '    → Quelle t-pod – Titel t-pod: https://example.com/t-pod',
    'WELT & <POLITIK>:', '  Der Artikel nennt die Koalition & die Zahlen.', '    → Quelle n-web – Titel n-web',
    'TECHNIK:', '  Das Chip-Gesetz kommt im Frühjahr.',
    'WEITERE QUELLEN:', '  Der freie Podcast nennt einen Termin.',
    'nach deinen Kategorien gegliedert',
    '■■ Welt & <Politik> ■■'], 'text')
  assert.doesNotMatch(text.slice(0, text.indexOf('■■')), /Ohne Beleg|KERNTHEMEN/)
})

test('Kanban #50: overview by category in English', () => {
  const html = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'en', 'daily', CATEGORY_OVERVIEW)
  assertSequence(html, ['The essentials from 4 items', '>At a glance</h3>', '>Technik</h3>', '>More sources</h3>', 'by your categories'], 'html')
  const text = generateEmailPlainText(CATEGORISED, 'https://s', 'en', 'daily', CATEGORY_OVERVIEW)
  assertSequence(text, ['OVERVIEW – The essentials from 4 items', 'AT A GLANCE:', 'TECHNIK:', 'MORE SOURCES:', 'by your categories'], 'text')
})

test('Kanban #50: missing parts of the category overview are left out; nothing linked → no overview block', () => {
  const noIntro = { ...CATEGORY_OVERVIEW, intro: null }
  const html = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'de', 'daily', noIntro)
  assert.match(html, /<!-- Overview -->/)
  assert.doesNotMatch(html, /Auf einen Blick/)
  assert.doesNotMatch(generateEmailPlainText(CATEGORISED, 'https://s', 'de', 'daily', noIntro), /AUF EINEN BLICK/)

  const introOnly = { ...CATEGORY_OVERVIEW, categories: [] }
  const introHtml = generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'de', 'daily', introOnly)
  assert.match(introHtml, /Auf einen Blick/)
  assert.doesNotMatch(introHtml.slice(0, introHtml.indexOf('<!-- Category:')), /Technik|Weitere Quellen/)

  const unlinked = { intro: { text: 'Ohne Beleg.', sources: [] }, categories: [{ category: TECH, text: 'Auch ohne.', sources: [{ ...src('t', 'podcast'), url: '' }] }], itemCount: 4 }
  for (const overview of [unlinked, { intro: null, categories: [] }]) {
    assert.doesNotMatch(generateEmailHTML('m@x.de', CATEGORISED, 'https://s', 'de', 'daily', overview), /<!-- Overview -->/)
    assert.doesNotMatch(generateEmailPlainText(CATEGORISED, 'https://s', 'de', 'daily', overview), /ÜBERBLICK/)
  }
  // Like the classic overview: never in an immediate mail of one item.
  const single = [CATEGORISED[2]]
  assert.doesNotMatch(generateEmailHTML('m@x.de', single, 'https://s', 'de', 'immediate', CATEGORY_OVERVIEW), /<!-- Overview -->/)
})
