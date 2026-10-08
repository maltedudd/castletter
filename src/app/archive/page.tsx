'use client'

import { useEffect, useId, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useTranslations, useLocale } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import type { NewsletterMailMode, PodcastSubscription } from '@/types/database'

type ArchiveEntry = ReturnType<typeof toArchiveEntry>
type ModeFilter = 'all' | NewsletterMailMode

function ArchiveEntrySkeleton() {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <Skeleton className="w-16 h-16 rounded-lg shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-9 w-20 shrink-0" />
        </div>
      </CardContent>
    </Card>
  )
}

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

  const totalPages = Math.ceil(totalCount / ARCHIVE_PAGE_SIZE)
  const filtered = filterMode !== 'all' || filterSubscriptionId !== 'all'

  function formatDateTime(dateString: string) {
    return new Date(dateString).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const loadData = useCallback(async () => {
    if (!user) return
    setLoading(true)

    const { data: subs } = await supabase
      .from('podcast_subscriptions')
      .select('id, title')
      .eq('user_id', user.id)
      .order('title', { ascending: true })
    if (subs) setSubscriptions(subs)

    // Source filter: the mails that contain at least one episode of this source.
    let mailIds: string[] | null = null
    if (filterSubscriptionId !== 'all') {
      const { data: sent } = await supabase
        .from('episodes')
        .select('newsletter_mail_id')
        .eq('subscription_id', filterSubscriptionId)
        .not('newsletter_mail_id', 'is', null)
      mailIds = mailIdsOf(sent ?? [])
      if (mailIds.length === 0) {
        setEntries([])
        setTotalCount(0)
        setLoading(false)
        return
      }
    }

    let query = supabase
      .from('newsletter_mails')
      .select(
        `
        id,
        mode,
        subject,
        episode_count,
        sent_at,
        episodes (
          id,
          published_at,
          source_type,
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

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
      </div>
    )
  }

  if (!user) return null

  const modeFilterId = `${idPrefix}-mode`
  const sourceFilterId = `${idPrefix}-source`

  return (
    <div className="min-h-screen section-spacing">
      <div className="max-w-3xl mx-auto container-spacing">
        {/* Header */}
        <div className="mb-10">
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-primary transition-colors mb-4 inline-block"
          >
            {t('backToDashboard')}
          </Link>
          <h1 className="text-4xl font-bold mb-2">{t('title')}</h1>
          <p className="text-muted-foreground text-lg">
            {t('description')}
          </p>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-end gap-4 mb-6">
          <div className="space-y-1">
            <Label htmlFor={modeFilterId} className="text-sm text-muted-foreground font-normal">{t('filterModeLabel')}</Label>
            <Select value={filterMode} onValueChange={handleModeChange}>
              <SelectTrigger id={modeFilterId} className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('filterAllModes')}</SelectItem>
                <SelectItem value="daily">{t('modeDaily')}</SelectItem>
                <SelectItem value="immediate">{t('modeImmediate')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={sourceFilterId} className="text-sm text-muted-foreground font-normal">{t('filterSourceLabel')}</Label>
            <Select value={filterSubscriptionId} onValueChange={handleSourceChange}>
              <SelectTrigger id={sourceFilterId} className="w-64">
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
          </div>

          {!loading && (
            <span className="text-sm text-muted-foreground pb-2" aria-live="polite">
              {t(totalCount === 1 ? 'mailCount_one' : 'mailCount_other', { count: totalCount })}
            </span>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <ArchiveEntrySkeleton key={i} />
            ))}
          </div>
        ) : entries.length === 0 ? (
          /* Empty State */
          <Card>
            <CardContent className="py-16 text-center">
              <div className="text-5xl mb-4" aria-hidden="true">📬</div>
              <p className="text-lg font-semibold mb-2">
                {filtered ? t('emptyTitleFiltered') : t('emptyTitleAll')}
              </p>
              <p className="text-muted-foreground text-sm mb-6">
                {filtered ? t('emptyHintFiltered') : t('emptyHintAll')}
              </p>
              {!filtered && (
                <Button asChild variant="outline">
                  <Link href="/subscriptions">{t('subscribeLink')}</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <ul className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <Card className="hover:shadow-md transition-shadow">
                    <CardContent className="p-5">
                      <div className="flex items-center gap-4">
                        {entry.coverImageUrl ? (
                          <Image
                            src={entry.coverImageUrl}
                            alt=""
                            width={64}
                            height={64}
                            className="rounded-lg object-cover shrink-0"
                          />
                        ) : (
                          <div aria-hidden="true" className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center text-2xl shrink-0">
                            {entry.mode === 'daily' ? '📰' : '✉️'}
                          </div>
                        )}

                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={entry.mode === 'daily' ? 'default' : 'outline'} className="text-xs">
                              {t(entry.mode === 'daily' ? 'modeDaily' : 'modeImmediate')}
                            </Badge>
                            <span className="text-sm text-muted-foreground">
                              <time dateTime={entry.sentAt}>{formatDateTime(entry.sentAt)}</time>
                            </span>
                          </div>
                          <p className="font-semibold leading-snug line-clamp-2 mt-1">{entry.subject}</p>
                          <p className="text-sm text-muted-foreground truncate mt-0.5">
                            {t(entry.itemCount === 1 ? 'itemCount_one' : 'itemCount_other', { count: entry.itemCount })}
                            {entry.sources.length > 0 && ` · ${entry.sources.join(', ')}`}
                          </p>
                        </div>

                        <Button asChild variant="outline" size="sm" className="shrink-0">
                          <Link href={`/archive/${entry.id}`} aria-label={t('readMailLabel', { subject: entry.subject })}>
                            {t('readButton')}
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-8">
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
                      <span className="flex items-center px-4 text-sm text-muted-foreground">
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
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
