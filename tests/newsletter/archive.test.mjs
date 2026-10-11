import assert from 'node:assert/strict'
import test from 'node:test'
import { groupMailEpisodes, mailEpisodesOf, mailIdsOf, socialPostOf, sortMailEpisodes, toArchiveEntry } from '../../src/lib/newsletter/archive.mjs'

const ep = (id, published_at, title, cover = null) => ({ id, published_at, podcast_subscriptions: { title, cover_image_url: cover } })

test('a daily digest becomes one entry with its count and unique sources in mail order', () => {
  const entry = toArchiveEntry({
    id: 'm1', mode: 'daily', subject: 'Deine neuen Podcast-Updates (3 Episoden)', sent_at: '2026-10-07T07:00:00.000Z', episode_count: 3,
    episodes: [
      ep('c', '2026-10-06T20:00:00Z', 'tagesschau.de', 'https://img/ts.png'),
      ep('a', '2026-10-06T04:00:00Z', 'Lage der Nation'),
      ep('b', '2026-10-06T05:00:00Z', 'tagesschau.de', 'https://img/ts.png'),
    ],
  })
  assert.deepEqual(entry, {
    id: 'm1', mode: 'daily', subject: 'Deine neuen Podcast-Updates (3 Episoden)', sentAt: '2026-10-07T07:00:00.000Z',
    itemCount: 3, sources: ['Lage der Nation', 'tagesschau.de'], coverImageUrl: 'https://img/ts.png',
  })
})

test('an immediate mail keeps its mode; embeds as arrays and unknown modes are tolerated', () => {
  const entry = toArchiveEntry({
    id: 'm2', mode: 'immediate', subject: 'tagesschau.de: Artikel', sent_at: 'x', episode_count: 1,
    episodes: [{ id: 'a', published_at: '1', podcast_subscriptions: [{ title: 'tagesschau.de', cover_image_url: null }] }],
  })
  assert.equal(entry.mode, 'immediate')
  assert.deepEqual(entry.sources, ['tagesschau.de'])
  assert.equal(entry.coverImageUrl, null)
  assert.equal(toArchiveEntry({ id: 'm3', mode: 'weekly', subject: 's', sent_at: 'x', episodes: [] }).mode, 'daily')
  assert.equal(toArchiveEntry({ id: 'm3', mode: 'daily', subject: 's', sent_at: 'x', episodes: [ep('a', '1', 'X'), ep('b', '2', 'Y')] }).itemCount, 2)
})

test('sortMailEpisodes orders oldest first without mutating; mailIdsOf is unique and skips nulls', () => {
  const list = [ep('b', '2026-10-06T05:00:00Z', 'X'), ep('a', '2026-10-06T04:00:00Z', 'X')]
  assert.deepEqual(sortMailEpisodes(list).map((e) => e.id), ['a', 'b'])
  assert.deepEqual(list.map((e) => e.id), ['b', 'a'])
  assert.deepEqual(mailIdsOf([{ newsletter_mail_id: 'm1' }, { newsletter_mail_id: null }, { newsletter_mail_id: 'm1' }, { newsletter_mail_id: 'm2' }]), ['m1', 'm2'])
})

test('Kanban #42: archive follows the digest order – podcasts → YouTube → Website (RSS) → Social, chronological within', () => {
  const typed = (id, source_type, published_at) => ({ ...ep(id, published_at, `Quelle ${id}`), source_type, title: `Titel ${id}` })
  const episodes = [
    typed('w1', 'website', '2026-10-06T01:00:00Z'),
    typed('s1', 'social', '2026-10-06T00:30:00Z'),
    typed('y1', 'youtube', '2026-10-06T02:00:00Z'),
    typed('p2', 'podcast', '2026-10-06T05:00:00Z'),
    typed('p1', null, '2026-10-06T04:00:00Z'),
    typed('x1', 'newsletter', '2026-10-06T00:00:00Z'),
  ]
  assert.deepEqual(sortMailEpisodes(episodes).map((e) => e.id), ['p1', 'p2', 'y1', 'w1', 's1', 'x1'])
  assert.deepEqual(groupMailEpisodes(episodes).map((g) => [g.type, g.episodes.map((e) => e.id)]), [
    ['podcast', ['p1', 'p2']], ['youtube', ['y1']], ['website', ['w1']], ['social', ['s1']], ['other', ['x1']],
  ])
  assert.deepEqual(groupMailEpisodes(undefined), [])
  assert.deepEqual(toArchiveEntry({ id: 'm', mode: 'daily', subject: 's', sent_at: 'x', episodes }).sources,
    ['Quelle p1', 'Quelle p2', 'Quelle y1', 'Quelle w1', 'Quelle s1', 'Quelle x1'])
})

// ─── Kanban #39: social posts ────────────────────────────────────────

test('socialPostOf re-sanitises the stored post and keeps only http(s) media; null for other types', () => {
  const post = socialPostOf({
    source_type: 'social',
    social_content: '<p onclick="x()">Hallo<script>alert(1)</script> <a href="javascript:x()">da</a></p>',
    social_spoiler: '  Politik ',
    social_media: [
      { type: 'image', url: 'https://files.example/a.jpg', previewUrl: 'https://files.example/a_s.jpg', description: 'Bild' },
      { type: 'image', url: 'javascript:alert(1)', previewUrl: null, description: null },
      { type: 'video', url: 'https://files.example/v.mp4', previewUrl: 'javascript:x()', description: null },
    ],
  })
  assert.deepEqual(post, {
    html: '<p>Hallo da</p>',
    spoiler: 'Politik',
    media: [
      { type: 'image', url: 'https://files.example/a.jpg', previewUrl: 'https://files.example/a_s.jpg', description: 'Bild' },
      { type: 'video', url: 'https://files.example/v.mp4', previewUrl: null, description: null },
    ],
  })
  assert.equal(socialPostOf({ source_type: 'podcast' }), null)
  assert.deepEqual(socialPostOf({ source_type: 'social', social_content: null, social_spoiler: null, social_media: null }), { html: '', spoiler: null, media: [] })
})

// ─── Kanban #43: an episode in an immediate mail and a digest ────────

test('mailEpisodesOf merges delivery embeds and the legacy embed, unique by id', () => {
  const a = ep('a', '2026-10-06T04:00:00Z', 'Hotel Matze')
  const b = ep('b', '2026-10-06T05:00:00Z', 'Lage der Nation')
  const mail = {
    newsletter_deliveries: [{ episodes: a }, { episodes: [b] }, { episodes: null }],
    episodes: [{ ...a }],
  }
  assert.deepEqual(mailEpisodesOf(mail).map((e) => e.id), ['a', 'b'])
  assert.deepEqual(mailEpisodesOf({ episodes: [b] }).map((e) => e.id), ['b'], 'mails sent before #43')
  assert.deepEqual(mailEpisodesOf({ newsletter_deliveries: [{ episodes: a }] }).map((e) => e.id), ['a'])
  assert.deepEqual(mailEpisodesOf({}), [])
})

test('the same episode shows up in both its immediate mail and its digest entry', () => {
  const a = ep('a', '2026-10-06T04:00:00Z', 'Hotel Matze', 'https://img/hm.png')
  const b = ep('b', '2026-10-06T05:00:00Z', 'Lage der Nation')
  const immediate = toArchiveEntry({
    id: 'm1', mode: 'immediate', subject: 'Hotel Matze: Episode a', sent_at: '2026-10-06T06:00:00Z', episode_count: 1,
    newsletter_deliveries: [{ episodes: a }], episodes: [],
  })
  // The legacy pointer of `a` moved on to the digest; that does not duplicate it there.
  const digest = toArchiveEntry({
    id: 'm2', mode: 'daily', subject: 'Deine neuen Podcast-Updates (2 Episoden)', sent_at: '2026-10-07T07:00:00Z', episode_count: 2,
    newsletter_deliveries: [{ episodes: a }, { episodes: b }], episodes: [a],
  })
  assert.deepEqual([immediate.mode, immediate.sources, immediate.itemCount], ['immediate', ['Hotel Matze'], 1])
  assert.deepEqual([digest.mode, digest.sources, digest.itemCount], ['daily', ['Hotel Matze', 'Lage der Nation'], 2])
  assert.equal(toArchiveEntry({ id: 'm3', mode: 'daily', subject: 's', sent_at: 'x', newsletter_deliveries: [{ episodes: a }, { episodes: b }] }).itemCount, 2)
})

test('mailIdsOf collects mails from delivery rows and legacy episode rows', () => {
  assert.deepEqual(
    mailIdsOf([{ mail_id: 'm1' }, { mail_id: 'm2' }, { mail_id: null }], [{ newsletter_mail_id: 'm2' }, { newsletter_mail_id: 'm0' }]),
    ['m1', 'm2', 'm0']
  )
  assert.deepEqual(mailIdsOf([], null), [])
})
