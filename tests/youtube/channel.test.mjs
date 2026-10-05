import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildYouTubeFeedUrl,
  buildYouTubeWatchUrl,
  extractChannelIdFromHtml,
  extractChannelMetaFromHtml,
  isYouTubeChannelId,
  parseChannelInput,
  parseYouTubeFeed,
  resolveYouTubeChannel,
} from '../../src/lib/youtube/channel.mjs'

const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}"/>
 <id>yt:channel:_x5XG1OV2P6uZZ5FSM9Ttw</id>
 <yt:channelId>${CHANNEL_ID}</yt:channelId>
 <title>Google for Developers &amp; Friends</title>
 <author><name>Google for Developers</name><uri>https://www.youtube.com/channel/${CHANNEL_ID}</uri></author>
 <published>2007-08-23T00:34:43+00:00</published>
 <entry>
  <id>yt:video:abcDEF12345</id>
  <yt:videoId>abcDEF12345</yt:videoId>
  <yt:channelId>${CHANNEL_ID}</yt:channelId>
  <title>Was ist neu in &quot;Android&quot; &lt;16&gt;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abcDEF12345"/>
  <published>2026-10-03T15:00:06+00:00</published>
  <updated>2026-10-03T16:00:00+00:00</updated>
  <media:group>
   <media:title>Was ist neu in "Android" 16</media:title>
   <media:content url="https://www.youtube.com/v/abcDEF12345?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/abcDEF12345/hqdefault.jpg" width="480" height="360"/>
   <media:description>Alles zu Android &amp; mehr.
Zweite Zeile.</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:zyx-_987654</id>
  <yt:videoId>zyx-_987654</yt:videoId>
  <title><![CDATA[CDATA Titel & mehr]]></title>
  <published>2026-10-01T08:00:00+00:00</published>
  <media:group><media:description></media:description></media:group>
 </entry>
</feed>`

test('isYouTubeChannelId accepts exactly UC + 22 URL-safe characters', () => {
  assert.equal(isYouTubeChannelId(CHANNEL_ID), true)
  assert.equal(isYouTubeChannelId('UC_x5XG1OV2P6uZZ5FSM9Tt'), false)
  assert.equal(isYouTubeChannelId('UU_x5XG1OV2P6uZZ5FSM9Ttw'), false)
  assert.equal(isYouTubeChannelId('UC_x5XG1OV2P6uZZ5FSM9Tt!'), false)
})

test('parseChannelInput recognizes channel IDs, channel URLs, handles and legacy URLs', () => {
  const cases = [
    [CHANNEL_ID, { kind: 'channel_id', channelId: CHANNEL_ID }],
    [`  ${CHANNEL_ID}  `, { kind: 'channel_id', channelId: CHANNEL_ID }],
    [`https://www.youtube.com/channel/${CHANNEL_ID}`, { kind: 'channel_id', channelId: CHANNEL_ID }],
    [`youtube.com/channel/${CHANNEL_ID}/videos`, { kind: 'channel_id', channelId: CHANNEL_ID }],
    [`https://m.youtube.com/channel/${CHANNEL_ID}?si=x`, { kind: 'channel_id', channelId: CHANNEL_ID }],
    [`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`, { kind: 'channel_id', channelId: CHANNEL_ID }],
    ['@GoogleDevelopers', { kind: 'page', path: '/@GoogleDevelopers' }],
    ['https://www.youtube.com/@GoogleDevelopers/videos', { kind: 'page', path: '/@GoogleDevelopers' }],
    ['https://youtube.com/@café.kanal', { kind: 'page', path: `/@${encodeURIComponent('café.kanal')}` }],
    ['https://www.youtube.com/c/GoogleDevelopers', { kind: 'page', path: '/c/GoogleDevelopers' }],
    ['https://www.youtube.com/user/GoogleDevelopers', { kind: 'page', path: '/user/GoogleDevelopers' }],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(parseChannelInput(input), expected, input)
  }
})

test('parseChannelInput rejects video, playlist, foreign-host and garbage input', () => {
  for (const input of [
    '',
    '   ',
    'https://www.youtube.com/watch?v=abcDEF12345',
    'https://youtu.be/abcDEF12345',
    'https://www.youtube.com/playlist?list=PL123',
    'https://evil.example/@GoogleDevelopers',
    'https://www.youtube.com.evil.example/channel/' + CHANNEL_ID,
    'not a channel',
    '@',
    '@bad handle',
  ]) {
    assert.equal(parseChannelInput(input).kind, 'invalid', input)
  }
})

test('feed and watch URLs are built from IDs only', () => {
  assert.equal(buildYouTubeFeedUrl(CHANNEL_ID), `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`)
  assert.equal(buildYouTubeWatchUrl('abcDEF12345'), 'https://www.youtube.com/watch?v=abcDEF12345')
  assert.throws(() => buildYouTubeFeedUrl('UCfoo&x=1'))
})

test('parseYouTubeFeed reads channel and entries, decoding XML entities and CDATA', () => {
  const feed = parseYouTubeFeed(FEED_XML)

  assert.equal(feed.channelId, CHANNEL_ID)
  assert.equal(feed.title, 'Google for Developers & Friends')
  assert.deepEqual(feed.entries, [
    {
      videoId: 'abcDEF12345',
      title: 'Was ist neu in "Android" <16>',
      published: '2026-10-03T15:00:06+00:00',
      description: 'Alles zu Android & mehr.\nZweite Zeile.',
      thumbnailUrl: 'https://i2.ytimg.com/vi/abcDEF12345/hqdefault.jpg',
    },
    {
      videoId: 'zyx-_987654',
      title: 'CDATA Titel & mehr',
      published: '2026-10-01T08:00:00+00:00',
      description: null,
      thumbnailUrl: null,
    },
  ])
})

test('parseYouTubeFeed falls back to the entry id and skips entries without a valid video ID', () => {
  const feed = parseYouTubeFeed(`<feed><title>K</title>
    <entry><id>yt:video:AAAAAAAAAAA</id><title>Nur id</title><published>2026-10-01T00:00:00Z</published></entry>
    <entry><id>tag:other</id><title>Kaputt</title></entry>
  </feed>`)
  assert.deepEqual(feed.entries.map((e) => e.videoId), ['AAAAAAAAAAA'])
})

test('parseYouTubeFeed rejects documents that are not an Atom feed', () => {
  assert.throws(() => parseYouTubeFeed('<html><body>Consent</body></html>'), /Kein gültiger YouTube-Feed/)
})

test('extractChannelIdFromHtml prefers canonical/meta tags over arbitrary channelId mentions', () => {
  const html = `<html><head>
    <link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}">
    <meta property="og:title" content="Google for Developers">
    <meta property="og:image" content="https://yt3.googleusercontent.com/avatar=s900">
    <meta property="og:description" content="Kanal &amp; mehr">
    </head><body>"channelId":"UCaaaaaaaaaaaaaaaaaaaaaa"</body></html>`
  assert.equal(extractChannelIdFromHtml(html), CHANNEL_ID)
  assert.deepEqual(extractChannelMetaFromHtml(html), {
    title: 'Google for Developers',
    thumbnailUrl: 'https://yt3.googleusercontent.com/avatar=s900',
    description: 'Kanal & mehr',
  })

  assert.equal(extractChannelIdFromHtml(`<meta itemprop="identifier" content="${CHANNEL_ID}">`), CHANNEL_ID)
  assert.equal(extractChannelIdFromHtml(`{"externalId":"${CHANNEL_ID}"}`), CHANNEL_ID)
  assert.equal(extractChannelIdFromHtml('<html>nichts</html>'), null)
})

function fakeFetch(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const route = routes[url]
    if (!route) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => route }
  }
  return { fetchImpl, calls }
}

test('resolveYouTubeChannel resolves a handle via the channel page and validates the feed', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://www.youtube.com/@GoogleDevelopers': `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_ID}"><meta property="og:image" content="https://yt3.example/a.jpg"><meta property="og:description" content="Beschreibung">`,
    [buildYouTubeFeedUrl(CHANNEL_ID)]: FEED_XML,
  })

  const channel = await resolveYouTubeChannel({ input: 'https://www.youtube.com/@GoogleDevelopers', fetchImpl })

  assert.deepEqual(channel, {
    channelId: CHANNEL_ID,
    title: 'Google for Developers & Friends',
    description: 'Beschreibung',
    thumbnailUrl: 'https://yt3.example/a.jpg',
    feedUrl: buildYouTubeFeedUrl(CHANNEL_ID),
  })
  // Only fixed youtube.com hosts are ever fetched, with consent cookies to skip the EU consent wall.
  assert.ok(calls.every((c) => c.url.startsWith('https://www.youtube.com/')))
  assert.match(calls[0].init.headers.Cookie, /SOCS=/)
})

test('resolveYouTubeChannel with a channel ID reads the feed and best-effort page metadata', async () => {
  const { fetchImpl } = fakeFetch({ [buildYouTubeFeedUrl(CHANNEL_ID)]: FEED_XML })
  const channel = await resolveYouTubeChannel({ input: CHANNEL_ID, fetchImpl })
  assert.equal(channel.channelId, CHANNEL_ID)
  assert.equal(channel.title, 'Google for Developers & Friends')
  assert.equal(channel.thumbnailUrl, null)
})

test('resolveYouTubeChannel reports actionable errors', async () => {
  const { fetchImpl } = fakeFetch({ 'https://www.youtube.com/@ohneid': '<html>kein Kanal</html>' })

  await assert.rejects(resolveYouTubeChannel({ input: 'https://youtu.be/abc', fetchImpl }), { code: 'invalid_input' })
  await assert.rejects(resolveYouTubeChannel({ input: '@unbekannt', fetchImpl }), { code: 'channel_not_found' })
  await assert.rejects(resolveYouTubeChannel({ input: '@ohneid', fetchImpl }), { code: 'channel_not_found' })
  await assert.rejects(resolveYouTubeChannel({ input: CHANNEL_ID, fetchImpl }), { code: 'feed_unavailable' })
})
