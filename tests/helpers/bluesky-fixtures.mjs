// Shared fixtures for Bluesky (social) tests: public AppView JSON (profile, author feed items)
// and the profile RSS feed of bsky.app, shaped like the live answers (checked 2026-10-11).

export const DID = 'did:plc:abcdefghijklmnopqrstuvwx'
export const OTHER_DID = 'did:plc:zyxwvutsrqponmlkjihgfedc'
export const HANDLE = 'anna.bsky.social'
export const RSS_URL = `https://bsky.app/profile/${DID}/rss`

export function profile(overrides = {}) {
  return {
    did: DID,
    handle: HANDLE,
    displayName: 'Anna Beispiel',
    description: 'Schreibt über #Stadt & Verkehr',
    avatar: `https://cdn.bsky.app/img/avatar/plain/${DID}/bafkreiavatar`,
    labels: [],
    ...overrides,
  }
}

export function author(overrides = {}) {
  return { did: DID, handle: HANDLE, displayName: 'Anna Beispiel', labels: [], ...overrides }
}

export const postUri = (rkey, did = DID) => `at://${did}/app.bsky.feed.post/${rkey}`
export const postUrl = (rkey, did = DID) => `https://bsky.app/profile/${did}/post/${rkey}`

/** A feed item (`app.bsky.feed.defs#feedViewPost`) of a post by Anna; `record`/`post` merge in. */
export function feedItem(rkey, { record = {}, post = {}, ...rest } = {}) {
  return {
    post: {
      uri: postUri(rkey),
      cid: `cid-${rkey}`,
      author: author(),
      record: { $type: 'app.bsky.feed.post', text: `Post ${rkey}`, createdAt: '2026-10-05T10:00:00.000Z', ...record },
      indexedAt: '2026-10-05T10:00:01.000Z',
      labels: [],
      ...post,
    },
    ...rest,
  }
}

/** Reply metadata of a record: parent (and root) by `parentDid`. */
export function replyTo(parentDid, rkey = 'parent1') {
  return { parent: { uri: postUri(rkey, parentDid), cid: 'p' }, root: { uri: postUri(rkey, parentDid), cid: 'p' } }
}

/** bsky.app's public profile feed: channel link and item links use the handle, GUIDs the DID. */
export function blueskyRss({ handle = HANDLE, title = `@${handle} - Anna Beispiel`, items = [] } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><description>Schreibt über #Stadt &amp; Verkehr</description><link>https://bsky.app/profile/${handle}</link><title>${escapeXml(title)}</title>${items
    .map((item) => `<item><link>https://bsky.app/profile/${handle}/post/${item.rkey}</link><description>${escapeXml(item.text)}</description><pubDate>${new Date(item.published).toUTCString()}</pubDate><guid isPermaLink="false">${postUri(item.rkey, item.did ?? DID)}</guid></item>`)
    .join('')}</channel></rss>`
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#xA;')
}
