// One social source type, two platforms (Kanban #40): the entered profile picks Mastodon or
// Bluesky, the feed check reads each source with its platform's client, and the source card
// links to the right profile.

import assert from 'node:assert/strict'
import test from 'node:test'
import Parser from 'rss-parser'
import { detectSocialPlatform, fetchSocialPosts, resolveSocialAccount, socialProfileUrl } from '../../src/lib/social/platforms.mjs'
import { buildBlueskyAuthorFeedUrl, buildBlueskyProfileUrl } from '../../src/lib/social/bluesky.mjs'
import { buildMastodonLookupUrl, buildMastodonStatusesUrl } from '../../src/lib/social/mastodon.mjs'
import { ACCOUNT_ID, INSTANCE, RSS_URL as MASTODON_RSS, account, fakeFetch, status } from '../helpers/mastodon-fixtures.mjs'
import { DID, HANDLE, RSS_URL as BLUESKY_RSS, feedItem, postUrl, profile } from '../helpers/bluesky-fixtures.mjs'

const parser = new Parser()
const parseXml = (xml) => parser.parseString(xml)
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('die Plattform wird aus der Eingabe erkannt', () => {
  const cases = [
    ['@anna@social.example', 'mastodon'],
    ['https://social.example/@anna', 'mastodon'],
    ['https://bsky.app/profile/anna.bsky.social', 'bluesky'],
    ['anna.bsky.social', 'bluesky'],
    ['@anna.bsky.social', 'bluesky'],
    [DID, 'bluesky'],
    ['anna', null],
    ['https://example.org/feed.xml', null],
  ]
  for (const [input, platform] of cases) assert.equal(detectSocialPlatform(input), platform, input)
})

test('die Auflösung geht an die erkannte Plattform', async () => {
  const fetchImpl = fakeFetch({
    [buildMastodonLookupUrl({ username: 'anna', host: 'social.example' })]: { json: account() },
    [buildBlueskyProfileUrl(HANDLE)]: { json: profile() },
  })
  const mastodon = await resolveSocialAccount({ input: '@anna@social.example', fetchImpl, lookup: publicLookup, parseXml })
  assert.equal(mastodon.ok && mastodon.preview.platform, 'mastodon')
  const bluesky = await resolveSocialAccount({ input: HANDLE, fetchImpl, lookup: publicLookup, parseXml })
  assert.equal(bluesky.ok && bluesky.preview.platform, 'bluesky')
  assert.deepEqual(await resolveSocialAccount({ input: 'anna', fetchImpl, lookup: publicLookup, parseXml }), {
    ok: false, status: 400, errorKey: 'socialErrorInvalidInput',
  })
})

test('der Feed-Check liest jede Quelle mit dem Client ihrer Plattform', async () => {
  const fetchImpl = fakeFetch({
    [buildMastodonStatusesUrl(INSTANCE, ACCOUNT_ID)]: { json: [status('1')] },
    [buildBlueskyAuthorFeedUrl(DID)]: { json: { feed: [feedItem('3ka')] } },
  })
  const mastodon = await fetchSocialPosts({ subscription: { social_platform: 'mastodon', feed_url: MASTODON_RSS, social_account_id: ACCOUNT_ID }, fetchImpl, parseXml })
  assert.deepEqual(mastodon.posts.map((p) => p.guid), [`${INSTANCE}/@anna/1`])
  const bluesky = await fetchSocialPosts({ subscription: { social_platform: 'bluesky', feed_url: BLUESKY_RSS, social_account_id: DID }, fetchImpl, parseXml })
  assert.deepEqual(bluesky.posts.map((p) => p.guid), [postUrl('3ka')])
})

test('Profil-Link der Quelle je Plattform – bei Bluesky über die DID', () => {
  assert.equal(socialProfileUrl({ social_platform: 'mastodon', feed_url: MASTODON_RSS, social_account_id: ACCOUNT_ID }), `${INSTANCE}/@anna`)
  assert.equal(socialProfileUrl({ social_platform: 'bluesky', feed_url: BLUESKY_RSS, social_account_id: DID }), `https://bsky.app/profile/${DID}`)
  assert.equal(socialProfileUrl({ social_platform: 'bluesky', feed_url: BLUESKY_RSS, social_account_id: null }), BLUESKY_RSS)
})
