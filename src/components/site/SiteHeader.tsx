'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { formatHour, utcHourToLocal } from '@/lib/utils/timezone'
import { APP_NAV, activeNavHref, headerVariantOf } from '@/lib/ui/layout.mjs'
import { Logo } from '@/components/brand/Logo'

const buttonBase = 'rounded-lg px-3.5 py-[9px] text-sm font-medium transition-colors'

function LandingHeader() {
  const t = useTranslations('nav')
  return (
    <header className="bg-white">
      <div className="mx-auto flex w-full max-w-[1160px] items-center justify-between gap-4 px-7 py-[22px]">
        <Link href="/" aria-label="Castletter" className="no-underline"><Logo size="lg" /></Link>
        <nav className="flex items-center gap-2">
          <Link href="/login" className={`${buttonBase} text-castle-ink hover:bg-castle-haze`}>{t('signIn')}</Link>
          <Link href="/register" className={`${buttonBase} bg-castle-ink px-4 text-white hover:bg-castle-ink-hover`}>{t('startFree')}</Link>
        </nav>
      </div>
    </header>
  )
}

function PublicHeader({ pathname }: { pathname: string }) {
  const t = useTranslations('nav')
  return (
    <header className="border-b border-[#E6EBEB] bg-white">
      <div className="mx-auto flex h-16 w-full max-w-[1080px] items-center justify-between gap-4 px-6">
        <Link href="/" aria-label="Castletter" className="no-underline"><Logo /></Link>
        {pathname !== '/login' && (
          <Link href="/login" className={`${buttonBase} text-castle-ink hover:bg-castle-haze`}>{t('signIn')}</Link>
        )}
      </div>
    </header>
  )
}

/** Delivery hour of the daily issue in local time, from the user's own settings (null = not set). */
function useLocalDeliveryHour(userId: string | null) {
  const [hour, setHour] = useState<number | null>(null)
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    createClient()
      .from('user_settings')
      .select('newsletter_delivery_hour')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setHour(typeof data?.newsletter_delivery_hour === 'number' ? utcHourToLocal(data.newsletter_delivery_hour) : null)
      })
    return () => {
      cancelled = true
    }
  }, [userId])
  return hour
}

function AppHeader({ pathname }: { pathname: string }) {
  const t = useTranslations('nav')
  const { user } = useAuth()
  const deliveryHour = useLocalDeliveryHour(user?.id ?? null)
  const active = activeNavHref(pathname)
  const initial = user?.email?.trim()?.[0]?.toUpperCase() ?? null

  return (
    <header className="sticky top-0 z-30 border-b border-[#E6EBEB] bg-white">
      <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-x-7 px-6 md:h-16 md:flex-nowrap">
        <Link href="/dashboard" aria-label={t('dashboard')} className="flex h-14 items-center md:h-auto">
          <Logo />
        </Link>
        <div className="ml-auto flex items-center gap-3 md:order-last">
          {deliveryHour !== null && (
            <Link href="/settings" className="flex items-center gap-[7px] whitespace-nowrap text-[13px] text-castle-muted hover:text-castle-ink">
              <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-castle-green" />
              {t('nextIssue', { time: formatHour(deliveryHour) })}
            </Link>
          )}
          {initial && (
            <span
              title={user?.email ?? undefined}
              aria-label={t('signedInAs', { email: user?.email ?? '' })}
              role="img"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[#E7EEEE] text-[13px] font-semibold text-castle-ink"
            >
              {initial}
            </span>
          )}
        </div>
        <nav aria-label={t('mainNavigation')} className="-mx-6 flex w-[calc(100%+3rem)] gap-0.5 overflow-x-auto px-6 pb-2.5 md:mx-0 md:w-auto md:flex-1 md:p-0">
          {APP_NAV.map((item) => {
            const current = active === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`whitespace-nowrap rounded-[7px] px-3 py-2 text-sm font-medium transition-colors hover:text-castle-ink ${
                  current ? 'bg-castle-mist text-castle-ink' : 'text-castle-nav'
                }`}
              >
                {t(item.key)}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}

/** One header for every page; which one depends on the path (see headerVariantOf). */
export default function SiteHeader() {
  const pathname = usePathname() ?? '/'
  const variant = headerVariantOf(pathname)
  if (variant === 'landing') return <LandingHeader />
  if (variant === 'app') return <AppHeader pathname={pathname} />
  return <PublicHeader pathname={pathname} />
}
