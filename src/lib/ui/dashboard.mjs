// Redesign: the overview page shows only what the user's own data says – the next issue from
// the saved delivery hour, the first steps from real counts. Pure, so it runs under node:test.

/** Greeting by local hour: morning 5–11, day 11–17, evening 17–22, night otherwise. */
export function greetingKeyOf(hour) {
  if (hour >= 5 && hour < 11) return 'greetingMorning'
  if (hour >= 11 && hour < 17) return 'greetingDay'
  if (hour >= 17 && hour < 22) return 'greetingEvening'
  return 'greetingNight'
}

/** First name from the auth profile metadata, if the user gave one; never derived from the e-mail. */
export function firstNameOf(user) {
  const meta = user?.user_metadata ?? {}
  const raw = [meta.first_name, meta.given_name, meta.full_name, meta.name].find((value) => typeof value === 'string' && value.trim())
  return raw ? raw.trim().split(/\s+/)[0] : null
}

/**
 * Next daily issue for a delivery hour stored in UTC (0–23): the next full hour at or after
 * `now`. `day` is 'today' or 'tomorrow' in local time. null without a valid hour.
 */
export function nextDeliveryOf(utcHour, now = new Date()) {
  if (!Number.isInteger(utcHour) || utcHour < 0 || utcHour > 23) return null
  const at = new Date(now)
  at.setUTCHours(utcHour, 0, 0, 0)
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1)
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
  return { at, day: at < startOfTomorrow ? 'today' : 'tomorrow' }
}

/** The three first steps of the prototype, each done from the user's real data. */
export function onboardingStepsOf({ hasSettings, sourceCount, categoryCount }) {
  return [
    { key: 'stepSettings', href: '/settings', done: Boolean(hasSettings) },
    { key: 'stepSources', href: '/subscriptions', done: (sourceCount ?? 0) > 0 },
    { key: 'stepCategories', href: '/subscriptions', done: (categoryCount ?? 0) > 0 },
  ]
}
