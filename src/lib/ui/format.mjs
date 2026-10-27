// Redesign: date formats of the prototype ("25.10. · 08:00", "Sonntag, 25. Oktober").

const tag = (locale) => (locale === 'de' ? 'de-DE' : 'en-US')

/** Short day and time, e.g. "25.10. · 08:00" (de) or "10/25 · 08:00" (en); '' for invalid input. */
export function formatShortDateTime(value, locale, timeZone) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const day = date.toLocaleDateString(tag(locale), { day: '2-digit', month: '2-digit', timeZone })
  const time = date.toLocaleTimeString(tag(locale), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
  return `${day} · ${time}`
}

/** Weekday with day and month, e.g. "Sonntag, 25. Oktober". */
export function formatLongDay(value, locale, timeZone) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(tag(locale), { weekday: 'long', day: 'numeric', month: 'long', timeZone })
}
