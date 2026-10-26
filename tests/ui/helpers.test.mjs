import assert from 'node:assert/strict'
import test from 'node:test'
import { activeNavHref, headerVariantOf } from '../../src/lib/ui/layout.mjs'
import { AVATAR_COLORS, avatarColorOf, initialsOf } from '../../src/lib/ui/source-avatar.mjs'
import { archiveGroupOf, groupArchiveEntries } from '../../src/lib/ui/archive-groups.mjs'
import { firstNameOf, greetingKeyOf, nextDeliveryOf, onboardingStepsOf } from '../../src/lib/ui/dashboard.mjs'
import { groupSourcesByCategory, lastCheckedOf } from '../../src/lib/ui/source-groups.mjs'

test('header variant: start page, signed-in app pages (incl. sub pages and admin), public pages', () => {
  assert.equal(headerVariantOf('/'), 'landing')
  assert.equal(headerVariantOf(''), 'landing')
  for (const path of ['/dashboard', '/subscriptions', '/archive', '/archive/abc', '/settings', '/admin']) {
    assert.equal(headerVariantOf(path), 'app', path)
  }
  for (const path of ['/login', '/register', '/auth/verify', '/impressum', '/datenschutz', '/archived', '/dashboards']) {
    assert.equal(headerVariantOf(path), 'public', path)
  }
})

test('active nav item follows sub pages, not look-alike prefixes', () => {
  assert.equal(activeNavHref('/archive/123'), '/archive')
  assert.equal(activeNavHref('/settings'), '/settings')
  assert.equal(activeNavHref('/archived'), null)
  assert.equal(activeNavHref('/admin'), null)
})

test('initials: two words, one word, separators, emoji and digits', () => {
  assert.equal(initialsOf('Christoph Magnussen'), 'CM')
  assert.equal(initialsOf('Julian Ivanov | KI-Automatisierung'), 'JI')
  assert.equal(initialsOf('tagesschau.de – Die Nachrichten der ARD'), 'TD')
  assert.equal(initialsOf('Hotelmatze'), 'HO')
  assert.equal(initialsOf('15 Minuten'), '1M')
  assert.equal(initialsOf('🎧'), '?')
  assert.equal(initialsOf(null), '?')
})

test('avatar colour is stable per title and from the prototype palette', () => {
  assert.equal(avatarColorOf('FC St. Pauli'), avatarColorOf('FC St. Pauli'))
  assert.ok(AVATAR_COLORS.includes(avatarColorOf('Hotel Matze')))
  assert.equal(avatarColorOf(''), AVATAR_COLORS[0])
})

test('archive groups: today, this week (from Monday), last week, older', () => {
  // Wednesday, 2026-10-21 15:00 local time
  const now = new Date(2026, 9, 21, 15, 0)
  assert.equal(archiveGroupOf(new Date(2026, 9, 21, 0, 5), now), 'today')
  assert.equal(archiveGroupOf(new Date(2026, 9, 19, 8, 0), now), 'thisWeek') // Monday
  assert.equal(archiveGroupOf(new Date(2026, 9, 18, 23, 59), now), 'lastWeek') // Sunday before
  assert.equal(archiveGroupOf(new Date(2026, 9, 12, 0, 0), now), 'lastWeek') // Monday a week ago
  assert.equal(archiveGroupOf(new Date(2026, 9, 11, 23, 0), now), 'older')
  assert.equal(archiveGroupOf('kaputt', now), 'older')
})

test('archive grouping keeps entry order and drops empty groups', () => {
  const now = new Date(2026, 9, 21, 15, 0)
  const entries = [
    { id: 'a', sentAt: new Date(2026, 9, 21, 9).toISOString() },
    { id: 'b', sentAt: new Date(2026, 9, 20, 9).toISOString() },
    { id: 'c', sentAt: new Date(2026, 9, 1, 9).toISOString() },
  ]
  assert.deepEqual(
    groupArchiveEntries(entries, now).map((g) => [g.key, g.entries.map((e) => e.id)]),
    [['today', ['a']], ['thisWeek', ['b']], ['older', ['c']]],
  )
  assert.deepEqual(groupArchiveEntries([], now), [])
})

test('greeting by hour', () => {
  assert.equal(greetingKeyOf(6), 'greetingMorning')
  assert.equal(greetingKeyOf(12), 'greetingDay')
  assert.equal(greetingKeyOf(20), 'greetingEvening')
  assert.equal(greetingKeyOf(23), 'greetingNight')
  assert.equal(greetingKeyOf(3), 'greetingNight')
})

test('first name only from profile metadata, never from the e-mail address', () => {
  assert.equal(firstNameOf({ email: 'malte@example.org', user_metadata: {} }), null)
  assert.equal(firstNameOf({ user_metadata: { full_name: '  Ada Lovelace ' } }), 'Ada')
  assert.equal(firstNameOf({ user_metadata: { first_name: 'Grace' } }), 'Grace')
  assert.equal(firstNameOf(null), null)
})

test('next delivery: later today, or tomorrow once the hour has passed', () => {
  const now = new Date(Date.UTC(2026, 9, 25, 6, 30))
  const later = nextDeliveryOf(7, now)
  assert.equal(later.at.toISOString(), '2026-10-25T07:00:00.000Z')
  const passed = nextDeliveryOf(6, now)
  assert.equal(passed.at.toISOString(), '2026-10-26T06:00:00.000Z')
  assert.notEqual(later.at.getTime(), passed.at.getTime())
  assert.equal(nextDeliveryOf(undefined, now), null)
  assert.equal(nextDeliveryOf(24, now), null)
})

test('onboarding steps come from real counts', () => {
  assert.deepEqual(onboardingStepsOf({ hasSettings: false, sourceCount: 0, categoryCount: 0 }).map((s) => s.done), [false, false, false])
  assert.deepEqual(onboardingStepsOf({ hasSettings: true, sourceCount: 3, categoryCount: 0 }).map((s) => s.done), [true, true, false])
})

test('sources are grouped by category order, the rest (also deleted categories) last', () => {
  const categories = [{ id: 'k2', name: 'Technik' }, { id: 'k1', name: 'Sport' }, { id: 'k3', name: 'Leer' }]
  const sources = [
    { id: 's1', category_id: 'k1' },
    { id: 's2', category_id: null },
    { id: 's3', category_id: 'k2' },
    { id: 's4', category_id: 'gone' },
  ]
  assert.deepEqual(
    groupSourcesByCategory(sources, categories).map((g) => [g.category?.id ?? null, g.sources.map((s) => s.id)]),
    [['k2', ['s3']], ['k1', ['s1']], ['k3', []], [null, ['s2', 's4']]],
  )
  assert.deepEqual(groupSourcesByCategory([], []), [])
})

test('last checked is the newest valid timestamp', () => {
  assert.equal(lastCheckedOf([{ last_checked_at: '2026-10-25T10:00:00Z' }, { last_checked_at: '2026-10-25T19:47:00Z' }, { last_checked_at: null }]), '2026-10-25T19:47:00.000Z')
  assert.equal(lastCheckedOf([]), null)
})

test('prototype date formats', async () => {
  const { formatLongDay, formatShortDateTime } = await import('../../src/lib/ui/format.mjs')
  const sent = '2026-10-25T07:00:00Z'
  assert.equal(formatShortDateTime(sent, 'de', 'Europe/Berlin'), '25.10. · 08:00')
  assert.equal(formatShortDateTime(sent, 'en', 'Europe/Berlin'), '10/25 · 08:00')
  assert.equal(formatLongDay(sent, 'de', 'Europe/Berlin'), 'Sonntag, 25. Oktober')
  assert.equal(formatShortDateTime('kaputt', 'de'), '')
})

test('archive groups count calendar weeks across the DST switch (Europe/Berlin)', () => {
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Europe/Berlin') return
  // Wednesday 2026-10-28; DST ended on Sunday 2026-10-25. Last week starts Monday 2026-10-19 00:00.
  const now = new Date(2026, 9, 28, 12, 0)
  assert.equal(archiveGroupOf(new Date(2026, 9, 19, 0, 30), now), 'lastWeek')
  assert.equal(archiveGroupOf(new Date(2026, 9, 18, 23, 30), now), 'older')
})
