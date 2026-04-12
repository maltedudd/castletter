'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { PodcastSubscription, PodcastFeedMeta } from '@/types/database'

// ─── Add Podcast Form ────────────────────────────────────────────────

function AddPodcastForm({ onSubscribed }: { onSubscribed: () => void }) {
  const { user } = useAuth()
  const supabase = createClient()
  const t = useTranslations('subscriptions')

  const [feedUrl, setFeedUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PodcastFeedMeta | null>(null)

  async function handleValidate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setPreview(null)
    setLoading(true)

    try {
      const res = await fetch('/api/podcasts/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedUrl: feedUrl.trim() }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || t('errorValidateFeed'))
        setLoading(false)
        return
      }

      setPreview(data as PodcastFeedMeta)
    } catch {
      setError(t('errorNetworkFeed'))
    } finally {
      setLoading(false)
    }
  }

  async function handleSubscribe() {
    if (!preview || !user) return
    setError(null)
    setSubscribing(true)

    try {
      const { error: dbError } = await supabase
        .from('podcast_subscriptions')
        .insert({
          user_id: user.id,
          feed_url: preview.feedUrl,
          title: preview.title,
          description: preview.description,
          cover_image_url: preview.coverImageUrl,
        })

      if (dbError) {
        // Unique constraint violation → duplicate
        if (dbError.code === '23505') {
          setError(t('errorAlreadySubscribed'))
        } else {
          setError(t('errorSaveFeed'))
        }
        setSubscribing(false)
        return
      }

      // Reset form
      setFeedUrl('')
      setPreview(null)
      onSubscribed()
    } catch {
      setError(t('errorUnexpected'))
    } finally {
      setSubscribing(false)
    }
  }

  function handleCancel() {
    setPreview(null)
    setError(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t('addPodcastTitle')}</CardTitle>
        <CardDescription className="text-base">
          {t('addPodcastDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* URL Input */}
        <form onSubmit={handleValidate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="feed-url" className="text-sm font-medium">
              {t('feedUrlLabel')}
            </Label>
            <div className="flex gap-3">
              <Input
                id="feed-url"
                type="url"
                placeholder={t('feedUrlPlaceholder')}
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                required
                disabled={loading || !!preview}
                className="h-11 flex-1"
              />
              {!preview && (
                <Button type="submit" disabled={loading || !feedUrl.trim()} className="h-11">
                  {loading ? t('validateButtonLoading') : t('validateButton')}
                </Button>
              )}
            </div>
          </div>
        </form>

        {/* Error */}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Podcast Preview */}
        {preview && (
          <div className="border rounded-lg p-6 space-y-4">
            <div className="flex gap-4 items-start">
              {preview.coverImageUrl ? (
                <Image
                  src={preview.coverImageUrl}
                  alt={preview.title}
                  width={96}
                  height={96}
                  className="rounded-lg object-cover shrink-0"
                />
              ) : (
                <div className="w-24 h-24 rounded-lg bg-muted flex items-center justify-center text-3xl shrink-0">
                  🎙️
                </div>
              )}
              <div className="space-y-2 min-w-0">
                <h3 className="text-lg font-semibold">{preview.title}</h3>
                {preview.description && (
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {preview.description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleSubscribe} disabled={subscribing}>
                {subscribing ? t('subscribeButtonLoading') : t('subscribeButton')}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={subscribing}>
                {t('cancelButton')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Podcast Card ────────────────────────────────────────────────────

function PodcastCard({
  podcast,
  onDelete,
}: {
  podcast: PodcastSubscription
  onDelete: (podcast: PodcastSubscription) => void
}) {
  return (
    <div className="flex items-center gap-4 py-4">
      {podcast.cover_image_url ? (
        <Image
          src={podcast.cover_image_url}
          alt={podcast.title}
          width={80}
          height={80}
          className="rounded-lg object-cover shrink-0"
        />
      ) : (
        <div className="w-20 h-20 rounded-lg bg-muted flex items-center justify-center text-2xl shrink-0">
          🎙️
        </div>
      )}
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-base">{podcast.title}</h3>
        {podcast.description && (
          <p className="text-sm text-muted-foreground truncate">
            {podcast.description.length > 100
              ? podcast.description.slice(0, 100) + '...'
              : podcast.description}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(podcast)}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-5 w-5" />
      </Button>
    </div>
  )
}

// ─── Delete Dialog ───────────────────────────────────────────────────

function DeletePodcastDialog({
  podcast,
  open,
  onOpenChange,
  onConfirm,
}: {
  podcast: PodcastSubscription | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const t = useTranslations('subscriptions')

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteDescription', { title: podcast?.title ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('deleteCancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t('deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ─── Subscriptions Page ──────────────────────────────────────────────

export default function SubscriptionsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('subscriptions')

  const [podcasts, setPodcasts] = useState<PodcastSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<PodcastSubscription | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const loadPodcasts = useCallback(async () => {
    if (!user) return

    const { data, error } = await supabase
      .from('podcast_subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setPodcasts(data)
    }
    setLoading(false)
  }, [user, supabase])

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      loadPodcasts()
    }
  }, [user, loadPodcasts])

  // Auto-hide success messages
  useEffect(() => {
    if (!successMessage) return
    const timer = setTimeout(() => setSuccessMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [successMessage])

  function handleSubscribed() {
    setSuccessMessage(t('successSubscribed'))
    loadPodcasts()
  }

  function handleDeleteClick(podcast: PodcastSubscription) {
    setDeleteTarget(podcast)
    setDeleteDialogOpen(true)
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return

    const { error } = await supabase
      .from('podcast_subscriptions')
      .delete()
      .eq('id', deleteTarget.id)

    if (!error) {
      setSuccessMessage(t('successRemoved'))
      setPodcasts((prev) => prev.filter((p) => p.id !== deleteTarget.id))
    }

    setDeleteDialogOpen(false)
    setDeleteTarget(null)
  }

  if (authLoading || (loading && user)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!user) return null

  return (
    <div className="min-h-screen section-spacing">
      <div className="max-w-3xl mx-auto container-spacing">
        {/* Header */}
        <div className="mb-12">
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

        {/* Success Message */}
        {successMessage && (
          <Alert className="mb-6 border-accent bg-accent/10">
            <AlertDescription className="text-accent-foreground">
              ✓ {successMessage}
            </AlertDescription>
          </Alert>
        )}

        {/* Add Podcast Form */}
        <div className="mb-12">
          <AddPodcastForm onSubscribed={handleSubscribed} />
        </div>

        {/* Podcast List */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t('myPodcastsTitle')}</CardTitle>
            <CardDescription className="text-base">
              {podcasts.length === 0
                ? t('noPodcasts')
                : t(podcasts.length === 1 ? 'podcastCount_one' : 'podcastCount_other', { count: podcasts.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {podcasts.length === 0 ? (
              <div className="py-12 text-center">
                <div className="text-5xl mb-4">🎧</div>
                <p className="text-muted-foreground text-lg mb-2">
                  {t('emptyStateTitle')}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('emptyStateHint')}
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {podcasts.map((podcast) => (
                  <PodcastCard
                    key={podcast.id}
                    podcast={podcast}
                    onDelete={handleDeleteClick}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeletePodcastDialog
        podcast={deleteTarget}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
