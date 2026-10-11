// Bluesky accounts as social sources (Kanban #40): input parsing, rich text → HTML, the
// normalisation of author-feed items and RSS items, resolving the profile (public API, RSS as
// fallback) and reading posts – always with the DID as the stable identity.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import {
  blueskyPostUrl,
  blueskyTextToHtml,
  buildBlueskyAuthorFeedUrl,
  buildBlueskyProfileUrl,
  buildBlueskyRssUrl,
  fetchBlueskyPosts,
  normalizeBlueskyFeedItem,
  normalizeBlueskyRssItem,
  parseBlueskyInput,
  resolveBlueskyAccount,
} from '../../src/lib/social/bluesky.mjs'
import { isImportablePost } from '../../src/lib/social/mastodon.mjs'
import { fakeFetch } from '../helpers/mastodon-fixtures.mjs'
import { DID, HANDLE, OTHER_DID, RSS_URL, blueskyRss, feedItem, postUri, postUrl, profile, replyTo } from '../helpers/bluesky-fixtures.mjs'

const parser = new Parser()
const parseXml = (xml) => parser.parseString(xml)
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

// ─── Input ───────────────────────────────────────────────────────────

test('Profil-URL, Handle und DID werden erkannt', () => {
  const cases = [
    ['https://bsky.app/profile/anna.bsky.social', 'anna.bsky.social'],
    ['bsky.app/profile/Anna.Bsky.Social/', 'anna.bsky.social'],
    ['https://www.bsky.app/profile/anna.example.org/post/3kabc', 'anna.example.org'],
    [`https://bsky.app/profile/${DID}`, DID],
    ['@anna.bsky.social', 'anna.bsky.social'],
    ['  anna.example.org ', 'anna.example.org'],
    [DID, DID],
    ['did:web:anna.example.org', 'did:web:anna.example.org'],
  ]
  for (const [input, actor] of cases) {
    assert.deepEqual(parseBlueskyInput(input), { actor }, input)
  }
})

test('ungültige oder fremde Eingaben werden abgelehnt', () => {
  for (const input of [
    '', '   ', null, 42, 'anna', '@anna', '@anna@mastodon.social', 'https://mastodon.social/@anna',
    'https://evil.example/profile/anna.bsky.social', 'http://bsky.app.evil.example/profile/a.b',
    'https://bsky.app/search?q=anna', 'https://bsky.app/profile/', 'ftp://bsky.app/profile/a.bsky.social',
    'https://user:pw@bsky.app/profile/a.bsky.social', 'did:plc:short', 'did:key:z6Mk', 'anna.123',
    'anna..bsky.social', '-anna.bsky.social', 'a'.repeat(300) + '.bsky.social', 'anna.local', 'anna.onion',
  ]) {
    assert.equal(parseBlueskyInput(input), null, String(input))
  }
})

test('URLs der öffentlichen API und des RSS-Feeds', () => {
  assert.equal(buildBlueskyProfileUrl(HANDLE), 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=anna.bsky.social')
  assert.equal(
    buildBlueskyAuthorFeedUrl(DID),
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(DID)}&filter=posts_and_author_threads&limit=40`
  )
  assert.equal(buildBlueskyRssUrl(DID), RSS_URL)
  assert.equal(blueskyPostUrl(DID, '3kabc'), `https://bsky.app/profile/${DID}/post/3kabc`)
})

// ─── Rich text ───────────────────────────────────────────────────────

test('Facets werden über UTF-8-Byte-Offsets zu Links, Text wird escaped', () => {
  const text = 'Grüße 🚲 an @bob.bsky.social: example.org/rad… #Verkehr <b>'
  const bytes = (s) => Buffer.byteLength(s, 'utf8')
  const at = (needle) => {
    const index = text.indexOf(needle)
    return { byteStart: bytes(text.slice(0, index)), byteEnd: bytes(text.slice(0, index)) + bytes(needle) }
  }
  const facets = [
    { index: at('@bob.bsky.social'), features: [{ $type: 'app.bsky.richtext.facet#mention', did: OTHER_DID }] },
    { index: at('example.org/rad…'), features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.org/radweg' }] },
    { index: at('#Verkehr'), features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'Verkehr' }] },
  ]
  assert.equal(
    blueskyTextToHtml(text, facets),
    `<p>Grüße 🚲 an <a href="https://bsky.app/profile/${OTHER_DID}">@bob.bsky.social</a>: ` +
      '<a href="https://example.org/radweg">example.org/rad…</a> <a href="https://bsky.app/hashtag/Verkehr">#Verkehr</a> &lt;b&gt;</p>'
  )
})

test('Absätze und Zeilenumbrüche bleiben, unsichere oder kaputte Facets werden ignoriert', () => {
  assert.equal(blueskyTextToHtml('Eins\nZwei\n\nDrei'), '<p>Eins<br>Zwei</p><p>Drei</p>')
  const text = 'klick hier und da'
  assert.equal(
    blueskyTextToHtml(text, [
      { index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://a.example' }] },
      { index: { byteStart: 3, byteEnd: 8 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://overlap.example' }] },
      { index: { byteStart: 6, byteEnd: 10 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'javascript:alert(1)' }] },
      { index: { byteStart: 15, byteEnd: 99 }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://x.example' }] },
      null,
    ]),
    '<p><a href="https://a.example/">klick</a> hier und da</p>'
  )
  assert.equal(blueskyTextToHtml(''), '')
  assert.equal(blueskyTextToHtml(undefined), '')
})

// ─── Feed items ──────────────────────────────────────────────────────

test('ein eigener Post wird mit DID-Link, Text, Bildern und Zeitstempel normalisiert', () => {
  const post = normalizeBlueskyFeedItem(
    feedItem('3kimg', {
      record: { text: 'Neuer Radweg', createdAt: '2026-10-05T10:00:00.000Z' },
      post: {
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [
            { thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/x/a', fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/x/a', alt: 'Radweg' },
            { thumb: 'http://insecure.example/t', fullsize: 'javascript:alert(1)', alt: '' },
          ],
        },
      },
    }),
    { did: DID }
  )
  assert.deepEqual(post, {
    guid: postUrl('3kimg'),
    url: postUrl('3kimg'),
    publishedAt: '2026-10-05T10:00:00.000Z',
    html: '<p>Neuer Radweg</p>',
    spoiler: null,
    media: [{ type: 'image', url: 'https://cdn.bsky.app/img/feed_fullsize/plain/x/a', previewUrl: 'https://cdn.bsky.app/img/feed_thumbnail/plain/x/a', description: 'Radweg' }],
    isBoost: false,
    isReplyToOther: false,
    visibility: 'public',
  })
  assert.equal(isImportablePost(post), true)
})

test('Link-Karte, Video, Zitat und Zitat mit Medien werden zu Medien-Links', () => {
  const external = normalizeBlueskyFeedItem(
    feedItem('3kext', { post: { embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://example.org/a', title: 'Artikel', description: 'x', thumb: 'https://cdn.bsky.app/t' } } } }),
    { did: DID }
  )
  assert.deepEqual(external.media, [{ type: 'link', url: 'https://example.org/a', previewUrl: 'https://cdn.bsky.app/t', description: 'Artikel' }])

  const video = normalizeBlueskyFeedItem(
    feedItem('3kvid', { post: { embed: { $type: 'app.bsky.embed.video#view', playlist: 'https://video.bsky.app/x.m3u8', thumbnail: 'https://video.bsky.app/t.jpg', alt: 'Fahrt' } } }),
    { did: DID }
  )
  assert.deepEqual(video.media, [{ type: 'video', url: postUrl('3kvid'), previewUrl: 'https://video.bsky.app/t.jpg', description: 'Fahrt' }])

  const quoted = { $type: 'app.bsky.embed.record#viewRecord', uri: postUri('3kq', OTHER_DID), author: { did: OTHER_DID, handle: 'bob.example.org', labels: [] }, value: { text: 'geheim' } }
  const quote = normalizeBlueskyFeedItem(feedItem('3kquo', { post: { embed: { $type: 'app.bsky.embed.record#view', record: quoted } } }), { did: DID })
  assert.deepEqual(quote.media, [{ type: 'quote', url: postUrl('3kq', OTHER_DID), previewUrl: null, description: '@bob.example.org' }])
  assert.doesNotMatch(JSON.stringify(quote), /geheim/)

  const both = normalizeBlueskyFeedItem(
    feedItem('3kboth', {
      post: {
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          record: { record: quoted },
          media: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/t2', fullsize: 'https://cdn.bsky.app/f2', alt: '' }] },
        },
      },
    }),
    { did: DID }
  )
  assert.deepEqual(both.media.map((m) => m.type), ['image', 'quote'])
  assert.equal(both.media[0].description, null)
})

test('zitierte Accounts, die nicht ohne Login sichtbar sein wollen, und unbekannte Zitate fehlen', () => {
  const hidden = { $type: 'app.bsky.embed.record#viewRecord', uri: postUri('3kq', OTHER_DID), author: { did: OTHER_DID, handle: 'bob.example.org', labels: [{ val: '!no-unauthenticated' }] }, value: {} }
  const notFound = { $type: 'app.bsky.embed.record#viewNotFound', uri: postUri('3kz', OTHER_DID), notFound: true }
  for (const record of [hidden, notFound]) {
    const post = normalizeBlueskyFeedItem(feedItem('3kquo', { post: { embed: { $type: 'app.bsky.embed.record#view', record } } }), { did: DID })
    assert.deepEqual(post.media, [])
  }
})

test('Reposts, Posts anderer Autoren und Replies an andere sind nicht importierbar, eigene Threads schon', () => {
  const repost = normalizeBlueskyFeedItem(
    feedItem('3krep', { post: { uri: postUri('3krep', OTHER_DID), author: { did: OTHER_DID, handle: 'bob.example.org' } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }),
    { did: DID }
  )
  assert.equal(repost.isBoost, true)
  assert.equal(isImportablePost(repost), false)

  const foreign = normalizeBlueskyFeedItem(feedItem('3kfor', { post: { uri: postUri('3kfor', OTHER_DID), author: { did: OTHER_DID, handle: 'b.example.org' } } }), { did: DID })
  assert.equal(isImportablePost(foreign), false)

  const replyToOther = normalizeBlueskyFeedItem(feedItem('3krpl', { record: { reply: replyTo(OTHER_DID) } }), { did: DID })
  assert.equal(replyToOther.isReplyToOther, true)
  assert.equal(isImportablePost(replyToOther), false)

  const thread = normalizeBlueskyFeedItem(feedItem('3kthr', { record: { reply: replyTo(DID) } }), { did: DID })
  assert.equal(thread.isReplyToOther, false)
  assert.equal(isImportablePost(thread), true)

  // A thread continuation under someone else's root is still a reply to the conversation of others.
  const underOther = normalizeBlueskyFeedItem(
    feedItem('3kmix', { record: { reply: { parent: { uri: postUri('p', DID) }, root: { uri: postUri('r', OTHER_DID) } } } }),
    { did: DID }
  )
  assert.equal(isImportablePost(underOther), false)
})

test('Labels für Erwachsenen- und Gewaltinhalte werden zur Inhaltswarnung', () => {
  const post = normalizeBlueskyFeedItem(
    feedItem('3klab', { record: { labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'graphic-media' }, { val: 'nudity' }] } } }),
    { did: DID }
  )
  assert.equal(post.spoiler, 'graphic-media, nudity')
  const viaPostLabels = normalizeBlueskyFeedItem(feedItem('3klb2', { post: { labels: [{ val: 'porn', src: DID }, { val: 'unrelated', src: DID }] } }), { did: DID })
  assert.equal(viaPostLabels.spoiler, 'porn')
})

test('Items ohne gültige URI oder Zeit werden verworfen', () => {
  assert.equal(normalizeBlueskyFeedItem(null, { did: DID }), null)
  assert.equal(normalizeBlueskyFeedItem(feedItem('3k', { post: { uri: 'https://evil.example' } }), { did: DID }), null)
  assert.equal(normalizeBlueskyFeedItem(feedItem('3k', { post: { uri: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.like/3k' } }), { did: DID }), null)
  assert.equal(normalizeBlueskyFeedItem(feedItem('3k', { record: { createdAt: 'gestern' }, post: { indexedAt: undefined } }), { did: DID }), null)
  // createdAt missing → indexedAt
  assert.equal(normalizeBlueskyFeedItem(feedItem('3k', { record: { createdAt: undefined } }), { did: DID }).publishedAt, '2026-10-05T10:00:01.000Z')
})

// ─── RSS items ───────────────────────────────────────────────────────

test('RSS-Items werden über die GUID auf DID-Links normalisiert, der Platzhalter für Einbettungen entfällt', async () => {
  const feed = await parseXml(
    blueskyRss({
      items: [
        { rkey: '3krss', text: 'Erste Zeile <script>\n\nZweiter Absatz\n\n[contains quote post or other embedded content]', published: '2026-10-05T10:00:00Z' },
        { rkey: '3kfrm', did: OTHER_DID, text: 'fremd', published: '2026-10-05T10:00:00Z' },
      ],
    })
  )
  const [own, foreign] = feed.items.map((item) => normalizeBlueskyRssItem(item, { did: DID }))
  assert.deepEqual(own, {
    guid: postUrl('3krss'),
    url: postUrl('3krss'),
    publishedAt: '2026-10-05T10:00:00.000Z',
    html: '<p>Erste Zeile &lt;script&gt;</p><p>Zweiter Absatz</p>',
    spoiler: null,
    media: [],
    isBoost: false,
    isReplyToOther: false,
    visibility: 'public',
  })
  assert.equal(foreign, null)
})

// ─── Resolve ─────────────────────────────────────────────────────────

test('Auflösung über die öffentliche API liefert DID, Handle und DID-basierten Feed', async () => {
  const fetchImpl = fakeFetch({ [buildBlueskyProfileUrl('anna.bsky.social')]: { json: profile() } })
  const result = await resolveBlueskyAccount({ input: 'https://bsky.app/profile/anna.bsky.social', fetchImpl, lookup: publicLookup, parseXml })
  assert.deepEqual(result, {
    ok: true,
    preview: {
      title: 'Anna Beispiel',
      description: 'Schreibt über #Stadt & Verkehr',
      imageUrl: `https://cdn.bsky.app/img/avatar/plain/${DID}/bafkreiavatar`,
      feedUrl: RSS_URL,
      handle: HANDLE,
      accountId: DID,
      platform: 'bluesky',
    },
  })
})

test('ohne Anzeigenamen wird das Handle zum Titel; handle.invalid wird nicht übernommen', async () => {
  const fetchImpl = fakeFetch({ [buildBlueskyProfileUrl(DID)]: { json: profile({ displayName: '  ', handle: 'handle.invalid', description: '' }) } })
  const result = await resolveBlueskyAccount({ input: DID, fetchImpl, lookup: publicLookup, parseXml })
  assert.equal(result.ok, true)
  assert.equal(result.preview.title, DID)
  assert.equal(result.preview.handle, DID)
  assert.equal(result.preview.description, null)
})

test('unbekannter Account → nicht gefunden; Accounts ohne Login-Freigabe werden abgelehnt', async () => {
  const notFound = fakeFetch({
    [buildBlueskyProfileUrl('weg.bsky.social')]: { status: 400, json: { error: 'InvalidRequest', message: 'Profile not found' } },
    [buildBlueskyRssUrl('weg.bsky.social')]: { status: 404, body: 'not found' },
  })
  assert.deepEqual(await resolveBlueskyAccount({ input: 'weg.bsky.social', fetchImpl: notFound, lookup: publicLookup, parseXml }), {
    ok: false, status: 404, errorKey: 'socialErrorNotFound',
  })

  const hidden = fakeFetch({ [buildBlueskyProfileUrl(HANDLE)]: { json: profile({ labels: [{ val: '!no-unauthenticated', src: DID }] }) } })
  assert.deepEqual(await resolveBlueskyAccount({ input: HANDLE, fetchImpl: hidden, lookup: publicLookup, parseXml }), {
    ok: false, status: 403, errorKey: 'socialErrorNotPublic',
  })

  assert.deepEqual(await resolveBlueskyAccount({ input: 'nope', fetchImpl: notFound, lookup: publicLookup, parseXml }), {
    ok: false, status: 400, errorKey: 'socialErrorInvalidInput',
  })
})

test('API nicht erreichbar → RSS-Fallback ermittelt DID aus der GUID', async () => {
  const fetchImpl = fakeFetch({
    [buildBlueskyProfileUrl(HANDLE)]: { status: 502, body: 'bad gateway' },
    [buildBlueskyRssUrl(HANDLE)]: { body: blueskyRss({ items: [{ rkey: '3krss', text: 'Hallo', published: '2026-10-05T10:00:00Z' }] }) },
  })
  const result = await resolveBlueskyAccount({ input: `@${HANDLE}`, fetchImpl, lookup: publicLookup, parseXml })
  assert.deepEqual(result, {
    ok: true,
    preview: { title: 'Anna Beispiel', description: 'Schreibt über #Stadt & Verkehr', imageUrl: null, feedUrl: RSS_URL, handle: HANDLE, accountId: DID, platform: 'bluesky' },
  })
})

test('RSS-Fallback ohne Posts kann keine DID ermitteln → Fehler statt Quelle ohne stabile ID', async () => {
  const fetchImpl = fakeFetch({
    [buildBlueskyProfileUrl(HANDLE)]: { status: 500, body: 'x' },
    [buildBlueskyRssUrl(HANDLE)]: { body: blueskyRss({ items: [] }) },
  })
  assert.deepEqual(await resolveBlueskyAccount({ input: HANDLE, fetchImpl, lookup: publicLookup, parseXml }), {
    ok: false, status: 422, errorKey: 'socialErrorFetch',
  })
})

test('API liefert eine DID in ungültigem Format → kein Anlegen', async () => {
  const fetchImpl = fakeFetch({
    [buildBlueskyProfileUrl(HANDLE)]: { json: profile({ did: 'did:evil:x' }) },
    [buildBlueskyRssUrl(HANDLE)]: { status: 404, body: '' },
  })
  const result = await resolveBlueskyAccount({ input: HANDLE, fetchImpl, lookup: publicLookup, parseXml })
  assert.equal(result.ok, false)
})

// ─── Posts for the feed check ────────────────────────────────────────

const subscription = { feed_url: RSS_URL, social_account_id: DID, social_handle: HANDLE }

test('Posts kommen über getAuthorFeed mit der DID; das aktuelle Handle wird gemeldet', async () => {
  const fetchImpl = fakeFetch({
    [buildBlueskyAuthorFeedUrl(DID)]: { json: { feed: [feedItem('3ka', { post: { author: { did: DID, handle: 'anna.example.org', labels: [] } } }), { broken: true }] } },
  })
  const { posts, note, handle } = await fetchBlueskyPosts({ subscription, fetchImpl, parseXml })
  assert.deepEqual(posts.map((p) => p.guid), [postUrl('3ka')])
  assert.equal(note, undefined)
  assert.equal(handle, 'anna.example.org')
  assert.deepEqual(fetchImpl.calls, [buildBlueskyAuthorFeedUrl(DID)])
})

test('API-Fehler → RSS über die DID-basierte feed_url, mit Hinweis', async () => {
  const fetchImpl = fakeFetch({
    [buildBlueskyAuthorFeedUrl(DID)]: { status: 503, body: 'x' },
    [RSS_URL]: { body: blueskyRss({ items: [{ rkey: '3kb', text: 'per RSS', published: '2026-10-05T10:00:00Z' }] }) },
  })
  const { posts, note } = await fetchBlueskyPosts({ subscription, fetchImpl, parseXml })
  assert.deepEqual(posts.map((p) => p.guid), [postUrl('3kb')])
  assert.match(note, /Bluesky-API nicht erreichbar \(HTTP 503\)/)
})

test('beide Wege kaputt → Fehler; Autor ohne Login-Freigabe → Fehler ohne Posts', async () => {
  const down = fakeFetch({ [buildBlueskyAuthorFeedUrl(DID)]: { status: 503, body: 'x' }, [RSS_URL]: { status: 500, body: 'x' } })
  await assert.rejects(fetchBlueskyPosts({ subscription, fetchImpl: down, parseXml }), /Bluesky-API: HTTP 503; RSS-Feed: HTTP 500/)

  const hidden = fakeFetch({
    [buildBlueskyAuthorFeedUrl(DID)]: { json: { feed: [feedItem('3ka', { post: { author: { did: DID, handle: HANDLE, labels: [{ val: '!no-unauthenticated' }] } } })] } },
  })
  await assert.rejects(fetchBlueskyPosts({ subscription, fetchImpl: hidden, parseXml }), /nicht öffentlich/)
})

test('eine Quelle ohne gültige DID wird nicht abgerufen', async () => {
  const fetchImpl = fakeFetch({})
  await assert.rejects(fetchBlueskyPosts({ subscription: { ...subscription, social_account_id: null }, fetchImpl, parseXml }), /DID/)
  assert.deepEqual(fetchImpl.calls, [])
})
