'use client'

import { useEffect, useState } from 'react'
import { AtSign, Globe, Pencil, Podcast, Trash2, Youtube } from 'lucide-react'
import { useTranslations, useLocale } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Episode, PodcastSubscription, SourceType } from '@/types/database'
import { SourceImage } from './SourceImage'

type FailedEpisode = Pick<Episode, 'id' | 'subscription_id' | 'title' | 'status' | 'error_code' | 'error_message' | 'published_at'>

export type SourcePatch = Partial<Pick<PodcastSubscription, 'title' | 'enabled' | 'delivery_mode'>>

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

const TYPE_BADGES: Record<SourceType, { icon: typeof Podcast; label: string; failedTitle: string; failedUnknown: string }> = {
  podcast: { icon: Podcast, label: 'typeBadgePodcast', failedTitle: 'failedEpisodesTitle', failedUnknown: 'failedUnknown' },
  youtube: { icon: Youtube, label: 'typeBadgeYoutube', failedTitle: 'failedVideosTitle', failedUnknown: 'failedUnknown' },
  website: { icon: Globe, label: 'typeBadgeWebsite', failedTitle: 'failedArticlesTitle', failedUnknown: 'failedArticleUnknown' },
  social: { icon: AtSign, label: 'typeBadgeSocial', failedTitle: 'failedPostsTitle', failedUnknown: 'failedPostUnknown' },
}

/** Where the source card links to: channel page, account profile or the feed itself. */
function sourceLink(source: PodcastSubscription) {
  if (source.source_type === 'youtube') {
    return { href: `https://www.youtube.com/channel/${source.youtube_channel_id}`, text: source.youtube_channel_id ?? '' }
  }
  if (source.source_type === 'social' && source.social_handle) {
    // feed_url is the profile's RSS feed (https://<instance>/@<user>.rss).
    return { href: source.feed_url.replace(/\.rss$/, ''), text: `@${source.social_handle}` }
  }
  return { href: source.feed_url, text: source.feed_url }
}

function typeInfo(source: PodcastSubscription) {
  return TYPE_BADGES[source.source_type] ?? TYPE_BADGES.podcast
}

function SourceTypeBadge({ source }: { source: PodcastSubscription }) {
  const t = useTranslations('subscriptions')
  const { icon: Icon, label } = typeInfo(source)
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{t('sourceTypeLabel')} </span>
      {t(label)}
    </Badge>
  )
}

function SourceStatusBadge({ source }: { source: PodcastSubscription }) {
  const t = useTranslations('subscriptions')
  if (!source.enabled) return <Badge variant="secondary">{t('statusDisabled')}</Badge>
  if (source.last_check_status === 'error') return <Badge variant="destructive">{t('statusError')}</Badge>
  if (source.last_check_status === 'success') {
    return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('statusOk')}</Badge>
  }
  return <Badge variant="outline">{t('statusPending')}</Badge>
}

// ─── Source Card ─────────────────────────────────────────────────────

function SourceCard({
  source,
  failedEpisodes,
  onUpdate,
  onDelete,
}: {
  source: PodcastSubscription
  failedEpisodes: FailedEpisode[]
  onUpdate: (source: PodcastSubscription, patch: SourcePatch) => Promise<boolean>
  onDelete: (source: PodcastSubscription) => void
}) {
  const t = useTranslations('subscriptions')
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(source.title)
  const selectId = `delivery-mode-${source.id}`
  const switchId = `enabled-${source.id}`
  const link = sourceLink(source)

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
    <li className="py-4 space-y-3">
      <div className="flex items-center gap-4">
        <SourceImage type={source.source_type} title={source.title} url={source.cover_image_url} size={64} />
        <div className="flex-1 min-w-0 space-y-1">
          {editing ? (
            <form onSubmit={saveTitle} className="flex gap-2">
              <Input
                aria-label={t('titleLabel')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="h-9"
                autoFocus
              />
              <Button type="submit" size="sm">{t('saveButton')}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setTitle(source.title); setEditing(false) }}>
                {t('cancelButton')}
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-base truncate">{source.title}</h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => setEditing(true)}
                aria-label={t('editTitle', { title: source.title })}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-muted-foreground font-mono hover:text-primary"
          >
            {link.text}
            <span className="sr-only"> {t('opensInNewTab')}</span>
          </a>
          <div className="flex flex-wrap items-center gap-2">
            <SourceTypeBadge source={source} />
            <SourceStatusBadge source={source} />
            {source.last_checked_at && (
              <span className="text-xs text-muted-foreground">
                {t('lastChecked', { date: formatDateTime(source.last_checked_at) })}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(source)}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t('deleteSource', { title: source.title })}
        >
          <Trash2 className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>

      {source.last_check_status === 'error' && source.last_check_error && (
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{source.last_check_error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={source.enabled}
            onCheckedChange={(checked) => onUpdate(source, { enabled: checked })}
          />
          <Label htmlFor={switchId} className="text-sm font-normal">{t('enabledLabel')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId} className="text-sm text-muted-foreground font-normal">
            {t('deliveryModeLabel')}
          </Label>
          <Select
            value={source.delivery_mode === 'immediate' ? 'immediate' : 'daily'}
            onValueChange={(value) => onUpdate(source, { delivery_mode: value === 'immediate' ? 'immediate' : 'daily' })}
          >
            <SelectTrigger id={selectId} className="h-8 w-auto min-w-44 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{t('deliveryModeDaily')}</SelectItem>
              <SelectItem value="immediate">{t('deliveryModeImmediate')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {failedEpisodes.length > 0 && (
        <div className="rounded-md border border-destructive/30 p-3 space-y-2">
          <p className="text-sm font-medium">{t(typeInfo(source).failedTitle)}</p>
          <ul className="space-y-1">
            {failedEpisodes.map((episode) => (
              <li key={episode.id} className="text-sm">
                <span className="font-medium">{episode.title}</span>
                {' – '}
                <span className="text-muted-foreground">
                  {episode.error_code && ERROR_CODE_KEYS[episode.error_code] ? t(ERROR_CODE_KEYS[episode.error_code]) : t(typeInfo(source).failedUnknown)}
                </span>
                {episode.error_message && (
                  <span className="block text-xs text-muted-foreground break-words">{episode.error_message}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

// ─── Source List ─────────────────────────────────────────────────────

/** All sources of the user (podcasts, YouTube channels, websites, Mastodon accounts) with the same actions. */
export function SourceList({
  sources,
  onUpdate,
  onDelete,
}: {
  sources: PodcastSubscription[]
  onUpdate: (source: PodcastSubscription, patch: SourcePatch) => Promise<boolean>
  onDelete: (source: PodcastSubscription) => void
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t('sourceListTitle')}</CardTitle>
        <CardDescription className="text-base">
          {sources.length === 0
            ? t('noSources')
            : t(sources.length === 1 ? 'sourceCount_one' : 'sourceCount_other', { count: sources.length })}
        </CardDescription>
        {sources.length > 0 && <p className="text-sm text-muted-foreground">{t('sourceListHint')}</p>}
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <div className="py-12 text-center">
            <div className="text-5xl mb-4" aria-hidden="true">🎧</div>
            <p className="text-muted-foreground text-lg mb-2">{t('emptyStateTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyStateHint')}</p>
          </div>
        ) : (
          <ul className="divide-y">
            {sources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                failedEpisodes={failedEpisodes.filter((e) => e.subscription_id === source.id).slice(0, 5)}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
