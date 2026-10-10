import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SOURCE_TYPE_ORDER,
  digestSourceType,
  MIN_OVERVIEW_ITEMS,
  MAX_OVERVIEW_ITEMS,
  sortDigestItems,
  sortByOverviewPriority,
  hasSummaryContent,
  buildDigestOverviewPrompt,
  parseDigestOverview,
  createDigestOverviewGenerator,
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

test('single summaries stay chronological across source types (oldest first)', () => {
  assert.deepEqual(ids(sortDigestItems(MIXED)), ['y1', 'p1', 'w1', 'p2', 'y2', 'w2'])
})

test('overview priority: podcasts, then YouTube, then Website (RSS); chronological within a type', () => {
  assert.deepEqual(SOURCE_TYPE_ORDER, ['podcast', 'youtube', 'website', 'social'])
  assert.deepEqual(ids(sortByOverviewPriority(MIXED)), ['p1', 'p2', 'y1', 'y2', 'w1', 'w2'])
  assert.deepEqual(ids(sortByOverviewPriority([item('x', 'weird', null), item('legacy', undefined, null), MIXED[0]])), ['legacy', 'w1', 'x'])
})

test('both orders are deterministic for every input order and do not mutate the input', () => {
  const before = ids(MIXED)
  const permutations = [[...MIXED].reverse(), [MIXED[3], MIXED[0], MIXED[5], MIXED[1], MIXED[4], MIXED[2]]]
  for (const sort of [sortDigestItems, sortByOverviewPriority]) {
    const expected = ids(sort(MIXED))
    for (const input of permutations) assert.deepEqual(ids(sort(input)), expected)
  }
  assert.deepEqual(ids(MIXED), before)
})

test('ties on time are broken by source, title and id; missing or invalid dates go last', () => {
  const same = '2026-10-07T08:00:00.000Z'
  const items = [
    item('b', 'podcast', same, { podcastTitle: 'B' }),
    item('a2', 'youtube', same, { podcastTitle: 'A', episodeTitle: 'Z' }),
    item('a1', 'website', same, { podcastTitle: 'A', episodeTitle: 'Y' }),
    item('nodate', 'podcast', null),
    item('invalid', 'podcast', 'kein Datum'),
    item('early', undefined, '2026-10-01T00:00:00.000Z'),
  ]
  assert.deepEqual(ids(sortDigestItems(items)), ['early', 'a1', 'a2', 'b', 'invalid', 'nodate'])
  assert.deepEqual(sortDigestItems(undefined), [])
  assert.deepEqual(sortByOverviewPriority(undefined), [])
})

test('hasSummaryContent: intro or bullets count, empty fallbacks do not', () => {
  assert.equal(hasSummaryContent(item('a', 'podcast', null)), true)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: '', bulletPoints: [], keyTakeaways: ['k'] })), true)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: '  ', bulletPoints: [' '], keyTakeaways: [] })), false)
  assert.equal(hasSummaryContent(item('a', 'podcast', null, { intro: null, bulletPoints: null, keyTakeaways: undefined })), false)
})

test('overview prompt is built from the stored summaries and metadata in priority order, never from transcripts', () => {
  const items = MIXED.map((i) => ({ ...i, transcript: 'GEHEIMES VOLLTRANSKRIPT', reflection: `Einordnung ${i.id}` }))
  const prompt = buildDigestOverviewPrompt(items, { tone: 'concise' })

  assert.doesNotMatch(prompt, /GEHEIMES VOLLTRANSKRIPT/)
  assert.match(prompt, /^Du schreibst den Überblick am Anfang meines Castletter-Digests/)
  assert.match(prompt, /Inhalte \(6\):/)
  assert.match(prompt, /\[1\] Podcast-Episode \(Priorität 1\) · Quelle: Quelle p1 · 2026-10-06\nTitel: Titel p1\nZusammenfassung: Zusammenfassung p1\.\nHauptthemen: Thema p1\nWichtige Aussagen: Aussage p1\nEinordnung: Einordnung p1/)
  assert.ok(prompt.indexOf('[3] YouTube-Video (Priorität 2) · Quelle: Quelle y1') < prompt.indexOf('[5] Website-Artikel (Priorität 3) · Quelle: Quelle w1'))
  assert.match(prompt, /Verknüpfe die Inhalte ausdrücklich/)
  assert.match(prompt, /Wiederhole keine einzelnen Stichpunkte/)
  assert.match(prompt, /statt Zusammenhänge zu konstruieren/)
  for (const heading of ['Überblick', 'Kernthemen', 'Zusammenhänge und Spannungen', 'Einordnung']) {
    assert.ok(prompt.includes(`\n## ${heading}\n`), heading)
  }
  assert.ok(prompt.endsWith(buildStyleInstructions({ tone: 'concise' })))
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

const OVERVIEW_ANSWER = `## Überblick
Heute geht es um Energie und Kommunen.
Mehrere Quellen sehen Handlungsdruck.

## Kernthemen
- Wärmewende: „Quelle p1“ und „Quelle w1“ sehen Kommunen in der Pflicht.
- Finanzierung bleibt offen.

## Zusammenhänge und Spannungen
- „Quelle y1“ widerspricht „Quelle p1“ bei den Kosten.

## Einordnung
Insgesamt ein Thema für die nächsten Monate.`

test('parseDigestOverview extracts all sections and falls back to plain text', () => {
  assert.deepEqual(parseDigestOverview(OVERVIEW_ANSWER), {
    summary: 'Heute geht es um Energie und Kommunen. Mehrere Quellen sehen Handlungsdruck.',
    themes: ['Wärmewende: „Quelle p1“ und „Quelle w1“ sehen Kommunen in der Pflicht.', 'Finanzierung bleibt offen.'],
    connections: ['„Quelle y1“ widerspricht „Quelle p1“ bei den Kosten.'],
    reflection: 'Insgesamt ein Thema für die nächsten Monate.',
  })
  assert.deepEqual(parseDigestOverview('## Überblick\nNur das.'), { summary: 'Nur das.', themes: [], connections: [], reflection: null })
  assert.deepEqual(parseDigestOverview('# Freitext\nOhne Struktur.'), { summary: 'Freitext Ohne Struktur.', themes: [], connections: [], reflection: null })
  for (const empty of [undefined, null, '', '  \n ', '##']) assert.equal(parseDigestOverview(empty), null)
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
})

test('overview prompt weighs podcasts first and most, YouTube next, articles mainly as supplement', () => {
  const prompt = buildDigestOverviewPrompt(MIXED)
  const rules = [
    'Gewichtung nach Quelltyp (bestimmt Reihenfolge und Raum, nicht die Wahrheit einer Aussage)',
    '1. Podcast-Episoden haben die höchste Priorität: Baue Überblick und Kernthemen in erster Linie auf ihnen auf, nenne sie zuerst und gib ihnen den meisten Raum.',
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

test('social posts (Kanban #39) are a source type of their own, ranked last, and never summarised', () => {
  const social = item('s1', 'social', '2026-10-06T07:00:00.000Z', { intro: '', bulletPoints: [], keyTakeaways: [], reflection: null })
  assert.equal(digestSourceType(social), 'social')
  assert.deepEqual(ids(sortByOverviewPriority([social, ...MIXED])), ['p1', 'p2', 'y1', 'y2', 'w1', 'w2', 's1'])
  assert.deepEqual(ids(sortDigestItems([social, ...MIXED])).slice(0, 2), ['s1', 'y1'])
  assert.equal(hasSummaryContent(social), false)
  assert.doesNotMatch(buildDigestOverviewPrompt([social, ...MIXED], {}), /s1|Social/)
})
