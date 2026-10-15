'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MAX_CATEGORY_NAME_LENGTH, normalizeCategoryName, validateCategoryName } from '@/lib/sources/categories.mjs'
import type { SourceCategory } from '@/types/database'

export type CategoryNameError = 'empty' | 'tooLong' | 'duplicate' | 'save'
type Direction = 'up' | 'down'

const NAME_ERROR_KEYS: Record<CategoryNameError, string> = {
  empty: 'categoryErrorEmpty',
  tooLong: 'categoryErrorTooLong',
  duplicate: 'categoryErrorDuplicate',
  save: 'categoryErrorSave',
}

/** Name input with its validation message (shared by "new category" and "rename"). */
function useNameField(categories: SourceCategory[], excludeId: string | null = null) {
  const [name, setName] = useState('')
  const [error, setError] = useState<CategoryNameError | null>(null)

  /** The normalised name, or null after showing why it is invalid. */
  function validName() {
    const invalid = validateCategoryName(name, categories, excludeId)
    setError(invalid)
    return invalid ? null : normalizeCategoryName(name)
  }

  return { name, setName, error, setError, validName }
}

function NameError({ id, error }: { id: string; error: CategoryNameError | null }) {
  const t = useTranslations('subscriptions')
  if (!error) return null
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {t(NAME_ERROR_KEYS[error], { max: MAX_CATEGORY_NAME_LENGTH })}
    </p>
  )
}

// ─── One category ────────────────────────────────────────────────────

function CategoryRow({
  category,
  index,
  count,
  sourceCount,
  categories,
  focusDirection,
  onFocused,
  onRename,
  onMove,
  onDelete,
}: {
  category: SourceCategory
  index: number
  count: number
  sourceCount: number
  categories: SourceCategory[]
  focusDirection: Direction | null
  onFocused: () => void
  onRename: (category: SourceCategory, name: string) => Promise<CategoryNameError | null>
  onMove: (category: SourceCategory, direction: Direction) => void
  onDelete: (category: SourceCategory) => void
}) {
  const t = useTranslations('subscriptions')
  const [editing, setEditing] = useState(false)
  const field = useNameField(categories, category.id)
  const upRef = useRef<HTMLButtonElement>(null)
  const downRef = useRef<HTMLButtonElement>(null)
  const errorId = `category-rename-error-${category.id}`
  const isFirst = index === 0
  const isLast = index === count - 1

  // After a move the focus stays with the moved category: on the same arrow, or the other one
  // once it reached the edge.
  useEffect(() => {
    if (!focusDirection) return
    const same = focusDirection === 'up' ? upRef.current : downRef.current
    const other = focusDirection === 'up' ? downRef.current : upRef.current
    ;(same && !same.disabled ? same : other)?.focus()
    onFocused()
  }, [focusDirection, onFocused])

  function startEditing() {
    field.setName(category.name)
    field.setError(null)
    setEditing(true)
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    const name = field.validName()
    if (name === null) return
    if (name === category.name) {
      setEditing(false)
      return
    }
    const error = await onRename(category, name)
    field.setError(error)
    if (!error) setEditing(false)
  }

  return (
    <li className="py-3 space-y-2">
      {editing ? (
        <form onSubmit={saveName} className="flex flex-wrap gap-2" noValidate>
          <Input
            aria-label={t('categoryRenameLabel', { name: category.name })}
            aria-invalid={field.error ? true : undefined}
            aria-describedby={field.error ? errorId : undefined}
            value={field.name}
            onChange={(e) => field.setName(e.target.value)}
            maxLength={MAX_CATEGORY_NAME_LENGTH}
            className="h-9 flex-1 min-w-[12rem]"
            autoFocus
          />
          <Button type="submit" size="sm">{t('saveButton')}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
            {t('cancelButton')}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="w-6 shrink-0 text-right text-sm text-muted-foreground" aria-hidden="true">{index + 1}.</span>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{category.name}</p>
            <p className="text-xs text-muted-foreground">{t('categorySourceCount', { count: sourceCount })}</p>
          </div>
          <Button
            ref={upRef}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={isFirst}
            onClick={() => onMove(category, 'up')}
            aria-label={t('categoryMoveUp', { name: category.name })}
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            ref={downRef}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            disabled={isLast}
            onClick={() => onMove(category, 'down')}
            aria-label={t('categoryMoveDown', { name: category.name })}
          >
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={startEditing}
            aria-label={t('categoryRename', { name: category.name })}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(category)}
            aria-label={t('categoryDelete', { name: category.name })}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
      <NameError id={errorId} error={editing ? field.error : null} />
    </li>
  )
}

// ─── Category list ───────────────────────────────────────────────────

/**
 * Kanban #48: the user's categories in their order – create, rename, move up/down, delete.
 * The order is the order of the daily digest; deleting a category keeps its sources.
 */
export function CategoryManager({
  categories,
  sourceCounts,
  onCreate,
  onRename,
  onMove,
  onDelete,
}: {
  /** In the user's order */
  categories: SourceCategory[]
  /** Number of sources per category id */
  sourceCounts: Map<string, number>
  onCreate: (name: string) => Promise<CategoryNameError | null>
  onRename: (category: SourceCategory, name: string) => Promise<CategoryNameError | null>
  onMove: (category: SourceCategory, direction: Direction) => Promise<void>
  onDelete: (category: SourceCategory) => Promise<void>
}) {
  const t = useTranslations('subscriptions')
  const field = useNameField(categories)
  const [saving, setSaving] = useState(false)
  const [moved, setMoved] = useState<{ id: string; direction: Direction } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SourceCategory | null>(null)
  const inputId = 'new-category-name'
  const errorId = 'new-category-error'

  async function create(e: React.FormEvent) {
    e.preventDefault()
    const name = field.validName()
    if (name === null) return
    setSaving(true)
    const error = await onCreate(name)
    setSaving(false)
    field.setError(error)
    if (!error) field.setName('')
  }

  async function move(category: SourceCategory, direction: Direction) {
    setMoved({ id: category.id, direction })
    await onMove(category, direction)
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    await onDelete(deleteTarget)
    setDeleteTarget(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t('categoriesTitle')}</CardTitle>
        <CardDescription className="text-base">{t('categoriesDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={create} className="space-y-2" noValidate>
          <Label htmlFor={inputId}>{t('categoryNameLabel')}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={inputId}
              value={field.name}
              onChange={(e) => field.setName(e.target.value)}
              placeholder={t('categoryNamePlaceholder')}
              maxLength={MAX_CATEGORY_NAME_LENGTH}
              aria-invalid={field.error ? true : undefined}
              aria-describedby={field.error ? errorId : undefined}
              className="h-10 flex-1 min-w-[12rem]"
            />
            <Button type="submit" disabled={saving}>{t('categoryAddButton')}</Button>
          </div>
          <NameError id={errorId} error={field.error} />
        </form>

        {categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('categoriesEmpty')}</p>
        ) : (
          <ol className="divide-y" aria-label={t('categoriesListLabel')}>
            {categories.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                index={index}
                count={categories.length}
                sourceCount={sourceCounts.get(category.id) ?? 0}
                categories={categories}
                focusDirection={moved?.id === category.id ? moved.direction : null}
                onFocused={() => setMoved(null)}
                onRename={onRename}
                onMove={move}
                onDelete={setDeleteTarget}
              />
            ))}
          </ol>
        )}
      </CardContent>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('categoryDeleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('categoryDeleteDescription', {
                name: deleteTarget?.name ?? '',
                count: deleteTarget ? sourceCounts.get(deleteTarget.id) ?? 0 : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('deleteCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('categoryDeleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
