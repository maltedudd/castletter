'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import LanguageSwitcher from './LanguageSwitcher'

export default function Footer() {
  const t = useTranslations('footer')
  return (
    <footer className="border-t mt-auto py-6 text-center text-sm text-muted-foreground">
      <p className="mb-2">{t('tagline')}</p>
      <div className="flex items-center justify-center gap-4">
        <span>© {new Date().getFullYear()} Castletter</span>
        <span>·</span>
        <Link href="/impressum" className="hover:text-foreground transition-colors">{t('imprint')}</Link>
        <span>·</span>
        <Link href="/datenschutz" className="hover:text-foreground transition-colors">{t('privacy')}</Link>
        <span>·</span>
        <LanguageSwitcher />
      </div>
    </footer>
  )
}
