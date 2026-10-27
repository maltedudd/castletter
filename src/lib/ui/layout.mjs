// Redesign: which header/footer a page gets. Pure, so the root layout's client header and
// node:test share it.

/** Signed-in app pages: header with the main navigation. */
export const APP_NAV = [
  { href: '/dashboard', key: 'overview' },
  { href: '/subscriptions', key: 'subscriptions' },
  { href: '/archive', key: 'archive' },
  { href: '/settings', key: 'settings' },
]

const APP_PREFIXES = [...APP_NAV.map((item) => item.href), '/admin']

function matches(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** 'landing' for the start page, 'app' for signed-in pages, 'public' for everything else. */
export function headerVariantOf(pathname) {
  const path = typeof pathname === 'string' && pathname ? pathname : '/'
  if (path === '/') return 'landing'
  if (APP_PREFIXES.some((prefix) => matches(path, prefix))) return 'app'
  return 'public'
}

/** The nav item a path belongs to (also for sub pages such as /archive/<id>), or null. */
export function activeNavHref(pathname) {
  if (typeof pathname !== 'string') return null
  return APP_NAV.find((item) => matches(pathname, item.href))?.href ?? null
}
