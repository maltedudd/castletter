'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Pencil, Trash2 } from 'lucide-react'
import { useTranslations, useLocale } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  Episode,
  NewsletterDeliveryMode,
  PodcastSubscription,
  YouTubeChannelMeta,
} from '@/types/database'

type FailedVideo = Pick<Episode, 'id' | 'subscription_id' | 'title' | 'status' | 'error_code' | 'error_message' | 'published_at'>

const ERROR_CODE_KEYS: Record<string, string> = {
  video_unavailable: 'youtubeErrorVideoUnavailable',
  video_not_yet_available: 'youtubeErrorNotYetAvailable',
  youtube_blocked: 'youtubeErrorBlocked',
  youtube_fetch_failed: 'youtubeErrorFetchFailed',
  youtube_tool_missing: 'youtubeErrorToolMissing',
  audio_download_failed: 'youtubeErrorAudioDownload',
  stt_failed: 'youtubeErrorStt',
}

// ─── Add Channel Form ────────────────────────────────────────────────

function AddYouTubeChannelForm({ onAdded }: { onAdded: () => void }) {
  const { user } = useAuth()
  const supabase = createClient()
  const t = useTranslations('subscriptions')

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<YouTubeChannelMeta | null>(null)

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPreview(null)
    setLoading(true)
    try {
      const res = await fetch('/api/youtube/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || t('youtubeErrorResolve'))
        return
      }
      setPreview(data as YouTubeChannelMeta)
    } catch {
      setError(t('errorNetworkFeed'))
    } finally {
      setLoading(false)
    }
  }

  async function handleAdd() {
    if (!preview || !user) return
    setError(null)
    setSaving(true)
    try {
      const { error: dbError } = await supabase.from('podcast_subscriptions').insert({
        user_id: user.id,
        source_type: 'youtube',
        youtube_channel_id: preview.channelId,
        feed_url: preview.feedUrl,
        title: preview.title,
        description: preview.description,
        cover_image_url: preview.thumbnailUrl,
      })
      if (dbError) {
        setError(dbError.code === '23505' ? t('youtubeErrorAlreadyAdded') : t('errorSaveFeed'))
        return
      }
      setInput('')
      setPreview(null)
      onAdded()
    } catch {
      setError(t('errorUnexpected'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t('youtubeAddTitle')}</CardTitle>
        <CardDescription className="text-base">{t('youtubeAddDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form onSubmit={handleResolve} className="space-y-2">
          <Label htmlFor="youtube-channel" className="text-sm font-medium">
            {t('youtubeInputLabel')}
          </Label>
          <div className="flex gap-3">
            <Input
              id="youtube-channel"
              placeholder={t('youtubeInputPlaceholder')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
              disabled={loading || !!preview}
              className="h-11 flex-1"
            />
            {!preview && (
              <Button type="submit" disabled={loading || !input.trim()} className="h-11">
                {loading ? t('validateButtonLoading') : t('youtubeResolveButton')}
              </Button>
            )}
          </div>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {preview && (
          <div className="border rounded-lg p-6 space-y-4">
            <div className="flex gap-4 items-start">
              <ChannelAvatar title={preview.title} url={preview.thumbnailUrl} size={96} />
              <div className="space-y-2 min-w-0">
                <h3 className="text-lg font-semibold">{preview.title}</h3>
                <p className="text-xs text-muted-foreground font-mono">{preview.channelId}</p>
                {preview.description && (
                  <p className="text-sm text-muted-foreground line-clamp-3">{preview.description}</p>
                )}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleAdd} disabled={saving}>
                {saving ? t('subscribeButtonLoading') : t('youtubeAddButton')}
              </Button>
              <Button variant="outline" onClick={() => { setPreview(null); setError(null) }} disabled={saving}>
                {t('cancelButton')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ChannelAvatar({ title, url, size }: { title: string; url: string | null; size: number }) {
  if (url) {
    return <Image src={url} alt={title} width={size} height={size} className="rounded-full object-cover shrink-0" />
  }
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center text-2xl shrink-0"
      style={{ width: size, height: size }}
    >
      ▶️
    </div>
  )
}

// ─── Channel Card ────────────────────────────────────────────────────

function YouTubeChannelCard({
  channel,
  failedVideos,
  onUpdate,
  onDelete,
}: {
  channel: PodcastSubscription
  failedVideos: FailedVideo[]
  onUpdate: (channel: PodcastSubscription, patch: Partial<Pick<PodcastSubscription, 'title' | 'enabled' | 'delivery_mode'>>) => Promise<boolean>
  onDelete: (channel: PodcastSubscription) => void
}) {
  const t = useTranslations('subscriptions')
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(channel.title)
  const selectId = `delivery-mode-${channel.id}`
  const switchId = `enabled-${channel.id}`

  function formatDateTime(value: string) {
    return new Date(value).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  async function saveTitle(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed || trimmed === channel.title) {
      setTitle(channel.title)
      setEditing(false)
      return
    }
    if (await onUpdate(channel, { title: trimmed })) setEditing(false)
  }

  return (
    <div className="py-4 space-y-3">
      <div className="flex items-center gap-4">
        <ChannelAvatar title={channel.title} url={channel.cover_image_url} size={64} />
        <div className="flex-1 min-w-0 space-y-1">
          {editing ? (
            <form onSubmit={saveTitle} className="flex gap-2">
              <Input
                aria-label={t('youtubeTitleLabel')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                className="h-9"
                autoFocus
              />
              <Button type="submit" size="sm">{t('youtubeSaveButton')}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setTitle(channel.title); setEditing(false) }}>
                {t('cancelButton')}
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-base truncate">{channel.title}</h3>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)} aria-label={t('youtubeEditTitle')}>
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          )}
          <a
            href={`https://www.youtube.com/channel/${channel.youtube_channel_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground font-mono hover:text-primary"
          >
            {channel.youtube_channel_id}
          </a>
          <div className="flex flex-wrap items-center gap-2">
            {!channel.enabled ? (
              <Badge variant="secondary">{t('youtubeStatusDisabled')}</Badge>
            ) : channel.last_check_status === 'error' ? (
              <Badge variant="destructive">{t('youtubeStatusError')}</Badge>
            ) : channel.last_check_status === 'success' ? (
              <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t('youtubeStatusOk')}</Badge>
            ) : (
              <Badge variant="outline">{t('youtubeStatusPending')}</Badge>
            )}
            {channel.last_checked_at && (
              <span className="text-xs text-muted-foreground">
                {t('youtubeLastChecked', { date: formatDateTime(channel.last_checked_at) })}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(channel)}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t('youtubeDeleteTitle')}
        >
          <Trash2 className="h-5 w-5" />
        </Button>
      </div>

      {channel.last_check_status === 'error' && channel.last_check_error && (
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{channel.last_check_error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={channel.enabled}
            onCheckedChange={(checked) => onUpdate(channel, { enabled: checked })}
          />
          <Label htmlFor={switchId} className="text-sm font-normal">{t('youtubeEnabledLabel')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId} className="text-sm text-muted-foreground font-normal">
            {t('deliveryModeLabel')}
          </Label>
          <Select
            value={channel.delivery_mode === 'immediate' ? 'immediate' : 'daily'}
            onValueChange={(value) => onUpdate(channel, { delivery_mode: value === 'immediate' ? 'immediate' : 'daily' })}
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

      {failedVideos.length > 0 && (
        <div className="rounded-md border border-destructive/30 p-3 space-y-2">
          <p className="text-sm font-medium">{t('youtubeFailedVideosTitle')}</p>
          <ul className="space-y-1">
            {failedVideos.map((video) => (
              <li key={video.id} className="text-sm">
                <span className="font-medium">{video.title}</span>
                {' – '}
                <span className="text-muted-foreground">
                  {video.error_code && ERROR_CODE_KEYS[video.error_code] ? t(ERROR_CODE_KEYS[video.error_code]) : t('youtubeErrorUnknown')}
                </span>
                {video.error_message && (
                  <span className="block text-xs text-muted-foreground break-words">{video.error_message}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────

/** YouTube channels: managed like podcast feeds, stored in the same source table. */
export function YouTubeChannelsSection({
  channels,
  onChanged,
  onDelete,
  onMessage,
}: {
  channels: PodcastSubscription[]
  onChanged: () => void
  onDelete: (channel: PodcastSubscription) => void
  onMessage: (message: { success?: string; error?: string }) => void
}) {
  const supabase = createClient()
  const t = useTranslations('subscriptions')
  const [failedVideos, setFailedVideos] = useState<FailedVideo[]>([])

  // Failed videos are shown per channel; reloaded whenever the channel list changes.
  useEffect(() => {
    const ids = channels.map((c) => c.id)
    if (ids.length === 0) return
    let cancelled = false
    supabase
      .from('episodes')
      .select('id, subscription_id, title, status, error_code, error_message, published_at')
      .in('subscription_id', ids)
      .eq('status', 'failed')
      .order('published_at', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!cancelled) setFailedVideos((data ?? []) as FailedVideo[])
      })
    return () => {
      cancelled = true
    }
  }, [channels, supabase])

  async function handleUpdate(
    channel: PodcastSubscription,
    patch: Partial<Pick<PodcastSubscription, 'title' | 'enabled' | 'delivery_mode'>>
  ) {
    const { error } = await supabase.from('podcast_subscriptions').update(patch).eq('id', channel.id)
    if (error) {
      onMessage({ error: t('youtubeErrorSave') })
      return false
    }
    onMessage({ success: t('youtubeSaved', { title: patch.title ?? channel.title }) })
    onChanged()
    return true
  }

  return (
    <div className="space-y-12">
      <AddYouTubeChannelForm onAdded={() => { onMessage({ success: t('youtubeSuccessAdded') }); onChanged() }} />
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{t('youtubeListTitle')}</CardTitle>
          <CardDescription className="text-base">
            {channels.length === 0
              ? t('youtubeEmpty')
              : t(channels.length === 1 ? 'youtubeCount_one' : 'youtubeCount_other', { count: channels.length })}
          </CardDescription>
          {channels.length > 0 && <p className="text-sm text-muted-foreground">{t('youtubeHint')}</p>}
        </CardHeader>
        {channels.length > 0 && (
          <CardContent>
            <div className="divide-y">
              {channels.map((channel) => (
                <YouTubeChannelCard
                  key={channel.id}
                  channel={channel}
                  failedVideos={failedVideos.filter((v) => v.subscription_id === channel.id).slice(0, 5)}
                  onUpdate={handleUpdate}
                  onDelete={onDelete}
                />
              ))}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
