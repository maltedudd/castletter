import { updateSession } from '@/lib/supabase/middleware'
import { type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Run Supabase auth session update first
  const response = await updateSession(request)

  // Set default locale cookie if missing
  if (!request.cookies.get('NEXT_LOCALE')) {
    const acceptLanguage = request.headers.get('accept-language') || ''
    const browserLocale = acceptLanguage.split(',')[0].split('-')[0].toLowerCase()
    const locale = ['de', 'en'].includes(browserLocale) ? browserLocale : 'de'
    response.cookies.set('NEXT_LOCALE', locale, { path: '/', maxAge: 60 * 60 * 24 * 365 })
  }

  return response
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
