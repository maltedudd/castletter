import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'

export default getRequestConfig(async () => {
  // 1. Check cookie
  const cookieStore = await cookies()
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value

  // 2. Detect from Accept-Language header
  const headersList = await headers()
  const acceptLanguage = headersList.get('accept-language') || ''
  const browserLocale = acceptLanguage.split(',')[0].split('-')[0].toLowerCase()

  const locale = (cookieLocale && ['de', 'en'].includes(cookieLocale))
    ? cookieLocale
    : (['de', 'en'].includes(browserLocale) ? browserLocale : 'de')

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default
  }
})
