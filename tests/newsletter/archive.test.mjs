import assert from 'node:assert/strict'
import test from 'node:test'
import { mailIdsOf, sortMailEpisodes, toArchiveEntry } from '../../src/lib/newsletter/archive.mjs'

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

test('sortMailEpisodes follows the digest order: podcast → YouTube → website, oldest first within a type', () => {
  const list = [
    { ...ep('web', '2026-10-06T01:00:00Z', 'Stadtblog'), source_type: 'website' },
    { ...ep('yt', '2026-10-06T02:00:00Z', 'Kanal'), source_type: 'youtube' },
    { ...ep('pod-late', '2026-10-06T05:00:00Z', 'Lage'), source_type: 'podcast' },
    { ...ep('pod-early', '2026-10-06T03:00:00Z', 'Lage'), source_type: 'podcast' },
  ]
  assert.deepEqual(sortMailEpisodes(list).map((e) => e.id), ['pod-early', 'pod-late', 'yt', 'web'])
  const entry = toArchiveEntry({ id: 'm', mode: 'daily', subject: 's', sent_at: 'x', episode_count: 4, episodes: list })
  assert.deepEqual(entry.sources, ['Lage', 'Kanal', 'Stadtblog'])
})
