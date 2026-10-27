'use client'

import { useEffect, useState } from 'react'
import { Pencil, Settings2, Trash2 } from 'lucide-react'
import { useTranslations, useLocale } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { deliveryPatchOf, deliveryTargetsOf, toggleDeliveryTarget } from '@/lib/newsletter/delivery-targets.mjs'
import { socialProfileUrl } from '@/lib/social/platforms.mjs'
import type { DeliveryTarget, Episode, PodcastSubscription, SourceCategory, SourceType } from '@/types/database'
import { InitialsTile } from '@/components/app/AppPage'
import { avatarColorOf, initialsOf } from '@/lib/ui/source-avatar.mjs'
import { groupSourcesByCategory } from '@/lib/ui/source-groups.mjs'

type FailedEpisode = Pick<Episode, 'id' | 'subscription_id' | 'title' | 'status' | 'error_code' | 'error_message' | 'published_at'>

export type SourcePatch = Partial<Pick<PodcastSubscription, 'title' | 'enabled' | 'deliver_immediately' | 'deliver_daily' | 'category_id'>>

// Radix Select needs a non-empty value for "no category".
const NO_CATEGORY = 'none'

// error_code is written for YouTube videos and website articles; podcast failures fall back to
// the generic text.
const ERROR_CODE_KEYS: Record<string, string> = {
  video_unavailable: 'youtubeErrorVideoUnavailable',
  video_not_yet_available: 'youtubeErrorNotYetAvailable',
  youtube_blocked: 'youtubeErrorBlocked',
  youtube_fetch_failed: 'youtubeErrorFetchFailed',
  youtube_tool_missing: 'youtubeErrorToolMissing',
  audio_download_failed: 'youtubeErrorAudioDownload',
  stt_failed: 'youtubeErrorStt',
  paywalled: 'websiteErrorPaywalled',
  access_restricted: 'websiteErrorAccessRestricted',
  content_incomplete: 'websiteErrorContentIncomplete',
  article_unavailable: 'websiteErrorArticleUnavailable',
  article_fetch_failed: 'websiteErrorArticleFetchFailed',
}

const TYPE_BADGES: Record<SourceType, { label: string; failedTitle: string; failedUnknown: string }> = {
  podcast: { label: 'typeBadgePodcast', failedTitle: 'failedEpisodesTitle', failedUnknown: 'failedUnknown' },
  youtube: { label: 'typeBadgeYoutube', failedTitle: 'failedVideosTitle', failedUnknown: 'failedUnknown' },
  website: { label: 'typeBadgeWebsite', failedTitle: 'failedArticlesTitle', failedUnknown: 'failedArticleUnknown' },
  social: { label: 'typeBadgeSocial', failedTitle: 'failedPostsTitle', failedUnknown: 'failedPostUnknown' },
}

/** Where the source card links to: channel page, account profile or the feed itself. */
function sourceLink(source: PodcastSubscription) {
  if (source.source_type === 'youtube') {
    return { href: `https://www.youtube.com/channel/${source.youtube_channel_id}`, text: source.youtube_channel_id ?? '' }
  }
  if (source.source_type === 'social' && source.social_handle) {
    return { href: socialProfileUrl(source), text: `@${source.social_handle}` }
  }
  return { href: source.feed_url, text: source.feed_url }
}

function typeInfo(source: PodcastSubscription) {
  const info = TYPE_BADGES[source.source_type] ?? TYPE_BADGES.podcast
  return source.source_type === 'social' && source.social_platform === 'bluesky' ? { ...info, label: 'typeBadgeBluesky' } : info
}

function SourceStatusBadge({ source }: { source: PodcastSubscription }) {
  const t = useTranslations('subscriptions')
  if (!source.enabled) return <Badge variant="secondary">{t('statusDisabled')}</Badge>
  if (source.last_check_status === 'error') return <Badge variant="destructive">{t('statusError')}</Badge>
  if (source.last_check_status === 'success') {
    return <Badge className="bg-[#E3F1EA] text-[#1F6B4A] hover:bg-[#E3F1EA]">{t('statusOk')}</Badge>
  }
  return <Badge variant="outline">{t('statusPending')}</Badge>
}

const toggleChip = (on: boolean) =>
  on ? 'border-castle-control bg-castle-mist text-castle-ink' : 'border-castle-line bg-white text-[#9AABB1]'

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-castle-warn-bg px-3 py-2.5 text-[13px] leading-[1.45] text-castle-warn-fg sm:ml-14">
      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-castle-warn-dot" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// ─── Source Row ──────────────────────────────────────────────────────

function SourceRow({
  source,
  categories,
  failedEpisodes,
  onUpdate,
  onDelete,
}: {
  source: PodcastSubscription
  categories: SourceCategory[]
  failedEpisodes: FailedEpisode[]
  onUpdate: (source: PodcastSubscription, patch: SourcePatch) => Promise<boolean>
  onDelete: (source: PodcastSubscription) => void
}) {
  const t = useTranslations('subscriptions')
  const locale = useLocale()
  const [manageOpen, setManageOpen] = useState(false)
  const [failedOpen, setFailedOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(source.title)
  const [targetRequired, setTargetRequired] = useState(false)
  const deliveryId = `delivery-${source.id}`
  const switchId = `enabled-${source.id}`
  const categoryId = `category-${source.id}`
  const manageId = `manage-${source.id}`
  const failedId = `failed-${source.id}`
  // A category that is gone (deleted elsewhere) counts as none.
  const currentCategory = source.category_id && categories.some((c) => c.id === source.category_id) ? source.category_id : NO_CATEGORY
  const link = sourceLink(source)
  const targets = deliveryTargetsOf(source)
  const info = typeInfo(source)

  // Kanban #43: immediate and daily are combinable; the last active one stays on.
  function toggleTarget(target: DeliveryTarget, checked: boolean) {
    const result = toggleDeliveryTarget(targets, target, checked)
    setTargetRequired(!result.ok)
    if (result.ok) onUpdate(source, deliveryPatchOf(result.targets))
  }

  function formatDateTime(value: string) {
    return new Date(value).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  async function saveTitle(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || trimmed === source.title) {
      setTitle(source.title)
      setEditing(false)
      return
    }
    if (await onUpdate(source, { title: trimmed })) setEditing(false)
  }

  return (
    <li className="flex flex-col gap-3 border-b border-castle-line-soft px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className={source.enabled ? '' : 'opacity-45'}>
          <InitialsTile initials={initialsOf(source.title)} color={avatarColorOf(source.title)} size={42} radius={10} />
        </span>
        <div className={`flex min-w-[200px] flex-1 flex-col gap-[3px] ${source.enabled ? '' : 'opacity-45'}`}>
          <span className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-[15px] font-medium">{source.title}</h3>
            <span className="rounded-[5px] bg-castle-haze px-[7px] py-0.5 text-[11px] font-medium text-castle-muted">
              <span className="sr-only">{t('sourceTypeLabel')} </span>
              {t(info.label)}
            </span>
          </span>
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-mono text-xs text-castle-faint hover:text-castle-ink"
          >
            {link.text}
            <span className="sr-only"> {t('opensInNewTab')}</span>
          </a>
        </div>
        <div className="flex items-center gap-3">
          <fieldset className="m-0 flex gap-1.5 border-0 p-0" aria-describedby={targetRequired ? `${deliveryId}-required` : undefined}>
            <legend className="sr-only">{t('deliveryModeLabel')}</legend>
            {(['immediate', 'daily'] as const).map((target) => (
              <button
                key={target}
                type="button"
                aria-pressed={targets[target]}
                title={t(target === 'immediate' ? 'deliveryTargetImmediate' : 'deliveryTargetDaily')}
                onClick={() => toggleTarget(target, !targets[target])}
                className={`rounded-[7px] border px-2.5 py-1.5 text-[12.5px] font-medium ${toggleChip(targets[target])}`}
              >
                {t(target === 'immediate' ? 'deliveryChipImmediate' : 'deliveryChipDaily')}
              </button>
            ))}
          </fieldset>
          <Switch
            id={switchId}
            checked={source.enabled}
            aria-label={t('enabledFor', { title: source.title })}
            onCheckedChange={(checked) => onUpdate(source, { enabled: checked })}
            className="data-[state=checked]:bg-castle-ink data-[state=unchecked]:bg-[#CBD5D8]"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-castle-subtle"
            aria-expanded={manageOpen}
            aria-controls={manageId}
            aria-label={t('manageSource', { title: source.title })}
            onClick={() => setManageOpen((open) => !open)}
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {targetRequired && (
        <p id={`${deliveryId}-required`} role="alert" className="m-0 text-sm text-destructive sm:ml-14">
          {t('deliveryTargetRequired')}
        </p>
      )}

      {source.last_check_status === 'error' && source.last_check_error && (
        <Warning>
          {t('statusError')}: {source.last_check_error}
        </Warning>
      )}

      {failedEpisodes.length > 0 && (
        <Warning>
          <span>
            {t(info.failedTitle)} ({failedEpisodes.length}).{' '}
            <button
              type="button"
              aria-expanded={failedOpen}
              aria-controls={failedId}
              onClick={() => setFailedOpen((open) => !open)}
              className="underline underline-offset-2"
            >
              {t(failedOpen ? 'detailsHide' : 'detailsShow')}
            </button>
          </span>
          {failedOpen && (
            <ul id={failedId} className="mt-2 space-y-1">
              {failedEpisodes.map((episode) => (
                <li key={episode.id}>
                  <span className="font-medium">{episode.title}</span>
                  {' – '}
                  {episode.error_code && ERROR_CODE_KEYS[episode.error_code] ? t(ERROR_CODE_KEYS[episode.error_code]) : t(info.failedUnknown)}
                  {episode.error_message && (
                    <span className="block break-words text-xs opacity-80">{episode.error_message}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Warning>
      )}

      {manageOpen && (
        <div id={manageId} className="flex flex-col gap-3 rounded-lg border border-castle-line-soft bg-castle-row p-3 sm:ml-14">
          {editing ? (
            <form onSubmit={saveTitle} className="flex flex-wrap gap-2">
              <Input
                aria-label={t('titleLabel')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="h-9 min-w-[200px] flex-1 bg-white"
                autoFocus
              />
              <Button type="submit" size="sm">{t('saveButton')}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setTitle(source.title); setEditing(false) }}>
                {t('cancelButton')}
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="bg-white" onClick={() => setEditing(true)} aria-label={t('editTitle', { title: source.title })}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('titleLabel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDelete(source)}
                className="bg-white text-destructive hover:text-destructive"
                aria-label={t('deleteSource', { title: source.title })}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('deleteConfirmShort')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* Kanban #48: at most one category per source; it only orders the daily newsletter. */}
            <Label htmlFor={categoryId} className="text-sm font-normal text-castle-muted">{t('sourceCategoryLabel')}</Label>
            <Select
              value={currentCategory}
              onValueChange={(value) => {
                const next = value === NO_CATEGORY ? null : value
                if (next !== (source.category_id ?? null)) onUpdate(source, { category_id: next })
              }}
            >
              <SelectTrigger id={categoryId} className="h-9 w-48 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>{t('sourceCategoryNone')}</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-castle-subtle">
            <SourceStatusBadge source={source} />
            {source.last_checked_at && <span>{t('lastChecked', { date: formatDateTime(source.last_checked_at) })}</span>}
          </div>
        </div>
      )}
    </li>
  )
}

// ─── Source List ─────────────────────────────────────────────────────

/**
 * All sources of the user (podcasts, YouTube channels, websites, Mastodon/Bluesky accounts),
 * grouped by the user's categories in newsletter order; sources without a category last.
 */
export function SourceList({
  sources,
  categories,
  onUpdate,
  onDelete,
  onMoveCategory,
}: {
  sources: PodcastSubscription[]
  /** The user's categories in their order (Kanban #48) */
  categories: SourceCategory[]
  onUpdate: (source: PodcastSubscription, patch: SourcePatch) => Promise<boolean>
  onDelete: (source: PodcastSubscription) => void
  onMoveCategory: (category: SourceCategory, direction: 'up' | 'down') => void
}) {
  const supabase = createClient()
  const t = useTranslations('subscriptions')
  const [failedEpisodes, setFailedEpisodes] = useState<FailedEpisode[]>([])
  const sourceIds = sources.map((s) => s.id).join(',')

  // Failed episodes/videos/articles are shown per source; reloaded whenever the set of sources changes.
  useEffect(() => {
    if (!sourceIds) return
    let cancelled = false
    supabase
      .from('episodes')
      .select('id, subscription_id, title, status, error_code, error_message, published_at')
      .in('subscription_id', sourceIds.split(','))
      .eq('status', 'failed')
      .order('published_at', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!cancelled) setFailedEpisodes((data ?? []) as FailedEpisode[])
      })
    return () => {
      cancelled = true
    }
  }, [sourceIds, supabase])

  if (sources.length === 0) {
    return (
      <div className="rounded-2xl border border-castle-line bg-white px-6 py-12 text-center">
        <p className="mb-2 text-lg text-castle-ink">{t('emptyStateTitle')}</p>
        <p className="m-0 text-sm text-castle-muted">{t('emptyStateHint')}</p>
      </div>
    )
  }

  const groups = groupSourcesByCategory(sources, categories)

  return (
    <div className="flex flex-col gap-7">
      <p className="m-0 px-1 text-sm text-castle-muted">{t('sourceListHint')}</p>
      {groups.map((group, index) => {
        const category = group.category
        const position = category ? categories.findIndex((c) => c.id === category.id) : -1
        const headingId = `source-group-${category?.id ?? 'none'}`
        return (
          <section key={category?.id ?? 'none'} aria-labelledby={headingId} className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3 px-1">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                <span aria-hidden="true" className="font-mono text-xs text-castle-amber-deep">{String(index + 1).padStart(2, '0')}</span>
                <h2 id={headingId} className="m-0 text-[15px] font-semibold">{category?.name ?? t('categoryUncategorized')}</h2>
                <span className="whitespace-nowrap text-[13px] text-castle-subtle">{t(group.sources.length === 1 ? 'sourceCount_one' : 'sourceCount_other', { count: group.sources.length })}</span>
              </span>
              {category && categories.length > 1 && (
                <span className="flex flex-none items-center gap-1 text-[13px] text-castle-subtle">
                  <span aria-hidden="true" className="hidden sm:inline">{t('orderLabel')}</span>
                  <button
                    type="button"
                    disabled={position <= 0}
                    onClick={() => onMoveCategory(category, 'up')}
                    aria-label={t('categoryMoveUp', { name: category.name })}
                    className="rounded px-1 hover:text-castle-ink disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={position === categories.length - 1}
                    onClick={() => onMoveCategory(category, 'down')}
                    aria-label={t('categoryMoveDown', { name: category.name })}
                    className="rounded px-1 hover:text-castle-ink disabled:opacity-30"
                  >
                    ↓
                  </button>
                </span>
              )}
            </div>
            {group.sources.length === 0 ? (
              <p className="m-0 rounded-[14px] border border-dashed border-castle-line bg-white px-5 py-4 text-sm text-castle-subtle">{t('categoryGroupEmpty')}</p>
            ) : (
              <ul className="m-0 list-none overflow-hidden rounded-[14px] border border-castle-line bg-white p-0">
                {group.sources.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    categories={categories}
                    failedEpisodes={failedEpisodes.filter((e) => e.subscription_id === source.id).slice(0, 5)}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
