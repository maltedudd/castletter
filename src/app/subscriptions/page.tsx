'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import type { PodcastSubscription, SourceType } from '@/types/database'
import { AddSourceForm } from './AddSourceForm'
import { SourceList, type SourcePatch } from './SourceList'

// ─── Delete Dialog ───────────────────────────────────────────────────

const DELETE_DESCRIPTION_KEYS: Record<SourceType, string> = {
  podcast: 'deleteDescriptionPodcast',
  youtube: 'deleteDescriptionYoutube',
  website: 'deleteDescriptionWebsite',
  social: 'deleteDescriptionSocial',
}

function DeleteSourceDialog({
  source,
  open,
  onOpenChange,
  onConfirm,
}: {
  source: PodcastSubscription | null
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
            {t(DELETE_DESCRIPTION_KEYS[source?.source_type ?? 'podcast'] ?? 'deleteDescriptionPodcast', { title: source?.title ?? '' })}
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

// ─── Sources Page ────────────────────────────────────────────────────

/** Podcasts, YouTube channels, websites and Mastodon accounts as sources; stored in podcast_subscriptions (table name kept). */
export default function SubscriptionsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('subscriptions')

  const [sources, setSources] = useState<PodcastSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<PodcastSubscription | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const loadSources = useCallback(async () => {
    if (!user) return

    const { data, error } = await supabase
      .from('podcast_subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setSources(data as PodcastSubscription[])
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
      loadSources()
    }
  }, [user, loadSources])

  // Auto-hide success messages
  useEffect(() => {
    if (!successMessage) return
    const timer = setTimeout(() => setSuccessMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [successMessage])

  function handleAdded({ title }: { title: string }) {
    setErrorMessage(null)
    setSuccessMessage(t('successAdded', { title }))
    loadSources()
  }

  async function handleUpdate(source: PodcastSubscription, patch: SourcePatch) {
    setErrorMessage(null)
    // Optimistic update; reverted if saving fails.
    setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, ...patch } : s)))

    const { error } = await supabase
      .from('podcast_subscriptions')
      .update(patch)
      .eq('id', source.id)

    if (error) {
      setSources((prev) => prev.map((s) => (s.id === source.id ? source : s)))
      setErrorMessage(t(patch.delivery_mode ? 'errorSaveDeliveryMode' : 'errorSave'))
      return false
    }

    const title = patch.title ?? source.title
    if (patch.delivery_mode) {
      setSuccessMessage(t(patch.delivery_mode === 'immediate' ? 'successDeliveryImmediate' : 'successDeliveryDaily', { title }))
    } else if (patch.enabled !== undefined) {
      setSuccessMessage(t(patch.enabled ? 'successEnabled' : 'successDisabled', { title }))
    } else {
      setSuccessMessage(t('saved', { title }))
    }
    return true
  }

  function handleDeleteClick(source: PodcastSubscription) {
    setDeleteTarget(source)
    setDeleteDialogOpen(true)
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return

    const { error } = await supabase
      .from('podcast_subscriptions')
      .delete()
      .eq('id', deleteTarget.id)

    if (error) {
      setErrorMessage(t('errorDelete'))
    } else {
      setSuccessMessage(t('successRemoved', { title: deleteTarget.title }))
      setSources((prev) => prev.filter((s) => s.id !== deleteTarget.id))
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
        <div aria-live="polite">
          {successMessage && (
            <Alert role="status" className="mb-6 border-accent bg-accent/10">
              <AlertDescription className="text-accent-foreground">
                ✓ {successMessage}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Error Message */}
        {errorMessage && (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Single entry point for every source type */}
        <div className="mb-12">
          <AddSourceForm onAdded={handleAdded} />
        </div>

        {/* All sources */}
        <SourceList sources={sources} onUpdate={handleUpdate} onDelete={handleDeleteClick} />
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteSourceDialog
        source={deleteTarget}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
