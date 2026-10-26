'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { deliveryTargetsOf } from '@/lib/newsletter/delivery-targets.mjs'
import { moveCategory, sortCategories } from '@/lib/sources/categories.mjs'
import { lastCheckedOf } from '@/lib/ui/source-groups.mjs'
import { AppPage, PageHeading, PageSpinner } from '@/components/app/AppPage'
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
import type { PodcastSubscription, SourceCategory, SourceType } from '@/types/database'
import { AddSourceForm } from './AddSourceForm'
import { CategoryManager, type CategoryNameError } from './CategoryManager'
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

/** Podcasts, YouTube channels, websites and Mastodon/Bluesky accounts as sources; stored in podcast_subscriptions (table name kept). */
export default function SubscriptionsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('subscriptions')
  const locale = useLocale()

  const [sources, setSources] = useState<PodcastSubscription[]>([])
  const [categories, setCategories] = useState<SourceCategory[]>([])
  // Reorders are sent one after another, so quick repeated moves reach the database in order.
  const reorderQueue = useRef<Promise<unknown>>(Promise.resolve())
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

  // Kanban #48: the user's own categories (RLS: own rows only).
  const loadCategories = useCallback(async () => {
    if (!user) return
    const { data, error } = await supabase
      .from('source_categories')
      .select('*')
      .eq('user_id', user.id)
    if (error) {
      setErrorMessage(t('categoryErrorLoad'))
      return
    }
    setCategories(sortCategories((data ?? []) as SourceCategory[]))
  }, [user, supabase, t])

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const source of sources) {
      if (source.category_id) counts.set(source.category_id, (counts.get(source.category_id) ?? 0) + 1)
    }
    return counts
  }, [sources])

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  useEffect(() => {
    if (user) {
      loadSources()
      loadCategories()
    }
  }, [user, loadSources, loadCategories])

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
    const isDeliveryPatch = patch.deliver_immediately !== undefined || patch.deliver_daily !== undefined
    const isCategoryPatch = patch.category_id !== undefined
    // Optimistic update; reverted if saving fails.
    setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, ...patch } : s)))

    const { error } = await supabase
      .from('podcast_subscriptions')
      .update(patch)
      .eq('id', source.id)

    if (error) {
      setSources((prev) => prev.map((s) => (s.id === source.id ? source : s)))
      setErrorMessage(t(isDeliveryPatch ? 'errorSaveDeliveryMode' : isCategoryPatch ? 'errorSaveCategory' : 'errorSave'))
      return false
    }

    const title = patch.title ?? source.title
    if (isCategoryPatch) {
      const category = categories.find((c) => c.id === patch.category_id)
      setSuccessMessage(category
        ? t('successCategoryAssigned', { title, category: category.name })
        : t('successCategoryRemoved', { title }))
    } else if (isDeliveryPatch) {
      const { immediate, daily } = deliveryTargetsOf({ ...source, ...patch })
      const key = immediate && daily ? 'successDeliveryBoth' : immediate ? 'successDeliveryImmediate' : 'successDeliveryDaily'
      setSuccessMessage(t(key, { title }))
    } else if (patch.enabled !== undefined) {
      setSuccessMessage(t(patch.enabled ? 'successEnabled' : 'successDisabled', { title }))
    } else {
      setSuccessMessage(t('saved', { title }))
    }
    return true
  }

  // ─── Kanban #48: categories ──────────────────────────────────────

  /** Unique violations (another tab, other casing) are shown as "name taken". */
  function categoryError(error: { code?: string }): CategoryNameError {
    return error.code === '23505' ? 'duplicate' : 'save'
  }

  async function handleCreateCategory(name: string): Promise<CategoryNameError | null> {
    if (!user) return 'save'
    setErrorMessage(null)
    // The position is set by the database: a new category goes last.
    const { data, error } = await supabase
      .from('source_categories')
      .insert({ user_id: user.id, name })
      .select('*')
      .single()
    if (error || !data) return error ? categoryError(error) : 'save'
    setCategories((prev) => sortCategories([...prev, data as SourceCategory]))
    setSuccessMessage(t('categoryCreated', { name }))
    return null
  }

  async function handleRenameCategory(category: SourceCategory, name: string): Promise<CategoryNameError | null> {
    setErrorMessage(null)
    const { error } = await supabase
      .from('source_categories')
      .update({ name })
      .eq('id', category.id)
    if (error) return categoryError(error)
    setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, name } : c)))
    setSuccessMessage(t('categoryRenamed', { name }))
    return null
  }

  async function handleMoveCategory(category: SourceCategory, direction: 'up' | 'down') {
    const order = moveCategory(categories, category.id, direction)
    if (!order) return
    setErrorMessage(null)
    const previous = categories
    // Optimistic: the new order is shown at once and saved in one transaction.
    const byId = new Map(categories.map((c) => [c.id, c]))
    setCategories(order.flatMap((id, position) => {
      const moved = byId.get(id)
      return moved ? [{ ...moved, position }] : []
    }))
    const request = reorderQueue.current.then(() => supabase.rpc('reorder_source_categories', { category_ids: order }))
    reorderQueue.current = request.catch(() => undefined)
    const { error } = await request
    if (error) {
      setCategories(previous)
      setErrorMessage(t('categoryErrorMove'))
      loadCategories()
      return
    }
    setSuccessMessage(t('categoryMoved', { name: category.name, position: order.indexOf(category.id) + 1, count: order.length }))
  }

  async function handleDeleteCategory(category: SourceCategory) {
    setErrorMessage(null)
    const { error } = await supabase
      .from('source_categories')
      .delete()
      .eq('id', category.id)
    if (error) {
      setErrorMessage(t('categoryErrorDelete'))
      return
    }
    // The database only clears category_id of its sources (ON DELETE SET NULL); they stay.
    setCategories((prev) => prev.filter((c) => c.id !== category.id))
    setSources((prev) => prev.map((s) => (s.category_id === category.id ? { ...s, category_id: null } : s)))
    setSuccessMessage(t('categoryDeleted', { name: category.name }))
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

  if (authLoading || (loading && user)) return <PageSpinner />

  if (!user) return null

  const lastChecked = lastCheckedOf(sources)
  const lastCheckedText = lastChecked
    ? new Date(lastChecked).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null
  const summary = sources.length === 0
    ? t('description')
    : [
        t('summarySources', { count: sources.length, categories: categories.length }),
        lastCheckedText ? t('summaryLastChecked', { date: lastCheckedText }) : null,
      ].filter(Boolean).join(' ')

  return (
    <AppPage>
      <PageHeading title={t('title')} description={summary} />

      {/* Success Message */}
      <div aria-live="polite">
        {successMessage && (
          <Alert role="status" className="border-castle-control bg-castle-mist">
            <AlertDescription className="text-castle-ink">
              ✓ {successMessage}
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Error Message */}
      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Single entry point for every source type */}
      <AddSourceForm onAdded={handleAdded} />

      {/* All sources, grouped by category in newsletter order */}
      <SourceList
        sources={sources}
        categories={categories}
        onUpdate={handleUpdate}
        onDelete={handleDeleteClick}
        onMoveCategory={handleMoveCategory}
      />

      {/* Own categories: create, rename, reorder, delete */}
      <CategoryManager
        categories={categories}
        sourceCounts={sourceCounts}
        onCreate={handleCreateCategory}
        onRename={handleRenameCategory}
        onMove={handleMoveCategory}
        onDelete={handleDeleteCategory}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteSourceDialog
        source={deleteTarget}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />
    </AppPage>
  )
}
