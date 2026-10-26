// Redesign: the archive list is grouped by when a mail was sent (Heute / Diese Woche /
// Letzte Woche / Älter). Weeks start on Monday, in the viewer's local time.

export const ARCHIVE_GROUPS = ['today', 'thisWeek', 'lastWeek', 'older']

function startOfDay(date) {
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  return start
}

function startOfWeek(date) {
  const start = startOfDay(date)
  const sinceMonday = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - sinceMonday)
  return start
}

/** Group key of a send time relative to `now`; unparseable or future dates count as today. */
export function archiveGroupOf(sentAt, now = new Date()) {
  const sent = new Date(sentAt)
  if (Number.isNaN(sent.getTime())) return 'older'
  const today = startOfDay(now)
  if (sent >= today) return 'today'
  const thisWeek = startOfWeek(now)
  if (sent >= thisWeek) return 'thisWeek'
  // Calendar days, not 7 × 24 h: a week across a DST switch is 167 or 169 hours long.
  const lastWeek = new Date(thisWeek)
  lastWeek.setDate(lastWeek.getDate() - 7)
  if (sent >= lastWeek) return 'lastWeek'
  return 'older'
}

/**
 * Entries (`{ sentAt }`, newest first) as `[{ key, entries }]` in the order today, this week,
 * last week, older; empty groups are left out and the entry order is kept.
 * @template {{ sentAt: string }} T
 * @param {T[]} entries
 * @param {Date} [now]
 * @returns {{ key: string, entries: T[] }[]}
 */
export function groupArchiveEntries(entries, now = new Date()) {
  /** @type {Record<string, T[]>} */
  const groups = Object.fromEntries(ARCHIVE_GROUPS.map((key) => [key, []]))
  for (const entry of entries ?? []) groups[archiveGroupOf(entry.sentAt, now)].push(entry)
  return ARCHIVE_GROUPS.map((key) => ({ key, entries: groups[key] })).filter((group) => group.entries.length > 0)
}
