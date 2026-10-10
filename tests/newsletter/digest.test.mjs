import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SOURCE_TYPE_ORDER,
  DIGEST_SECTION_ORDER,
  digestSourceType,
  MIN_OVERVIEW_ITEMS,
  MAX_OVERVIEW_ITEMS,
  MAX_WEBSITE_SENTENCES,
  sortDigestItems,
  groupDigestItems,
  isPodcastOnly,
  hasSummaryContent,
  selectOverviewItems,
  buildDigestOverviewPrompt,
  parseDigestOverview,
  createDigestOverviewGenerator,
  splitSentences,
  limitSentences,
  websiteSummary,
} from '../../src/lib/newsletter/digest.mjs'
import { buildStyleInstructions } from '../../src/lib/newsletter/summary-style.mjs'

function item(id, sourceType, publishedAt, overrides = {}) {
  return {
    id,
    podcastTitle: `Quelle ${id}`,
    episodeTitle: `Titel ${id}`,
    intro: `Zusammenfassung ${id}.`,
    bulletPoints: [`Thema ${id}`],
    keyTakeaways: [`Aussage ${id}`],
    actionItems: [],
    quotes: [],
    speakers: [],
    reflection: null,
    audioUrl: `https://example.com/${id}`,
    sourceType,
    publishedAt,
    ...overrides,
  }
}

const MIXED = [
  item('w1', 'website', '2026-10-07T06:00:00.000Z'),
  item('y2', 'youtube', '2026-10-07T09:00:00.000Z'),
  item('p2', 'podcast', '2026-10-07T08:00:00.000Z'),
  item('y1', 'youtube', '2026-10-06T09:00:00.000Z'),
  item('p1', 'podcast', '2026-10-06T23:00:00.000Z'),
  item('w2', 'website', '2026-10-07T10:00:00.000Z'),
]

const ids = (items) => items.map((i) => i.id)

test('Kanban #42: digest order is podcasts → YouTube → Website (RSS), chronological within each type', () => {
  assert.deepEqual(SOURCE_TYPE_ORDER, ['podcast', 'youtube', 'website', 'social'])
  assert.deepEqual(DIGEST_SECTION_ORDER, ['podcast', 'youtube', 'website', 'social', 'other'])
  assert.deepEqual(ids(sortDigestItems(MIXED)), ['p1', 'p2', 'y1', 'y2', 'w1', 'w2'])
  assert.deepEqual(ids(sortDigestItems([item('x', 'weird', null), item('s', 'social', null), item('legacy', undefined, null), MIXED[0]])), ['legacy', 'w1', 's', 'x'])
})

test('groupDigestItems: fixed sections, empty ones left out; Social is its own section, never Website', () => {
  const social = item('s1', 'social', '2026-10-07T05:00:00.000Z', { intro: '', bulletPoints: [], keyTakeaways: [] })
  const groups = groupDigestItems([...MIXED, social, item('x', 'weird', null)])
  assert.deepEqual(groups.map((g) => [g.type, ids(g.items)]), [
    ['podcast', ['p1', 'p2']],
    ['youtube', ['y1', 'y2']],
    ['website', ['w1', 'w2']],
    ['social', ['s1']],
    ['other', ['x']],
  ])
  assert.deepEqual(groupDigestItems([MIXED[0], MIXED[2]]).map((g) => g.type), ['podcast', 'website'])
  assert.deepEqual(groupDigestItems(undefined), [])
})

test('the order is deterministic for every input order and does not mutate the input', () => {
  const before = ids(MIXED)
  const permutations = [[...MIXED].reverse(), [MIXED[3], MIXED[0], MIXED[5], MIXED[1], MIXED[4], MIXED[2]]]
  const expected = ids(sortDigestItems(MIXED))
  for (const input of permutations) assert.deepEqual(ids(sortDigestItems(input)), expected)
  assert.deepEqual(ids(MIXED), before)
})

test('within a type, ties on time are broken by source, title and id; missing or invalid dates go last', () => {
  const same = '2026-10-07T08:00:00.000Z'
  const items = [
    item('b', 'podcast', same, { podcastTitle: 'B' }),
    item('a2', 'podcast', same, { podcastTitle: 'A', episodeTitle: 'Z' }),
    item('a1', 'podcast', same, { podcastTitle: 'A', episodeTitle: 'Y' }),
    item('nodate', 'podcast', null),
    item('invalid', 'podcast', 'kein Datum'),
    item('early', undefined, '2026-10-01T00:00:00.000Z'),
    item('yt', 'youtube', '2026-09-01T00:00:00.000Z'),
  ]
  assert.deepEqual(ids(sortDigestItems(items)), ['early', 'a1', 'a2', 'b', 'invalid', 'nodate', 'yt'])
  assert.deepEqual(sortDigestItems(undefined), [])
})

test('isPodcastOnly: only podcast (or legacy untyped) items', () => {
  assert.equal(isPodcastOnly([MIXED[2], item('legacy', undefined, null)]), true)
  assert.equal(isPodcastOnly(MIXED), false)
  assert.equal(isPodcastOnly([MIXED[1]]), false)
  assert.equal(isPodcastOnly([item('s', 'social', null)]), false)
  assert.equal(isPodcastOnly([]), false)
})

test('hasSummaryContent: intro or bullets count, empty fallbacks do not', () => {
  assert.equal(hasSummaryContent(item('a', 'podcast', null)), true)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: '', bulletPoints: [], keyTakeaways: ['k'] })), true)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: '  ', bulletPoints: [' '], keyTakeaways: [] })), false)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: null, bulletPoints: null, keyTakeaways: undefined })), false)
})

test('overview prompt is built from the stored summaries and metadata in digest order, never from transcripts', () => {
  const items = MIXED.map((i) => ({ ...i, transcript: 'GEHEIMES VOLLTRANSKRIPT', reflection: `Einordnung ${i.id}` }))
  const prompt = buildDigestOverviewPrompt(items, { tone: 'concise' })

  assert.doesNotMatch(prompt, /GEHEIMES VOLLTRANSKRIPT/)
  assert.match(prompt, /^Du schreibst den Überblick am Anfang meines Castletter-Digests/)
  assert.match(prompt, /Inhalte \(6\):/)
  assert.match(prompt, /\[1\] Podcast-Episode \(Priorität 1\) · Quelle: Quelle p1 · 2026-10-06\nTitel: Titel p1\nZusammenfassung: Zusammenfassung p1\.\nHauptthemen: Thema p1\nWichtige Aussagen: Aussage p1\nEinordnung: Einordnung p1/)
  assert.ok(prompt.indexOf('[3] YouTube-Video (Priorität 2) · Quelle: Quelle y1') < prompt.indexOf('[5] Website-Artikel (Priorität 3) · Quelle: Quelle w1'))
  assert.match(prompt, /Wiederhole keine einzelnen Stichpunkte/)
  assert.match(prompt, /Behaupte keine Zusammenhänge, die die genannten Inhalte nicht tragen/)
  assert.ok(prompt.endsWith(buildStyleInstructions({ tone: 'concise' })))
})

test('Kanban #42: the overview starts with concrete key themes, each ending with the numbers of its items', () => {
  const prompt = buildDigestOverviewPrompt(MIXED)
  assert.match(prompt, /Beginne sofort mit den konkreten Kernthemen\. Keine Einleitung, keine allgemeine Lagebeschreibung/)
  assert.match(prompt, /Beende ihn mit den Nummern der Inhalte, aus denen er stammt, im Format \[1\] oder \[2\]\[5\]/)
  assert.match(prompt, /Nur Nummern aus der Liste unten/)
  assert.doesNotMatch(prompt, /\n## Überblick\n/, 'no introductory summary paragraph any more')
  const structure = prompt.slice(prompt.indexOf('Erstelle folgende Struktur'))
  assert.match(structure, /^Erstelle folgende Struktur \(exakt diese Überschriften verwenden, nichts davor\):\n\n## Kernthemen\n/)
  assert.ok(structure.indexOf('## Kernthemen') < structure.indexOf('## Zusammenhänge und Spannungen'))
  assert.ok(structure.indexOf('## Zusammenhänge und Spannungen') < structure.indexOf('## Einordnung'))
})

test('overview prompt bounds its input: capped texts and bullets, at most MAX_OVERVIEW_ITEMS items, unsummarised items left out', () => {
  const long = item('long', 'podcast', '2026-10-07T00:00:00.000Z', {
    intro: 'x'.repeat(5000),
    bulletPoints: Array.from({ length: 12 }, (_, i) => `Thema ${i} ${'y'.repeat(1000)}`),
  })
  const empty = item('empty', 'podcast', '2026-10-07T01:00:00.000Z', { intro: '', bulletPoints: [], keyTakeaways: [] })
  const prompt = buildDigestOverviewPrompt([long, empty, item('b', 'youtube', null)])
  assert.ok(!prompt.includes('x'.repeat(801)))
  assert.ok(!prompt.includes('y'.repeat(301)))
  assert.match(prompt, /Thema 4 /)
  assert.doesNotMatch(prompt, /Thema 5 /)
  assert.doesNotMatch(prompt, /Titel empty/)
  assert.match(prompt, /Inhalte \(2\):/)

  const many = Array.from({ length: MAX_OVERVIEW_ITEMS + 3 }, (_, i) => item(`m${String(i).padStart(2, '0')}`, 'podcast', `2026-10-07T${String(i % 24).padStart(2, '0')}:00:00.000Z`))
  const capped = buildDigestOverviewPrompt(many)
  assert.match(capped, new RegExp(`Inhalte \\(${MAX_OVERVIEW_ITEMS}\\):`))
  assert.match(capped, /\(3 weitere Inhalte stehen im Digest/)
  assert.ok(capped.length < 40_000, `prompt too long: ${capped.length}`)
})

const OVERVIEW_ANSWER = `## Kernthemen
- **Wärmewende in Kommunen:** „Quelle p1“ und der Artikel in „Quelle w1“ sehen die Kommunen bis 2028 in der Pflicht [1][5].
- Finanzierung: Die Förderung reicht laut Video nicht aus [3] [4].
- Ohne Beleg: Dieser Punkt nennt keine Quelle.
- Erfunden: Nummer außerhalb der Liste [9].

## Zusammenhänge und Spannungen
- „Quelle y1“ widerspricht „Quelle p1“ bei den Kosten [3, 1].
- Ohne Nummern.

## Einordnung
Die Kosten bleiben die offene Frage [2].`

const OVERVIEW_ITEMS = () => selectOverviewItems(MIXED)

test('parseDigestOverview links every point to the items its numbers refer to', () => {
  const items = OVERVIEW_ITEMS()
  assert.deepEqual(ids(items), ['p1', 'p2', 'y1', 'y2', 'w1', 'w2'])
  const source = (id, sourceType) => ({ id, sourceType, sourceTitle: `Quelle ${id}`, title: `Titel ${id}`, url: `https://example.com/${id}` })

  assert.deepEqual(parseDigestOverview(OVERVIEW_ANSWER, items), {
    themes: [
      { text: 'Wärmewende in Kommunen: „Quelle p1“ und der Artikel in „Quelle w1“ sehen die Kommunen bis 2028 in der Pflicht.', sources: [source('p1', 'podcast'), source('w1', 'website')] },
      { text: 'Finanzierung: Die Förderung reicht laut Video nicht aus.', sources: [source('y1', 'youtube'), source('y2', 'youtube')] },
    ],
    connections: [
      { text: '„Quelle y1“ widerspricht „Quelle p1“ bei den Kosten.', sources: [source('y1', 'youtube'), source('p1', 'podcast')] },
    ],
    reflection: 'Die Kosten bleiben die offene Frage.',
  })
})

test('parseDigestOverview drops unsupported points and returns null without any linked key theme', () => {
  const items = OVERVIEW_ITEMS()
  // Points without numbers, with numbers outside the list or to items without an http(s) link are dropped.
  const noLink = [item('a', 'podcast', null, { audioUrl: 'javascript:alert(1)' }), item('b', 'podcast', null, { audioUrl: null })]
  assert.equal(parseDigestOverview('## Kernthemen\n- Thema [1][2]', noLink), null)
  assert.equal(parseDigestOverview('## Kernthemen\n- Ohne Nummern.\n- Falsch [0][7]', items), null)
  // The old answer format (intro paragraph only) or free text gives no overview.
  assert.equal(parseDigestOverview('## Überblick\nDie Nachrichtenlage ist angespannt.', items), null)
  assert.equal(parseDigestOverview('# Freitext\nOhne Struktur.', items), null)
  for (const empty of [undefined, null, '', '  \n ', '##']) assert.equal(parseDigestOverview(empty, items), null)
  // Duplicate numbers link an item once.
  assert.deepEqual(parseDigestOverview('## Kernthemen\n- Thema [2][2] [2]', items).themes[0].sources.map((s) => s.id), ['p2'])
})

function fakeOpenRouter(content) {
  const requests = []
  return {
    requests,
    chat: { completions: { create: async (options, requestOptions) => { requests.push({ options, requestOptions }); return { choices: [{ message: { content } }] } } } },
  }
}

test('generator: one bounded model call for two or more summarised items, with the user style', async () => {
  const openrouter = fakeOpenRouter(OVERVIEW_ANSWER)
  const summarizeDigest = createDigestOverviewGenerator({ openrouter, model: 'google/gemini-2.5-flash', timeoutMs: 5000 })

  const overview = await summarizeDigest(MIXED, { tone: 'warm', promptAddition: 'Für Kommunalpolitik' })

  assert.equal(MIN_OVERVIEW_ITEMS, 2)
  assert.equal(openrouter.requests.length, 1)
  const { options, requestOptions } = openrouter.requests[0]
  assert.equal(options.model, 'google/gemini-2.5-flash')
  assert.deepEqual(requestOptions, { timeout: 5000, maxRetries: 1 })
  assert.match(options.messages[0].content, /Tonalität: Warm/)
  assert.match(options.messages[0].content, /Für Kommunalpolitik/)
  assert.equal(overview.itemCount, 6)
  assert.equal(overview.themes.length, 2)
  assert.deepEqual(overview.themes[0].sources.map((s) => s.url), ['https://example.com/p1', 'https://example.com/w1'])
})

test('generator: fewer than two summarised items or an empty answer → no overview', async () => {
  const openrouter = fakeOpenRouter(OVERVIEW_ANSWER)
  const summarizeDigest = createDigestOverviewGenerator({ openrouter, model: 'm' })
  const missing = item('m', 'podcast', null, { intro: '', bulletPoints: [], keyTakeaways: [] })

  assert.equal(await summarizeDigest([MIXED[0]]), null)
  assert.equal(await summarizeDigest([MIXED[0], missing]), null)
  assert.equal(await summarizeDigest([]), null)
  assert.equal(openrouter.requests.length, 0)

  const silent = createDigestOverviewGenerator({ openrouter: fakeOpenRouter(''), model: 'm' })
  assert.equal(await silent(MIXED), null)
  const unlinked = createDigestOverviewGenerator({ openrouter: fakeOpenRouter('## Kernthemen\n- Allgemeine Lage ohne Beleg.'), model: 'm' })
  assert.equal(await unlinked(MIXED), null)
})

test('overview prompt weighs podcasts first and most, YouTube next, articles mainly as supplement', () => {
  const prompt = buildDigestOverviewPrompt(MIXED)
  const rules = [
    'Gewichtung nach Quelltyp (bestimmt Reihenfolge und Raum, nicht die Wahrheit einer Aussage)',
    '1. Podcast-Episoden haben die höchste Priorität: Baue die Kernthemen in erster Linie auf ihnen auf, nenne sie zuerst und gib ihnen den meisten Raum.',
    '2. YouTube-Videos folgen danach.',
    '3. Website-Artikel dienen vor allem zur Ergänzung, Bestätigung oder Einordnung',
  ]
  let last = -1
  for (const rule of rules) {
    const index = prompt.indexOf(rule)
    assert.ok(index > last, rule)
    last = index
  }
  assert.ok(prompt.indexOf('Gewichtung nach Quelltyp') < prompt.indexOf('Inhalte (6):'))
})

test('when the overview input is capped, lower-priority items are left out first', () => {
  const articles = Array.from({ length: MAX_OVERVIEW_ITEMS }, (_, i) => item(`w${String(i).padStart(2, '0')}`, 'website', '2026-10-01T00:00:00.000Z'))
  const podcast = item('late-podcast', 'podcast', '2026-10-07T23:00:00.000Z')
  const prompt = buildDigestOverviewPrompt([...articles, podcast])
  assert.match(prompt, /\[1\] Podcast-Episode \(Priorität 1\) · Quelle: Quelle late-podcast/)
  assert.doesNotMatch(prompt, /Titel w24/)
  assert.match(prompt, /\(1 weitere Inhalte stehen im Digest/)
})

test('Kanban #42: splitSentences keeps German abbreviations, ordinals and decimals inside a sentence', () => {
  assert.deepEqual(splitSentences('Das gilt z. B. für Berlin. Dr. Müller nennt am 3. Oktober 3,5 Prozent! Im Jahr 2025. Warum? „So ist es.“ Ende'), [
    'Das gilt z. B. für Berlin.',
    'Dr. Müller nennt am 3. Oktober 3,5 Prozent!',
    'Im Jahr 2025.',
    'Warum?',
    '„So ist es.“',
    'Ende',
  ])
  assert.deepEqual(splitSentences('  '), [])
  assert.deepEqual(splitSentences(null), [])
  assert.equal(limitSentences('Eins. Zwei. Drei. Vier. Fünf.', 3), 'Eins. Zwei. Drei.')
})

test('Kanban #42: websiteSummary shows at most three complete sentences, falling back to the key statements', () => {
  assert.equal(MAX_WEBSITE_SENTENCES, 3)
  const long = item('w', 'website', null, { intro: 'Erster Satz. Zweiter Satz, u. a. mit Details.\nDritter Satz! Vierter Satz. Fünfter Satz.' })
  assert.equal(websiteSummary(long), 'Erster Satz. Zweiter Satz, u. a. mit Details. Dritter Satz!')
  assert.equal(splitSentences(websiteSummary(long)).length, 3)
  assert.equal(websiteSummary(item('w', 'website', null, { intro: 'Nur ein Satz.' })), 'Nur ein Satz.')
  assert.equal(
    websiteSummary(item('w', 'website', null, { intro: '', keyTakeaways: ['Aussage eins', 'Aussage zwei.'], bulletPoints: ['Thema eins', 'Thema zwei'] })),
    'Aussage eins. Aussage zwei. Thema eins.'
  )
  assert.equal(websiteSummary(item('w', 'website', null, { intro: '', keyTakeaways: [], bulletPoints: [] })), '')
})

test('social posts (Kanban #39) are a source type of their own, after Website (RSS), and never summarised', () => {
  const social = item('s1', 'social', '2026-10-06T07:00:00.000Z', { intro: '', bulletPoints: [], keyTakeaways: [], reflection: null })
  assert.equal(digestSourceType(social), 'social')
  assert.deepEqual(ids(sortDigestItems([social, ...MIXED])), ['p1', 'p2', 'y1', 'y2', 'w1', 'w2', 's1'])
  assert.equal(hasSummaryContent(social), false)
  assert.equal(websiteSummary(social), '', 'never treated as a website article')
  assert.doesNotMatch(buildDigestOverviewPrompt([social, ...MIXED], {}), /s1|Social/)
})
