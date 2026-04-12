'use client'
import { useEffect, useState } from 'react'

export default function LanguageSwitcher() {
  const [locale, setLocale] = useState('de')

  useEffect(() => {
    const cookie = document.cookie.split(';').find(c => c.trim().startsWith('NEXT_LOCALE='))
    if (cookie) setLocale(cookie.split('=')[1].trim())
  }, [])

  async function switchLocale(newLocale: string) {
    await fetch('/api/locale', {
      method: 'POST',
      body: JSON.stringify({ locale: newLocale }),
      headers: { 'Content-Type': 'application/json' },
    })
    setLocale(newLocale)
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        onClick={() => switchLocale('de')}
        className={locale === 'de' ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground transition-colors'}
      >
        DE
      </button>
      <span className="text-muted-foreground">·</span>
      <button
        onClick={() => switchLocale('en')}
        className={locale === 'en' ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground transition-colors'}
      >
        EN
      </button>
    </div>
  )
}
