// Mastodon sources: input parsing (profile URL or @user@instance), normalising API statuses and
// RSS items into posts, the boost/reply filter and resolving an account for the preview.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import {
  MASTODON_RSS_CUSTOM_FIELDS,
  buildMastodonStatusesUrl,
  fetchMastodonPosts,
  isImportablePost,
  normalizeMastodonRssItem,
  normalizeMastodonStatus,
  parseMastodonInput,
  resolveMastodonAccount,
} from '../../src/lib/social/mastodon.mjs'
import { ACCOUNT_ID, INSTANCE, RSS_URL, account, fakeFetch, mastodonRss, status } from '../helpers/mastodon-fixtures.mjs'

const parser = new Parser({ customFields: MASTODON_RSS_CUSTOM_FIELDS })
const parseXml = (xml) => parser.parseString(xml)
const LOOKUP_URL = `${INSTANCE}/api/v1/accounts/lookup?acct=anna`

// ─── Input ───────────────────────────────────────────────────────────

test('Handle und Profil-URL werden auf Benutzername und Instanz zurückgeführt', () => {
  const expected = { username: 'anna', host: 'social.example' }
  for (const input of [
    '@anna@social.example',
    'anna@social.example',
    '  @anna@Social.Example ',
    'https://social.example/@anna',
    'https://social.example/@anna/',
    'social.example/@anna',
    'https://social.example/@anna/with_replies',
    'https://social.example/@anna/109000000000000123',
    'https://social.example/users/anna',
  ]) {
    assert.deepEqual(parseMastodonInput(input), expected, input)
  }
  // A remote profile viewed on another instance points to the account's home instance.
  assert.deepEqual(parseMastodonInput('https://other.example/@anna@social.example'), expected)
})

test('ungültige Eingaben werden abgelehnt', () => {
  for (const input of ['', '   ', 'anna', '@anna', 'https://social.example/', 'https://social.example/about',
    'ftp://social.example/@anna', 'anna@localhost', '@an na@social.example', 'x'.repeat(600), null, 42,
    'https://social.example/@anna%E0%A4%A', 'https://127.0.0.1/@anna', 'https://social.example:8443/@anna']) {
    assert.equal(parseMastodonInput(input), null, String(input))
  }
})

test('die Status-URL der API schließt Boosts und Replies serverseitig aus', () => {
  assert.equal(
    buildMastodonStatusesUrl(INSTANCE, ACCOUNT_ID),
    `${INSTANCE}/api/v1/accounts/${ACCOUNT_ID}/statuses?exclude_replies=true&exclude_reblogs=true&limit=40`
  )
})

// ─── API statuses ────────────────────────────────────────────────────

test('ein API-Status wird mit Text, Link, Zeitstempel, Content-Warning und Medien übernommen', () => {
  const post = normalizeMastodonStatus(status('1001', {
    spoiler_text: 'Politik',
    sensitive: true,
    content: '<p>Hallo <script>alert(1)</script><a href="https://example.org/a" class="x">Link</a></p>',
    media_attachments: [
      { type: 'image', url: 'https://files.social.example/a.jpg', preview_url: 'https://files.social.example/a_small.jpg', description: 'Ein Bild' },
      { type: 'video', url: 'javascript:alert(1)', preview_url: null, description: null },
      { type: 'gifv', url: null, remote_url: 'https://remote.example/b.mp4', preview_url: 'http://insecure.example/p.jpg', description: '' },
    ],
    card: { url: 'https://example.org/a', title: 'Artikel A', image: 'https://example.org/a.jpg' },
  }))
  assert.deepEqual(post, {
    guid: `${INSTANCE}/@anna/1001`,
    url: `${INSTANCE}/@anna/1001`,
    publishedAt: '2026-10-05T10:00:00.000Z',
    html: '<p>Hallo <a href="https://example.org/a" rel="noopener noreferrer nofollow">Link</a></p>',
    spoiler: 'Politik',
    media: [
      { type: 'image', url: 'https://files.social.example/a.jpg', previewUrl: 'https://files.social.example/a_small.jpg', description: 'Ein Bild' },
      { type: 'gifv', url: 'https://remote.example/b.mp4', previewUrl: null, description: null },
      { type: 'link', url: 'https://example.org/a', previewUrl: 'https://example.org/a.jpg', description: 'Artikel A' },
    ],
    isBoost: false,
    isReplyToOther: false,
    visibility: 'public',
  })
})

test('Filter: Boosts und Replies an andere fallen weg, eigene Thread-Fortsetzungen bleiben', () => {
  const own = normalizeMastodonStatus(status('1'))
  const boost = normalizeMastodonStatus(status('2', { reblog: status('99', { account: { id: 'x' } }), content: '' }))
  const reply = normalizeMastodonStatus(status('3', { in_reply_to_id: '500', in_reply_to_account_id: 'someone-else' }))
  const thread = normalizeMastodonStatus(status('4', { in_reply_to_id: '1', in_reply_to_account_id: ACCOUNT_ID }))
  const priv = normalizeMastodonStatus(status('5', { visibility: 'private' }))
  const unlisted = normalizeMastodonStatus(status('6', { visibility: 'unlisted' }))
  assert.equal(isImportablePost(own), true)
  assert.equal(isImportablePost(boost), false)
  assert.equal(isImportablePost(reply), false)
  assert.equal(isImportablePost(thread), true)
  assert.equal(isImportablePost(priv), false)
  assert.equal(isImportablePost(unlisted), true)
})

test('Status ohne http(s)-URL oder ohne Zeitpunkt wird nicht übernommen', () => {
  assert.equal(normalizeMastodonStatus(status('7', { url: 'javascript:alert(1)', uri: 'javascript:alert(1)' })), null)
  assert.equal(normalizeMastodonStatus(null), null)
  // Without `url` the ActivityPub uri is the link.
  assert.equal(normalizeMastodonStatus(status('8', { url: null })).url, `${INSTANCE}/users/anna/statuses/8`)
})

// ─── RSS items ───────────────────────────────────────────────────────

test('RSS-Einträge liefern dieselbe GUID wie die API, Content-Warning und Medien', async () => {
  const feed = await parseXml(mastodonRss({
    items: [{
      url: `${INSTANCE}/@anna/1001`,
      published: '2026-10-05T10:00:00Z',
      html: '<p><strong>Inhaltswarnung:</strong> Politik</p><hr /><p>Hallo &amp; du</p>',
      media: [{ url: 'https://files.social.example/a.jpg', description: 'Ein Bild', thumbnail: 'https://files.social.example/t.jpg' }],
    }],
  }))
  const post = normalizeMastodonRssItem(feed.items[0], { origin: INSTANCE })
  assert.deepEqual(post, {
    guid: `${INSTANCE}/@anna/1001`,
    url: `${INSTANCE}/@anna/1001`,
    publishedAt: '2026-10-05T10:00:00.000Z',
    html: '<p>Hallo &amp; du</p>',
    spoiler: 'Politik',
    media: [{ type: 'image', url: 'https://files.social.example/a.jpg', previewUrl: 'https://files.social.example/t.jpg', description: 'Ein Bild' }],
    isBoost: false,
    isReplyToOther: false,
    visibility: 'public',
  })
  assert.equal(post.guid, normalizeMastodonStatus(status('1001')).guid)
})

test('RSS-Eintrag ohne eigene Post-URL der Instanz wird verworfen', async () => {
  const feed = await parseXml(mastodonRss({
    items: [{ url: 'https://elsewhere.example/@bob/1', published: '2026-10-05T10:00:00Z', html: '<p>fremd</p>' }],
  }))
  assert.equal(normalizeMastodonRssItem(feed.items[0], { origin: INSTANCE }), null)
})

// ─── Resolve (preview) ───────────────────────────────────────────────

test('Auflösung über die öffentliche API: Titel, Avatar, Beschreibung, RSS-URL und Konto-ID', async () => {
  const fetchImpl = fakeFetch({ [LOOKUP_URL]: { json: account() } })
  const result = await resolveMastodonAccount({ input: '@anna@social.example', fetchImpl, parseXml })
  assert.deepEqual(result, {
    ok: true,
    preview: {
      title: 'Anna Beispiel',
      description: 'Schreibt über #Stadt & Verkehr',
      imageUrl: 'https://files.social.example/accounts/avatars/anna.png',
      feedUrl: RSS_URL,
      handle: 'anna@social.example',
      accountId: ACCOUNT_ID,
      platform: 'mastodon',
    },
  })
  assert.deepEqual(fetchImpl.calls, [LOOKUP_URL])
})

test('ohne Anzeigenamen gilt der Benutzername als Titel', async () => {
  const fetchImpl = fakeFetch({ [LOOKUP_URL]: { json: account({ display_name: '', note: '' }) } })
  const result = await resolveMastodonAccount({ input: 'https://social.example/@anna', fetchImpl, parseXml })
  assert.equal(result.preview.title, '@anna@social.example')
  assert.equal(result.preview.description, null)
})

test('API gesperrt → RSS-Fallback ohne Konto-ID', async () => {
  const fetchImpl = fakeFetch({
    [LOOKUP_URL]: { status: 401, body: '{"error":"This API requires an authenticated user"}' },
    [RSS_URL]: { body: mastodonRss() },
  })
  const result = await resolveMastodonAccount({ input: '@anna@social.example', fetchImpl, parseXml })
  assert.equal(result.ok, true)
  assert.equal(result.preview.accountId, null)
  assert.equal(result.preview.title, 'Anna Beispiel')
  assert.equal(result.preview.feedUrl, RSS_URL)
  assert.equal(result.preview.imageUrl, 'https://files.social.example/accounts/avatars/anna.png')
})

test('unbekanntes Konto, ungültige Eingabe und interne Hosts liefern Fehlerschlüssel', async () => {
  const notFound = await resolveMastodonAccount({ input: '@anna@social.example', fetchImpl: fakeFetch({}), parseXml })
  assert.deepEqual(notFound, { ok: false, status: 404, errorKey: 'socialErrorNotFound' })

  const invalid = await resolveMastodonAccount({ input: 'anna', fetchImpl: fakeFetch({}), parseXml })
  assert.deepEqual(invalid, { ok: false, status: 400, errorKey: 'socialErrorInvalidInput' })

  const internal = await resolveMastodonAccount({ input: '@anna@127.0.0.1', fetchImpl: fakeFetch({}), parseXml })
  assert.deepEqual(internal, { ok: false, status: 400, errorKey: 'socialErrorInvalidInput' })

  const privateDns = await resolveMastodonAccount({
    input: '@anna@social.example', fetchImpl: fakeFetch({ [LOOKUP_URL]: { json: account() } }), parseXml,
    lookup: async () => [{ address: '10.0.0.5' }],
  })
  assert.deepEqual(privateDns, { ok: false, status: 400, errorKey: 'socialErrorNotAllowed' })

  const broken = await resolveMastodonAccount({
    input: '@anna@social.example',
    fetchImpl: fakeFetch({ [LOOKUP_URL]: { status: 500, body: '' }, [RSS_URL]: { status: 500, body: '' } }),
    parseXml,
  })
  assert.deepEqual(broken, { ok: false, status: 422, errorKey: 'socialErrorFetch' })
})

// ─── Fetching posts (feed check) ─────────────────────────────────────

const SUBSCRIPTION = { id: 'social-1', feed_url: RSS_URL, social_account_id: ACCOUNT_ID }
const STATUSES_URL = buildMastodonStatusesUrl(INSTANCE, ACCOUNT_ID)

test('Posts kommen primär aus der API', async () => {
  const fetchImpl = fakeFetch({ [STATUSES_URL]: { json: [status('1'), status('2')] } })
  const { posts, note } = await fetchMastodonPosts({ subscription: SUBSCRIPTION, fetchImpl, parseXml })
  assert.deepEqual(posts.map((p) => p.guid), [`${INSTANCE}/@anna/1`, `${INSTANCE}/@anna/2`])
  assert.equal(note, undefined)
  assert.deepEqual(fetchImpl.calls, [STATUSES_URL])
})

test('API-Fehler → RSS-Fallback mit Hinweis; ohne Konto-ID direkt RSS ohne Hinweis', async () => {
  const rss = mastodonRss({ items: [{ url: `${INSTANCE}/@anna/1`, published: '2026-10-05T10:00:00Z', html: '<p>eins</p>' }] })
  const fallback = await fetchMastodonPosts({
    subscription: SUBSCRIPTION,
    fetchImpl: fakeFetch({ [STATUSES_URL]: { status: 401, body: '' }, [RSS_URL]: { body: rss } }),
    parseXml,
  })
  assert.deepEqual(fallback.posts.map((p) => p.guid), [`${INSTANCE}/@anna/1`])
  assert.match(fallback.note, /Mastodon-API.*HTTP 401.*RSS/)

  const rssOnly = await fetchMastodonPosts({
    subscription: { ...SUBSCRIPTION, social_account_id: null },
    fetchImpl: fakeFetch({ [RSS_URL]: { body: rss } }),
    parseXml,
  })
  assert.equal(rssOnly.posts.length, 1)
  assert.equal(rssOnly.note, undefined)
})

test('API und RSS nicht erreichbar → Fehler mit beiden Ursachen', async () => {
  await assert.rejects(
    fetchMastodonPosts({ subscription: SUBSCRIPTION, fetchImpl: fakeFetch({}), parseXml }),
    /Mastodon-API: HTTP 404.*RSS.*HTTP 404/
  )
})

test('eine Feed-URL auf einen internen Host wird nie abgerufen', async () => {
  const fetchImpl = fakeFetch({})
  await assert.rejects(
    fetchMastodonPosts({ subscription: { id: 'x', feed_url: 'http://127.0.0.1/@anna.rss', social_account_id: ACCOUNT_ID }, fetchImpl, parseXml }),
    /Interne Adresse/
  )
  assert.deepEqual(fetchImpl.calls, [])
})
