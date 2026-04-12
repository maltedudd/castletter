'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useTranslations, useLocale } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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
import type { PodcastSubscription } from '@/types/database'

const PAGE_SIZE = 20

interface ArchiveEntry {
  id: string
  title: string
  newsletter_sent_at: string
  audio_url: string
  subscription_id: string
  podcast_title: string
  podcast_cover_image_url: string | null
}

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

export default function ArchivePage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('archive')
  const locale = useLocale()

  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [subscriptions, setSubscriptions] = useState<PodcastSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [filterSubscriptionId, setFilterSubscriptionId] = useState<string>('all')

  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-US', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    })
  }

  const loadData = useCallback(async () => {
    if (!user) return
    setLoading(true)

    // Load subscriptions for filter dropdown (only once needed, but simpler here)
    const { data: subs } = await supabase
      .from('podcast_subscriptions')
      .select('id, title, cover_image_url, user_id, feed_url, description, created_at, updated_at')
      .eq('user_id', user.id)
      .order('title', { ascending: true })

    if (subs) setSubscriptions(subs)

    // Build episode query
    let query = supabase
      .from('episodes')
      .select(
        `
        id,
        title,
        newsletter_sent_at,
        audio_url,
        subscription_id,
        podcast_subscriptions!inner (
          id,
          title,
          cover_image_url,
          user_id
        )
        `,
        { count: 'exact' }
      )
      .eq('status', 'newsletter_sent')
      .not('newsletter_sent_at', 'is', null)
      .eq('podcast_subscriptions.user_id', user.id)

    if (filterSubscriptionId !== 'all') {
      query = query.eq('subscription_id', filterSubscriptionId)
    }

    const from = (currentPage - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1

    const { data, count, error } = await query
      .order('newsletter_sent_at', { ascending: false })
      .range(from, to)

    if (!error && data) {
      const mapped: ArchiveEntry[] = data.map((row) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sub = row.podcast_subscriptions as any
        return {
          id: row.id,
          title: row.title,
          newsletter_sent_at: row.newsletter_sent_at as string,
          audio_url: row.audio_url,
          subscription_id: row.subscription_id,
          podcast_title: sub?.title ?? t('unknownPodcast'),
          podcast_cover_image_url: sub?.cover_image_url ?? null,
        }
      })
      setEntries(mapped)
      setTotalCount(count ?? 0)
    }

    setLoading(false)
  }, [user, supabase, currentPage, filterSubscriptionId, t])

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

  // Reset to page 1 when filter changes
  function handleFilterChange(value: string) {
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
        <div className="flex items-center gap-3 mb-6">
          <Select value={filterSubscriptionId} onValueChange={handleFilterChange}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t('filterAllPodcasts')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('filterAllPodcasts')}</SelectItem>
              {subscriptions.map((sub) => (
                <SelectItem key={sub.id} value={sub.id}>
                  {sub.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {!loading && (
            <span className="text-sm text-muted-foreground">
              {t(totalCount === 1 ? 'entryCount_one' : 'entryCount_other', { count: totalCount })}
            </span>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <ArchiveEntrySkeleton key={i} />
            ))}
          </div>
        ) : entries.length === 0 ? (
          /* Empty State */
          <Card>
            <CardContent className="py-16 text-center">
              <div className="text-5xl mb-4">📬</div>
              <p className="text-lg font-semibold mb-2">
                {filterSubscriptionId !== 'all'
                  ? t('emptyTitleFiltered')
                  : t('emptyTitleAll')}
              </p>
              <p className="text-muted-foreground text-sm mb-6">
                {filterSubscriptionId !== 'all'
                  ? t('emptyHintFiltered')
                  : t('emptyHintAll')}
              </p>
              {filterSubscriptionId === 'all' && (
                <Button asChild variant="outline">
                  <Link href="/subscriptions">{t('subscribeLink')}</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="space-y-3">
              {entries.map((entry) => (
                <Card key={entry.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-5">
                    <div className="flex items-center gap-4">
                      {/* Cover */}
                      {entry.podcast_cover_image_url ? (
                        <Image
                          src={entry.podcast_cover_image_url}
                          alt={entry.podcast_title}
                          width={64}
                          height={64}
                          className="rounded-lg object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center text-2xl shrink-0">
                          🎙️
                        </div>
                      )}

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-muted-foreground truncate">
                          {entry.podcast_title}
                        </p>
                        <p className="font-semibold leading-snug line-clamp-2 mt-0.5">
                          {entry.title}
                        </p>
                        <Badge variant="secondary" className="mt-1.5 text-xs">
                          {formatDate(entry.newsletter_sent_at)}
                        </Badge>
                      </div>

                      {/* Action */}
                      <Button asChild variant="outline" size="sm" className="shrink-0">
                        <Link href={`/archive/${entry.id}`}>{t('readButton')}</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

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
