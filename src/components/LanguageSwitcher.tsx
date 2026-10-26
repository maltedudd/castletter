'use client'
import { useLocale, useTranslations } from 'next-intl'

const LOCALES = ['de', 'en'] as const

export default function LanguageSwitcher() {
  const locale = useLocale()
  const t = useTranslations('footer')

  async function switchLocale(newLocale: string) {
    if (newLocale === locale) return
    await fetch('/api/locale', {
      method: 'POST',
      body: JSON.stringify({ locale: newLocale }),
      headers: { 'Content-Type': 'application/json' },
    })
    window.location.reload()
  }

  return (
    <div role="group" aria-label={t('language')} className="flex items-center gap-1">
      {LOCALES.map((code, index) => (
        <span key={code} className="flex items-center gap-1">
          {index > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={() => switchLocale(code)}
            aria-pressed={locale === code}
            className={locale === code ? 'font-bold text-castle-ink' : 'hover:text-castle-ink'}
          >
            {code.toUpperCase()}
          </button>
        </span>
      ))}
    </div>
  )
}
