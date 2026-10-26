'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { toArchiveEntry } from '@/lib/newsletter/archive.mjs'
import { deliveryTargetsOf } from '@/lib/newsletter/delivery-targets.mjs'
import { firstNameOf, greetingKeyOf, nextDeliveryOf, onboardingStepsOf } from '@/lib/ui/dashboard.mjs'
import { formatLongDay, formatShortDateTime } from '@/lib/ui/format.mjs'
import { avatarColorOf, initialsOf } from '@/lib/ui/source-avatar.mjs'
import { formatHour, utcHourToLocal } from '@/lib/utils/timezone'
import type { PodcastSubscription } from '@/types/database'
import { AppPage, InitialsTile, ModeBadge, PageHeading, PageSpinner } from '@/components/app/AppPage'

type ArchiveEntry = ReturnType<typeof toArchiveEntry>

type Overview = {
  deliveryHourUtc: number | null
  sources: Pick<PodcastSubscription, 'enabled' | 'deliver_daily' | 'deliver_immediately' | 'delivery_mode'>[]
  categoryCount: number
  mailCount: number
  recent: ArchiveEntry[]
}

// Same embed as the archive list, so subject, item count and sources match it.
const MAIL_SELECT = `
  id, mode, subject, episode_count, sent_at,
  newsletter_deliveries ( episodes ( id, published_at, podcast_subscriptions ( title, cover_image_url ) ) ),
  episodes!newsletter_mail_id ( id, published_at, podcast_subscriptions ( title, cover_image_url ) )
`

/** Overview: next issue, first steps, shortcuts and the last mails – all from the user's own data. */
export default function DashboardPage() {
  const { user, loading } = useAuth()
  const router = useRouter()
  const t = useTranslations('dashboard')
  const tArchive = useTranslations('archive')
  const locale = useLocale()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [now] = useState(() => new Date())

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login')
    }
  }, [user, loading, router])

  useEffect(() => {
    if (!user) return
    const supabase = createClient()
    let cancelled = false
    Promise.all([
      supabase.from('user_settings').select('newsletter_delivery_hour').eq('user_id', user.id).maybeSingle(),
      supabase.from('podcast_subscriptions').select('enabled, deliver_daily, deliver_immediately, delivery_mode').eq('user_id', user.id),
      supabase.from('source_categories').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('newsletter_mails').select(MAIL_SELECT, { count: 'exact' }).eq('user_id', user.id).order('sent_at', { ascending: false }).range(0, 3),
    ]).then(([settings, sources, categories, mails]) => {
      if (cancelled) return
      if (settings.error || sources.error || categories.error || mails.error) setLoadError(true)
      setOverview({
        deliveryHourUtc: typeof settings.data?.newsletter_delivery_hour === 'number' ? settings.data.newsletter_delivery_hour : null,
        sources: sources.data ?? [],
        categoryCount: categories.count ?? 0,
        mailCount: mails.count ?? 0,
        recent: (mails.data ?? []).map(toArchiveEntry),
      })
    })
    return () => {
      cancelled = true
    }
  }, [user])

  if (loading || (user && !overview)) return <PageSpinner />
  if (!user || !overview) return null

  const firstName = firstNameOf(user)
  const greeting = t(greetingKeyOf(now.getHours()))
  const next = nextDeliveryOf(overview.deliveryHourUtc ?? undefined, now)
  const deliveryTime = overview.deliveryHourUtc === null ? null : formatHour(utcHourToLocal(overview.deliveryHourUtc))
  const active = overview.sources.filter((s) => s.enabled)
  const daily = active.filter((s) => deliveryTargetsOf(s).daily).length
  const immediate = active.filter((s) => deliveryTargetsOf(s).immediate).length
  const steps = onboardingStepsOf({ hasSettings: overview.deliveryHourUtc !== null, sourceCount: overview.sources.length, categoryCount: overview.categoryCount })
  const latest = overview.recent[0]

  const tiles = [
    { href: '/subscriptions', title: t('tileSourcesTitle'), count: String(overview.sources.length), description: t('tileSourcesDescription') },
    { href: '/archive', title: t('tileArchiveTitle'), count: String(overview.mailCount), description: t('tileArchiveDescription') },
    { href: '/settings', title: t('tileSettingsTitle'), count: deliveryTime ?? '–', description: t('tileSettingsDescription') },
  ]

  return (
    <AppPage>
      <PageHeading
        eyebrow={formatLongDay(now, locale)}
        title={firstName ? t('greetingWithName', { greeting, name: firstName }) : t('greetingAlone', { greeting })}
      />

      {loadError && <p role="alert" className="m-0 text-sm text-destructive">{t('loadError')}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Next issue */}
        <section className="relative flex min-w-0 flex-col gap-[22px] overflow-hidden rounded-2xl bg-castle-ink p-7 text-white lg:col-span-2">
          <div aria-hidden="true" className="absolute -bottom-[90px] -right-[90px] h-[260px] w-[260px] rounded-full border-2 border-[rgba(240,168,72,.35)]" />
          <div aria-hidden="true" className="absolute -bottom-[150px] -right-[150px] h-[380px] w-[380px] rounded-full border-2 border-white/[.08]" />
          <span className="font-mono text-xs uppercase tracking-[0.06em] text-castle-amber">
            {next && deliveryTime ? t(next.day === 'today' ? 'nextIssueToday' : 'nextIssueTomorrow', { time: deliveryTime }) : t('nextIssueUnset')}
          </span>
          <div className="relative flex flex-col gap-2">
            <h2 className="m-0 font-serif text-[34px] font-normal leading-[1.1] tracking-[-0.015em]">
              {overview.sources.length === 0
                ? t('heroNoSources')
                : t(active.length === 1 ? 'heroActiveSources_one' : 'heroActiveSources_other', { count: active.length })}
            </h2>
            <p className="m-0 text-[15px] text-[#B8CAD0]">
              {overview.sources.length === 0 ? t('heroNoSourcesHint') : t('heroDeliverySplit', { daily, immediate })}
            </p>
          </div>
          <div className="relative flex flex-wrap gap-2.5">
            {overview.sources.length === 0 ? (
              <Link href="/subscriptions" className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-castle-ink">{t('addSource')}</Link>
            ) : latest ? (
              <Link href={`/archive/${latest.id}`} className="rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-castle-ink">{t('readLatest')}</Link>
            ) : null}
            <Link href="/settings" className="rounded-lg border border-white/[.18] bg-white/[.08] px-4 py-2.5 text-sm font-medium text-white">
              {deliveryTime ? t('changeDeliveryTime') : t('setDeliveryTime')}
            </Link>
          </div>
        </section>

        {/* First steps */}
        <section className="flex flex-col gap-4 rounded-2xl border border-castle-line bg-white p-6">
          <h2 className="m-0 text-sm font-semibold">{t('firstStepsTitle')}</h2>
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {steps.map((step, index) => (
              <li key={step.key} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-px flex h-5 w-5 flex-none items-center justify-center rounded-full border-[1.5px] text-[11px] font-semibold ${
                    step.done ? 'border-castle-ink bg-castle-ink text-white' : 'border-castle-control bg-white text-castle-ink'
                  }`}
                >
                  {step.done ? '✓' : index + 1}
                </span>
                {step.done ? (
                  <span className="text-[14.5px] leading-[1.4] text-castle-faint">
                    {t(step.key)} <span className="sr-only">({t('stepDone')})</span>
                  </span>
                ) : (
                  <Link href={step.href} className="text-[14.5px] leading-[1.4] text-castle-ink hover:underline">{t(step.key)}</Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="flex flex-col gap-1.5 rounded-[14px] border border-castle-line bg-white px-[22px] py-5 text-castle-ink transition-shadow hover:border-[#9FB2B8] hover:shadow-[0_8px_24px_-16px_rgba(6,47,62,.4)]"
          >
            <span className="flex w-full items-baseline justify-between">
              <span className="text-base font-semibold">{tile.title}</span>
              <span className="font-mono text-[13px] text-castle-subtle">{tile.count}</span>
            </span>
            <span className="text-sm leading-[1.45] text-castle-muted">{tile.description}</span>
          </Link>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-castle-line bg-white">
        <div className="flex items-center justify-between border-b border-castle-line-soft px-6 py-[18px]">
          <h2 className="m-0 text-[15px] font-semibold">{t('recentTitle')}</h2>
          <Link href="/archive" className="text-[13.5px] text-castle-muted hover:text-castle-ink">{t('recentShowAll')}</Link>
        </div>
        {overview.recent.length === 0 ? (
          <p className="m-0 px-6 py-8 text-sm text-castle-muted">{t('recentEmpty')}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {overview.recent.map((entry) => {
              const key = entry.sources[0] ?? entry.subject
              return (
                <li key={entry.id} className="border-b border-castle-line-soft last:border-b-0">
                  <Link href={`/archive/${entry.id}`} className="flex items-center gap-4 px-6 py-4 hover:bg-castle-row">
                    <InitialsTile initials={initialsOf(key)} color={avatarColorOf(key)} />
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="truncate text-[14.5px] font-medium">{entry.subject}</span>
                      <span className="text-[13px] text-castle-subtle">
                        <time dateTime={entry.sentAt}>{formatShortDateTime(entry.sentAt, locale)}</time>
                        {' · '}
                        {tArchive(entry.itemCount === 1 ? 'itemCount_one' : 'itemCount_other', { count: entry.itemCount })}
                      </span>
                    </span>
                    <ModeBadge mode={entry.mode} label={tArchive(entry.mode === 'daily' ? 'badgeDaily' : 'badgeImmediate')} className="px-[9px] py-1" />
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </AppPage>
  )
}
