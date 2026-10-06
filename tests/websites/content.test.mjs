import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveWebsiteContent,
  WebsitePermanentError,
  WebsiteTemporaryError,
} from '../../src/lib/websites/content.mjs'
import { PermanentError } from '../../src/lib/transcription/audio-transcriber.mjs'
import { articlePage, fakeFetch, fakeLookup, longHtml, longText } from '../helpers/website-fixtures.mjs'

const ARTICLE = 'https://blog.example.com/2026/waermenetz'
const TEASER = 'Die Stadtwerke stellen das Wärmenetz vor …'

async function rejectsWithCode(promise, ErrorClass, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ErrorClass, `erwartet ${ErrorClass.name}, erhalten ${err?.name}: ${err?.message}`)
    assert.equal(err.code, code)
    return true
  })
}

test('vollständiger Feed-Text wird ohne Netzabruf verwendet', async () => {
  const fetchImpl = fakeFetch({})
  const result = await resolveWebsiteContent({ episode: { feed_content: longText(), article_url: ARTICLE }, fetchImpl })
  assert.deepEqual(result, { transcript: longText().trim(), source: 'feed_content' })
  assert.deepEqual(fetchImpl.calls, [])
})

test('Teaser im Feed → nur der verlinkte öffentliche Artikel wird geladen und bereinigt', async () => {
  const fetchImpl = fakeFetch({ [ARTICLE]: { body: articlePage() } })
  const result = await resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl, lookup: fakeLookup() })
  assert.equal(result.source, 'article')
  assert.match(result.transcript, /^Das neue Wärmenetz\n\nAbsatz 1:/)
  assert.doesNotMatch(result.transcript, /Impressum|Ressorts|tracking/)
  assert.deepEqual(fetchImpl.calls, [ARTICLE])
})

test('Weiterleitung auf eine öffentliche Artikel-URL wird verfolgt', async () => {
  const fetchImpl = fakeFetch({
    [ARTICLE]: { status: 301, headers: { location: '/2026/waermenetz/' } },
    [`${ARTICLE}/`]: { body: articlePage() },
  })
  const result = await resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl })
  assert.equal(result.source, 'article')
})

test('Paywall (schema.org isAccessibleForFree=false) → paywalled, auch wenn der Text versteckt im HTML steht', async () => {
  const fetchImpl = fakeFetch({
    [ARTICLE]: { body: articlePage({ head: '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>', body: longHtml() }) },
  })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl }), WebsitePermanentError, 'paywalled')
})

test('Paywall-Container mit nur kurzem Anriss → paywalled', async () => {
  const fetchImpl = fakeFetch({
    [ARTICLE]: { body: articlePage({ body: '<p>Nur der erste Absatz ist frei.</p><div class="paywall">Jetzt abonnieren</div>' }) },
  })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl }), WebsitePermanentError, 'paywalled')
})

test('Login-Weiterleitung und HTTP 401/402/403 → access_restricted', async () => {
  const redirect = fakeFetch({
    [ARTICLE]: { status: 302, headers: { location: 'https://blog.example.com/login?next=/2026/waermenetz' } },
    'https://blog.example.com/login?next=/2026/waermenetz': { body: articlePage({ body: longHtml() }) },
  })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl: redirect }), WebsitePermanentError, 'access_restricted')

  for (const status of [401, 402, 403]) {
    const fetchImpl = fakeFetch({ [ARTICLE]: { status } })
    await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl }), WebsitePermanentError, 'access_restricted')
  }
})

test('kein vollständiger Text (kurze Seite, kein Link) → content_incomplete, permanent', async () => {
  const shortPage = fakeFetch({ [ARTICLE]: { body: articlePage({ body: '<p>Nur ein Satz.</p>' }) } })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl: shortPage }), WebsitePermanentError, 'content_incomplete')
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: null } }), WebsitePermanentError, 'content_incomplete')

  const pdf = fakeFetch({ [ARTICLE]: { body: '%PDF', headers: { 'content-type': 'application/pdf' } } })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl: pdf }), WebsitePermanentError, 'content_incomplete')
})

test('kurzer, ungekürzter Feed-Text wird verwendet, wenn die öffentliche Seite nicht mehr Text enthält', async () => {
  const shortComplete = longText(5)
  assert.ok(shortComplete.length > 800 && shortComplete.length < 1500)
  const fetchImpl = fakeFetch({ [ARTICLE]: { body: articlePage({ body: longHtml(4) }) } })
  const result = await resolveWebsiteContent({ episode: { feed_content: shortComplete, article_url: ARTICLE }, fetchImpl })
  assert.deepEqual(result, { transcript: shortComplete, source: 'feed_content' })

  // A cut-off feed text is never used, however long the page is not.
  const truncated = `${longText(5)} […]`
  await rejectsWithCode(
    resolveWebsiteContent({ episode: { feed_content: truncated, article_url: ARTICLE }, fetchImpl: fakeFetch({ [ARTICLE]: { body: articlePage({ body: '<p>kurz</p>' }) } }) }),
    WebsitePermanentError,
    'content_incomplete'
  )
})

test('Artikel gelöscht (404/410) oder interne Adresse → article_unavailable', async () => {
  const gone = fakeFetch({ [ARTICLE]: { status: 410 } })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl: gone }), WebsitePermanentError, 'article_unavailable')

  const internal = fakeFetch({})
  await rejectsWithCode(
    resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: 'http://169.254.169.254/latest/meta-data' }, fetchImpl: internal }),
    WebsitePermanentError,
    'article_unavailable'
  )
  assert.deepEqual(internal.calls, [])

  const rebinding = fakeFetch({ [ARTICLE]: { body: articlePage() } })
  await rejectsWithCode(
    resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl: rebinding, lookup: fakeLookup({ 'blog.example.com': '10.0.0.5' }) }),
    WebsitePermanentError,
    'article_unavailable'
  )
  assert.deepEqual(rebinding.calls, [])
})

test('Weiterleitung auf eine interne Adresse wird nicht verfolgt', async () => {
  const fetchImpl = fakeFetch({ [ARTICLE]: { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } } })
  await rejectsWithCode(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl }), WebsitePermanentError, 'article_unavailable')
  assert.deepEqual(fetchImpl.calls, [ARTICLE])
})

test('Serverfehler und Netzwerkfehler sind temporär (kein PermanentError)', async () => {
  for (const route of [{ status: 503 }, { status: 429 }, new TypeError('fetch failed')]) {
    const fetchImpl = fakeFetch({ [ARTICLE]: route })
    await assert.rejects(resolveWebsiteContent({ episode: { feed_content: TEASER, article_url: ARTICLE }, fetchImpl }), (err) => {
      assert.ok(err instanceof WebsiteTemporaryError)
      assert.ok(!(err instanceof PermanentError))
      assert.equal(err.code, 'article_fetch_failed')
      return true
    })
  }
})
