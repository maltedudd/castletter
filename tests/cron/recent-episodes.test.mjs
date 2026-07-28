import assert from 'node:assert/strict'
import test from 'node:test'
import { isWithinRecentEpisodeWindow, sortNewestFirst } from '../../src/lib/cron/recent-episodes.mjs'

const now = new Date('2026-07-28T12:00:00.000Z')

test('filters old backlog episodes while keeping fresh daily episodes', () => {
  assert.equal(isWithinRecentEpisodeWindow('2026-04-19T04:00:00.000Z', now), false)
  assert.equal(isWithinRecentEpisodeWindow('2026-07-28T04:00:44.000Z', now), true)
})

test('orders fresh candidates newest first so one old timeout cannot starve newer episodes', () => {
  const episodes = [
    { id: 'oldest', published_at: '2026-04-19T04:00:00.000Z' },
    { id: 'fresh-a', published_at: '2026-07-28T04:00:44.000Z' },
    { id: 'fresh-b', published_at: '2026-07-28T02:00:00.000Z' },
  ]

  assert.deepEqual(sortNewestFirst(episodes).map((episode) => episode.id), [
    'fresh-a',
    'fresh-b',
    'oldest',
  ])
})
