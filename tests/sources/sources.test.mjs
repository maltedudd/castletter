import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SOURCE_TYPES,
  addSourceReducer,
  buildSourceInsert,
  initialAddSourceState,
  isSourceType,
  resolveSourcePreview,
  saveSource,
} from '../../src/lib/sources/sources.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const USER_ID = 'user-1'
const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

/** Records every request and answers from `routes` keyed by URL path. */
function makeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method })
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch ${url}`)
    return route
  }
  return { fetchImpl, calls }
}

// ─── Source type selection ───────────────────────────────────────────

test('source types are podcast RSS and YouTube channel', () => {
  assert.deepEqual(SOURCE_TYPES, ['podcast', 'youtube'])
  assert.equal(isSourceType('podcast'), true)
  assert.equal(isSourceType('youtube'), true)
  assert.equal(isSourceType('rss'), false)
  assert.equal(isSourceType(undefined), false)
})

test('the add flow starts without a selected source type', () => {
  assert.deepEqual(initialAddSourceState, { type: null, input: '', preview: null, error: null })
})

test('selecting a source type shows that type without input or preview', () => {
  const podcast = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'podcast' })
  assert.equal(podcast.type, 'podcast')
  assert.equal(podcast.input, '')
  assert.equal(podcast.preview, null)

  const youtube = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'youtube' })
  assert.equal(youtube.type, 'youtube')
})

test('switching the source type discards input, preview and error of the previous type', () => {
  let state = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'podcast' })
  state = addSourceReducer(state, { type: 'setInput', input: 'https://example.com/feed.xml' })
  state = addSourceReducer(state, { type: 'setError', error: 'kaputt' })
  state = addSourceReducer(state, {
    type: 'setPreview',
    preview: { type: 'podcast', title: 'X', description: null, imageUrl: null, feedUrl: 'https://example.com/feed.xml', channelId: null },
  })

  state = addSourceReducer(state, { type: 'selectType', sourceType: 'youtube' })
  assert.deepEqual(state, { type: 'youtube', input: '', preview: null, error: null })
})

test('re-selecting the current type keeps the entered data', () => {
  let state = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'youtube' })
  state = addSourceReducer(state, { type: 'setInput', input: '@kanal' })
  assert.equal(addSourceReducer(state, { type: 'selectType', sourceType: 'youtube' }), state)
})

test('an unknown source type is ignored', () => {
  const state = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'rss' })
  assert.equal(state, initialAddSourceState)
})

test('cancelling the preview keeps type and input, reset clears everything but the type', () => {
  let state = addSourceReducer(initialAddSourceState, { type: 'selectType', sourceType: 'podcast' })
  state = addSourceReducer(state, { type: 'setInput', input: 'https://example.com/feed.xml' })
  state = addSourceReducer(state, {
    type: 'setPreview',
    preview: { type: 'podcast', title: 'X', description: null, imageUrl: null, feedUrl: 'https://example.com/feed.xml', channelId: null },
  })

  const cancelled = addSourceReducer(state, { type: 'cancelPreview' })
  assert.equal(cancelled.preview, null)
  assert.equal(cancelled.input, 'https://example.com/feed.xml')

  assert.deepEqual(addSourceReducer(state, { type: 'reset' }), { type: 'podcast', input: '', preview: null, error: null })
})

// ─── Podcast add flow ────────────────────────────────────────────────

test('podcast RSS: validates the feed, previews it and stores the podcast source', async () => {
  const { fetchImpl, calls } = makeFetch({
    '/api/podcasts/validate': jsonResponse({
      title: 'Lage der Nation',
      description: 'Politik-Podcast',
      coverImageUrl: 'https://cdn.example.com/cover.jpg',
      feedUrl: 'https://feeds.example.com/lage.xml',
    }),
  })

  const resolved = await resolveSourcePreview({ type: 'podcast', input: '  https://feeds.example.com/lage.xml ', fetchImpl })
  assert.deepEqual(calls, [{ url: '/api/podcasts/validate', method: 'POST', body: { feedUrl: 'https://feeds.example.com/lage.xml' } }])
  assert.deepEqual(resolved, {
    ok: true,
    preview: {
      type: 'podcast',
      title: 'Lage der Nation',
      description: 'Politik-Podcast',
      imageUrl: 'https://cdn.example.com/cover.jpg',
      feedUrl: 'https://feeds.example.com/lage.xml',
      channelId: null,
    },
  })

  const supabase = makeFakeSupabase({ podcast_subscriptions: [] })
  const saved = await saveSource({ supabase, userId: USER_ID, preview: resolved.preview })
  assert.deepEqual(saved, { ok: true })
  assert.deepEqual(supabase.writes, [{
    table: 'podcast_subscriptions',
    kind: 'insert',
    payload: {
      user_id: USER_ID,
      feed_url: 'https://feeds.example.com/lage.xml',
      title: 'Lage der Nation',
      description: 'Politik-Podcast',
      cover_image_url: 'https://cdn.example.com/cover.jpg',
    },
  }])
})

test('podcast RSS: shows the validation error of the API', async () => {
  const { fetchImpl } = makeFetch({
    '/api/podcasts/validate': jsonResponse({ error: 'Kein gültiger RSS-Feed' }, 422),
  })
  const resolved = await resolveSourcePreview({ type: 'podcast', input: 'https://example.com', fetchImpl })
  assert.deepEqual(resolved, { ok: false, error: 'Kein gültiger RSS-Feed' })
})

test('podcast RSS: falls back to a translated message when the API gives no error text', async () => {
  const { fetchImpl } = makeFetch({ '/api/podcasts/validate': jsonResponse({}, 500) })
  const resolved = await resolveSourcePreview({ type: 'podcast', input: 'https://example.com', fetchImpl })
  assert.deepEqual(resolved, { ok: false, errorKey: 'errorValidateFeed' })
})

test('podcast RSS: a duplicate feed reports the podcast-specific message', async () => {
  const supabase = {
    from: () => ({ insert: async () => ({ error: { code: '23505', message: 'duplicate' } }) }),
  }
  const preview = { type: 'podcast', title: 'X', description: null, imageUrl: null, feedUrl: 'https://example.com/feed.xml', channelId: null }
  assert.deepEqual(await saveSource({ supabase, userId: USER_ID, preview }), { ok: false, errorKey: 'errorAlreadySubscribed' })
})

// ─── YouTube add flow ────────────────────────────────────────────────

test('YouTube channel: resolves the handle, previews the channel and stores the YouTube source', async () => {
  const { fetchImpl, calls } = makeFetch({
    '/api/youtube/resolve': jsonResponse({
      channelId: CHANNEL_ID,
      title: 'Google for Developers',
      description: 'Dev-Kanal',
      thumbnailUrl: 'https://yt3.example.com/avatar.jpg',
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
    }),
  })

  const resolved = await resolveSourcePreview({ type: 'youtube', input: ' @GoogleDevelopers ', fetchImpl })
  assert.deepEqual(calls, [{ url: '/api/youtube/resolve', method: 'POST', body: { input: '@GoogleDevelopers' } }])
  assert.deepEqual(resolved, {
    ok: true,
    preview: {
      type: 'youtube',
      title: 'Google for Developers',
      description: 'Dev-Kanal',
      imageUrl: 'https://yt3.example.com/avatar.jpg',
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      channelId: CHANNEL_ID,
    },
  })

  const supabase = makeFakeSupabase({ podcast_subscriptions: [] })
  const saved = await saveSource({ supabase, userId: USER_ID, preview: resolved.preview })
  assert.deepEqual(saved, { ok: true })
  assert.deepEqual(supabase.writes, [{
    table: 'podcast_subscriptions',
    kind: 'insert',
    payload: {
      user_id: USER_ID,
      source_type: 'youtube',
      youtube_channel_id: CHANNEL_ID,
      feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      title: 'Google for Developers',
      description: 'Dev-Kanal',
      cover_image_url: 'https://yt3.example.com/avatar.jpg',
    },
  }])
})

test('YouTube channel: an unresolvable channel reports the resolve fallback message', async () => {
  const { fetchImpl } = makeFetch({ '/api/youtube/resolve': jsonResponse({}, 404) })
  const resolved = await resolveSourcePreview({ type: 'youtube', input: '@gibtsnicht', fetchImpl })
  assert.deepEqual(resolved, { ok: false, errorKey: 'youtubeErrorResolve' })
})

test('YouTube channel: a duplicate channel reports the channel-specific message', async () => {
  const supabase = {
    from: () => ({ insert: async () => ({ error: { code: '23505', message: 'duplicate' } }) }),
  }
  const preview = { type: 'youtube', title: 'X', description: null, imageUrl: null, feedUrl: 'f', channelId: CHANNEL_ID }
  assert.deepEqual(await saveSource({ supabase, userId: USER_ID, preview }), { ok: false, errorKey: 'youtubeErrorAlreadyAdded' })
})

// ─── Shared behaviour ────────────────────────────────────────────────

test('network failures and empty input never reach the database', async () => {
  const failing = async () => { throw new TypeError('fetch failed') }
  assert.deepEqual(
    await resolveSourcePreview({ type: 'youtube', input: '@kanal', fetchImpl: failing }),
    { ok: false, errorKey: 'errorNetworkFeed' }
  )

  const { fetchImpl, calls } = makeFetch({})
  assert.deepEqual(await resolveSourcePreview({ type: 'podcast', input: '   ', fetchImpl }), { ok: false, errorKey: 'errorInputRequired' })
  assert.equal(calls.length, 0)
})

test('other database errors report a generic save error', async () => {
  const supabase = { from: () => ({ insert: async () => ({ error: { code: '42501', message: 'rls' } }) }) }
  const preview = { type: 'podcast', title: 'X', description: null, imageUrl: null, feedUrl: 'f', channelId: null }
  assert.deepEqual(await saveSource({ supabase, userId: USER_ID, preview }), { ok: false, errorKey: 'errorSaveFeed' })
})

test('buildSourceInsert keeps podcast rows free of YouTube columns', () => {
  const row = buildSourceInsert(
    { type: 'podcast', title: 'P', description: null, imageUrl: null, feedUrl: 'https://example.com/feed.xml', channelId: null },
    USER_ID
  )
  assert.equal('source_type' in row, false)
  assert.equal('youtube_channel_id' in row, false)
})
