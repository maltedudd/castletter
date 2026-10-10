'use client'

import { useId, useReducer, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AtSign, Globe, Podcast, Youtube } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import {
  SOURCE_TYPES,
  addSourceReducer,
  initialAddSourceState,
  resolveSourcePreview,
  saveSource,
  type SourcePreview,
} from '@/lib/sources/sources.mjs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { SourceType } from '@/types/database'
import { SourceImage } from './SourceImage'

/** Type-specific texts and input attributes; everything else of the flow is shared. */
const TYPE_FIELDS: Record<SourceType, {
  icon: typeof Podcast
  optionLabel: string
  optionHint: string
  inputDescription: string
  inputLabel: string
  inputPlaceholder: string
  inputType: 'url' | 'text'
  checkButton: string
  addButton: string
}> = {
  podcast: {
    icon: Podcast,
    optionLabel: 'sourceTypePodcastLabel',
    optionHint: 'sourceTypePodcastHint',
    inputDescription: 'podcastInputDescription',
    inputLabel: 'feedUrlLabel',
    inputPlaceholder: 'feedUrlPlaceholder',
    inputType: 'url',
    checkButton: 'validateButton',
    addButton: 'podcastAddButton',
  },
  youtube: {
    icon: Youtube,
    optionLabel: 'sourceTypeYoutubeLabel',
    optionHint: 'sourceTypeYoutubeHint',
    inputDescription: 'youtubeInputDescription',
    inputLabel: 'youtubeInputLabel',
    inputPlaceholder: 'youtubeInputPlaceholder',
    inputType: 'text',
    checkButton: 'youtubeResolveButton',
    addButton: 'youtubeAddButton',
  },
  website: {
    icon: Globe,
    optionLabel: 'sourceTypeWebsiteLabel',
    optionHint: 'sourceTypeWebsiteHint',
    inputDescription: 'websiteInputDescription',
    inputLabel: 'websiteInputLabel',
    inputPlaceholder: 'websiteInputPlaceholder',
    inputType: 'text',
    checkButton: 'validateButton',
    addButton: 'websiteAddButton',
  },
  social: {
    icon: AtSign,
    optionLabel: 'sourceTypeSocialLabel',
    optionHint: 'sourceTypeSocialHint',
    inputDescription: 'socialInputDescription',
    inputLabel: 'socialInputLabel',
    inputPlaceholder: 'socialInputPlaceholder',
    inputType: 'text',
    checkButton: 'socialResolveButton',
    addButton: 'socialAddButton',
  },
}

const SUGGEST_TYPE_BUTTON: Record<SourceType, string> = {
  podcast: 'suggestPodcastButton',
  youtube: 'suggestYoutubeButton',
  website: 'suggestWebsiteButton',
  social: 'suggestSocialButton',
}

const CONTENT_MODE_KEYS = {
  full_text: 'websiteContentModeFullText',
  excerpt: 'websiteContentModeExcerpt',
  empty: 'websiteContentModeEmpty',
} as const

/** Single entry point for new sources: choose the type, then only that type's fields. */
export function AddSourceForm({ onAdded }: { onAdded: (preview: SourcePreview) => void }) {
  const { user } = useAuth()
  const supabase = createClient()
  const t = useTranslations('subscriptions')
  const idPrefix = useId()

  const [state, dispatch] = useReducer(addSourceReducer, initialAddSourceState)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const { type, input, preview, error, suggestedType } = state
  const fields = type ? TYPE_FIELDS[type] : null
  const legendId = `${idPrefix}-type-legend`
  const inputId = `${idPrefix}-input`
  const inputHintId = `${idPrefix}-input-hint`
  const errorId = `${idPrefix}-error`

  async function handleCheck(e: React.FormEvent) {
    e.preventDefault()
    if (!type) return
    dispatch({ type: 'setError', error: null })
    setChecking(true)
    const result = await resolveSourcePreview({ type, input })
    setChecking(false)
    if (result.ok) {
      dispatch({ type: 'setPreview', preview: result.preview })
    } else {
      dispatch({ type: 'setError', error: result.error ?? t(result.errorKey ?? 'errorUnexpected'), suggestedType: result.suggestedType ?? null })
    }
  }

  async function handleAdd() {
    if (!preview || !user) return
    dispatch({ type: 'setError', error: null })
    setSaving(true)
    const result = await saveSource({ supabase, userId: user.id, preview })
    setSaving(false)
    if (!result.ok) {
      dispatch({ type: 'setError', error: t(result.errorKey) })
      return
    }
    dispatch({ type: 'reset' })
    onAdded(preview)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t('addSourceTitle')}</CardTitle>
        <CardDescription className="text-base">{t('addSourceDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <p id={legendId} className="text-sm font-medium">{t('sourceTypeLegend')}</p>
          <RadioGroup
            aria-labelledby={legendId}
            value={type ?? ''}
            onValueChange={(value) => dispatch({ type: 'selectType', sourceType: value })}
            disabled={checking || saving}
            className="grid gap-3 sm:grid-cols-2"
          >
            {SOURCE_TYPES.map((sourceType) => {
              const option = TYPE_FIELDS[sourceType]
              const Icon = option.icon
              const optionId = `${idPrefix}-type-${sourceType}`
              const labelId = `${optionId}-label`
              const hintId = `${optionId}-hint`
              return (
                <Label
                  key={sourceType}
                  htmlFor={optionId}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 font-normal transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem
                    id={optionId}
                    value={sourceType}
                    aria-labelledby={labelId}
                    aria-describedby={hintId}
                    className="mt-1"
                  />
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="space-y-1">
                    <span id={labelId} className="block font-medium">{t(option.optionLabel)}</span>
                    <span id={hintId} className="block text-sm text-muted-foreground">{t(option.optionHint)}</span>
                  </span>
                </Label>
              )
            })}
          </RadioGroup>
        </div>

        {type && fields && (
          <form onSubmit={handleCheck} className="space-y-2">
            <Label htmlFor={inputId} className="text-sm font-medium">
              {t(fields.inputLabel)}
            </Label>
            <p id={inputHintId} className="text-sm text-muted-foreground">{t(fields.inputDescription)}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                key={type}
                id={inputId}
                type={fields.inputType}
                placeholder={t(fields.inputPlaceholder)}
                value={input}
                onChange={(e) => dispatch({ type: 'setInput', input: e.target.value })}
                required
                disabled={checking || !!preview}
                aria-describedby={error ? `${inputHintId} ${errorId}` : inputHintId}
                aria-invalid={error ? true : undefined}
                className="h-11 flex-1"
              />
              {!preview && (
                <Button type="submit" disabled={checking || !input.trim()} className="h-11">
                  {checking ? t('validateButtonLoading') : t(fields.checkButton)}
                </Button>
              )}
            </div>
          </form>
        )}

        {error && (
          <Alert variant="destructive" id={errorId}>
            <AlertDescription className="space-y-3">
              <p>{error}</p>
              {suggestedType && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    dispatch({ type: 'switchType', sourceType: suggestedType })
                    // The button disappears with the error; continue in the (re-mounted) input.
                    requestAnimationFrame(() => document.getElementById(inputId)?.focus())
                  }}
                >
                  {t(SUGGEST_TYPE_BUTTON[suggestedType])}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {preview && fields && (
          <section aria-label={t('previewLabel')} className="border rounded-lg p-6 space-y-4">
            <div className="flex gap-4 items-start">
              <SourceImage type={preview.type} title={preview.title} url={preview.imageUrl} size={96} />
              <div className="space-y-2 min-w-0">
                <h3 className="text-lg font-semibold">{preview.title}</h3>
                {preview.channelId && (
                  <p className="text-xs text-muted-foreground font-mono">{preview.channelId}</p>
                )}
                {preview.description && (
                  <p className="text-sm text-muted-foreground line-clamp-3">{preview.description}</p>
                )}
                {preview.type === 'website' && preview.feedFormat && preview.contentMode && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t('websiteFeedFormatLabel')}</dt>
                    <dd>{preview.feedFormat === 'atom' ? 'Atom' : 'RSS'}</dd>
                    <dt className="text-muted-foreground">{t('websiteContentModeLabel')}</dt>
                    <dd>{t(CONTENT_MODE_KEYS[preview.contentMode])}</dd>
                  </dl>
                )}
                {preview.type === 'social' && preview.socialHandle && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t('socialHandleLabel')}</dt>
                    <dd className="font-mono break-all">@{preview.socialHandle}</dd>
                    <dt className="text-muted-foreground">{t('socialAccessLabel')}</dt>
                    <dd>{t(preview.socialAccountId ? 'socialAccessApi' : 'socialAccessRss')}</dd>
                  </dl>
                )}
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleAdd} disabled={saving}>
                {saving ? t('addButtonLoading') : t(fields.addButton)}
              </Button>
              <Button variant="outline" onClick={() => dispatch({ type: 'cancelPreview' })} disabled={saving}>
                {t('cancelButton')}
              </Button>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  )
}
