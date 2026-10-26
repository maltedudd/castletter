'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { headerVariantOf } from '@/lib/ui/layout.mjs'
import LanguageSwitcher from './LanguageSwitcher'

export default function Footer() {
  const t = useTranslations('footer')
  const landing = headerVariantOf(usePathname()) === 'landing'
  const year = new Date().getFullYear()

  return (
    <footer className={landing ? 'bg-white' : 'border-t border-[#E6EBEB]'}>
      <div
        className={`mx-auto flex w-full flex-wrap items-center justify-between gap-3 ${
          landing ? 'max-w-[1160px] p-7 text-[13.5px] text-castle-muted' : 'max-w-[1080px] px-6 py-[22px] text-[13px] text-castle-subtle'
        }`}
      >
        <span>{landing ? `© ${year} Castletter · ${t('tagline')}` : `© ${year} Castletter`}</span>
        <div className={`flex items-center ${landing ? 'gap-5' : 'gap-[18px]'}`}>
          <Link href="/impressum" className="hover:text-castle-ink">{t('imprint')}</Link>
          <Link href="/datenschutz" className="hover:text-castle-ink">{t('privacy')}</Link>
          <LanguageSwitcher />
        </div>
      </div>
    </footer>
  )
}
