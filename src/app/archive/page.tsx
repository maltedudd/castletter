'use client'

import { useEffect, useId, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { ARCHIVE_PAGE_SIZE, mailIdsOf, toArchiveEntry } from '@/lib/newsletter/archive.mjs'
import { groupArchiveEntries } from '@/lib/ui/archive-groups.mjs'
import { formatShortDateTime } from '@/lib/ui/format.mjs'
import { avatarColorOf, initialsOf } from '@/lib/ui/source-avatar.mjs'
import { AppPage, InitialsTile, ModeBadge, PageHeading, PageSpinner } from '@/components/app/AppPage'
import type { NewsletterMailMode, PodcastSubscription } from '@/types/database'

type ArchiveEntry = ReturnType<typeof toArchiveEntry>
type ModeFilter = 'all' | NewsletterMailMode

function ArchiveEntrySkeleton() {
  return (
    <div className="flex items-center gap-4 border-b border-castle-line-soft px-5 py-4 last:border-b-0">
      <Skeleton className="h-[46px] w-[46px] shrink-0 rounded-[10px]" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  )
}

type ModeCounts = Record<ModeFilter, number>

/** The mails the user received: each daily digest as one entry, each immediate mail on its own. */
export default function ArchivePage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('archive')
  const locale = useLocale()
  const idPrefix = useId()

  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [subscriptions, setSubscriptions] = useState<Pick<PodcastSubscription, 'id' | 'title'>[]>([])
  const [loading, setLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [filterMode, setFilterMode] = useState<ModeFilter>('all')
  const [filterSubscriptionId, setFilterSubscriptionId] = useState<string>('all')
  const [modeCounts, setModeCounts] = useState<ModeCounts | null>(null)

  const totalPages = Math.ceil(totalCount / ARCHIVE_PAGE_SIZE)
  const filtered = filterMode !== 'all' || filterSubscriptionId !== 'all'

  const loadData = useCallback(async () => {
    if (!user) return
    setLoading(true)

    const { data: subs } = await supabase
      .from('podcast_subscriptions')
      .select('id, title')
      .eq('user_id', user.id)
      .order('title', { ascending: true })
    if (subs) setSubscriptions(subs)

    // Source filter: the mails that contain at least one episode of this source – through its
    // deliveries (Kanban #43) and the legacy pointer of mails sent before that.
    let mailIds: string[] | null = null
    if (filterSubscriptionId !== 'all') {
      const [{ data: delivered }, { data: sent }] = await Promise.all([
        supabase
          .from('newsletter_deliveries')
          .select('mail_id, episodes!inner(subscription_id)')
          .eq('episodes.subscription_id', filterSubscriptionId)
          .not('mail_id', 'is', null),
        supabase
          .from('episodes')
          .select('newsletter_mail_id')
          .eq('subscription_id', filterSubscriptionId)
          .not('newsletter_mail_id', 'is', null),
      ])
      mailIds = mailIdsOf(delivered ?? [], sent ?? [])
      if (mailIds.length === 0) {
        setEntries([])
        setTotalCount(0)
        setModeCounts({ all: 0, daily: 0, immediate: 0 })
        setLoading(false)
        return
      }
    }

    // Counts of the mode segments (Alle / Täglich / Sofort) within the source filter.
    const countOf = (mode: ModeFilter) => {
      let countQuery = supabase.from('newsletter_mails').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      if (mode !== 'all') countQuery = countQuery.eq('mode', mode)
      if (mailIds) countQuery = countQuery.in('id', mailIds)
      return countQuery
    }
    const counts = Promise.all([countOf('all'), countOf('daily'), countOf('immediate')])

    // An episode with immediate and daily delivery is in two mails: listed through
    // newsletter_deliveries, plus the legacy embed for mails sent before Kanban #43.
    let query = supabase
      .from('newsletter_mails')
      .select(
        `
        id,
        mode,
        subject,
        episode_count,
        sent_at,
        newsletter_deliveries (
          episodes (
            id,
            published_at,
            podcast_subscriptions ( title, cover_image_url )
          )
        ),
        episodes!newsletter_mail_id (
          id,
          published_at,
          podcast_subscriptions ( title, cover_image_url )
        )
        `,
        { count: 'exact' }
      )
      .eq('user_id', user.id)
    if (filterMode !== 'all') query = query.eq('mode', filterMode)
    if (mailIds) query = query.in('id', mailIds)

    const from = (currentPage - 1) * ARCHIVE_PAGE_SIZE
    const { data, count, error } = await query
      .order('sent_at', { ascending: false })
      .range(from, from + ARCHIVE_PAGE_SIZE - 1)

    if (!error && data) {
      setEntries(data.map(toArchiveEntry))
      setTotalCount(count ?? 0)
    }
    const [all, daily, immediate] = await counts
    setModeCounts(all.error || daily.error || immediate.error
      ? null
      : { all: all.count ?? 0, daily: daily.count ?? 0, immediate: immediate.count ?? 0 })
    setLoading(false)
  }, [user, supabase, currentPage, filterMode, filterSubscriptionId])

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      loadData()
    }
  }, [user, loadData])

  // Back to page 1 whenever a filter changes
  function handleModeChange(value: string) {
    setFilterMode(value === 'daily' || value === 'immediate' ? value : 'all')
    setCurrentPage(1)
  }

  function handleSourceChange(value: string) {
    setFilterSubscriptionId(value)
    setCurrentPage(1)
  }

  if (authLoading) return <PageSpinner />

  if (!user) return null

  const sourceFilterId = `${idPrefix}-source`
  const now = new Date()
  const modes: { value: ModeFilter; label: string }[] = [
    { value: 'all', label: t('filterAllModes') },
    { value: 'daily', label: t('badgeDaily') },
    { value: 'immediate', label: t('badgeImmediate') },
  ]

  return (
    <AppPage>
      <PageHeading
        title={t('title')}
        description={t('description')}
        aside={
          <div role="group" aria-label={t('filterModeLabel')} className="flex gap-1 rounded-[10px] bg-castle-segment p-1">
            {modes.map((mode) => {
              const selected = filterMode === mode.value
              return (
                <button
                  key={mode.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handleModeChange(mode.value)}
                  className={`rounded-[7px] px-3.5 py-[7px] text-[13.5px] font-medium ${
                    selected ? 'bg-white text-castle-ink shadow-[0_1px_2px_rgba(6,47,62,.12)]' : 'text-castle-nav'
                  }`}
                >
                  {mode.label}
                  {modeCounts && <span className="ml-1 font-normal text-castle-faint">{modeCounts[mode.value]}</span>}
                </button>
              )
            })}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor={sourceFilterId} className="text-sm font-normal text-castle-muted">{t('filterSourceLabel')}</Label>
        <Select value={filterSubscriptionId} onValueChange={handleSourceChange}>
          <SelectTrigger id={sourceFilterId} className="h-9 w-64 bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filterAllSources')}</SelectItem>
            {subscriptions.map((sub) => (
              <SelectItem key={sub.id} value={sub.id}>
                {sub.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!loading && (
          <span className="text-sm text-castle-subtle" aria-live="polite">
            {t(totalCount === 1 ? 'mailCount_one' : 'mailCount_other', { count: totalCount })}
          </span>
        )}
      </div>

      {loading ? (
        <div className="overflow-hidden rounded-[14px] border border-castle-line bg-white" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <ArchiveEntrySkeleton key={i} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-[14px] border border-castle-line bg-white px-6 py-16 text-center">
          <p className="mb-2 text-lg font-semibold">
            {filtered ? t('emptyTitleFiltered') : t('emptyTitleAll')}
          </p>
          <p className="mb-6 text-sm text-castle-muted">
            {filtered ? t('emptyHintFiltered') : t('emptyHintAll')}
          </p>
          {!filtered && (
            <Link href="/subscriptions" className="inline-flex rounded-lg border border-castle-input bg-white px-4 py-2 text-sm font-medium hover:border-castle-ink">
              {t('subscribeLink')}
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-7">
            {groupArchiveEntries(entries, now).map((group) => (
              <section key={group.key} className="flex flex-col gap-2.5" aria-labelledby={`${idPrefix}-${group.key}`}>
                <h2 id={`${idPrefix}-${group.key}`} className="m-0 pl-1 font-mono text-xs font-normal uppercase tracking-[0.06em] text-castle-subtle">
                  {t(`group_${group.key}`)}
                </h2>
                <ul className="m-0 list-none overflow-hidden rounded-[14px] border border-castle-line bg-white p-0">
                  {group.entries.map((entry) => {
                    const key = entry.sources[0] ?? entry.subject
                    return (
                      <li key={entry.id} className="border-b border-castle-line-soft last:border-b-0">
                        <Link
                          href={`/archive/${entry.id}`}
                          aria-label={t('readMailLabel', { subject: entry.subject })}
                          className="flex items-center gap-4 px-5 py-4 hover:bg-castle-row"
                        >
                          <InitialsTile initials={initialsOf(key)} color={avatarColorOf(key)} size={46} radius={10} />
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="flex items-center gap-2.5 text-[12.5px] text-castle-subtle">
                              <ModeBadge mode={entry.mode} label={t(entry.mode === 'daily' ? 'badgeDaily' : 'badgeImmediate')} className="px-2 py-0.5" />
                              <time dateTime={entry.sentAt} className="font-mono">{formatShortDateTime(entry.sentAt, locale)}</time>
                            </span>
                            <span className="text-[15px] font-medium leading-[1.35] [text-wrap:pretty]">{entry.subject}</span>
                            <span className="truncate text-[13px] text-castle-subtle">
                              {t(entry.itemCount === 1 ? 'itemCount_one' : 'itemCount_other', { count: entry.itemCount })}
                              {entry.sources.length > 0 && ` · ${entry.sources.join(', ')}`}
                            </span>
                          </span>
                          <span aria-hidden="true" className="hidden whitespace-nowrap text-[13.5px] text-castle-muted sm:inline">{t('readButton')} →</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>

          {totalPages > 1 && (
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    aria-disabled={currentPage === 1}
                    className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                  />
                </PaginationItem>
                <PaginationItem>
                  <span className="flex items-center px-4 text-sm text-castle-muted">
                    {t('paginationPage', { current: currentPage, total: totalPages })}
                  </span>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    aria-disabled={currentPage === totalPages}
                    className={currentPage === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      )}
    </AppPage>
  )
}
