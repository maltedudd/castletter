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
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { SourceType } from '@/types/database'
import { SourceImage } from './SourceImage'

/** Type-specific texts and input attributes; everything else of the flow is shared. */
const TYPE_FIELDS: Record<SourceType, {
  icon: typeof Podcast
  chipLabel: string
  addHint: string
  addPlaceholder: string
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
    chipLabel: 'typeBadgePodcast',
    addHint: 'addHintPodcast',
    addPlaceholder: 'addPlaceholderPodcast',
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
    chipLabel: 'typeBadgeYoutube',
    addHint: 'addHintYoutube',
    addPlaceholder: 'addPlaceholderYoutube',
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
    chipLabel: 'typeBadgeWebsite',
    addHint: 'addHintWebsite',
    addPlaceholder: 'addPlaceholderWebsite',
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
    chipLabel: 'typeChipSocial',
    addHint: 'addHintSocial',
    addPlaceholder: 'addPlaceholderSocial',
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

  // The prototype starts with "Podcast" selected.
  const [state, dispatch] = useReducer(addSourceReducer, initialAddSourceState, (initial) =>
    addSourceReducer(initial, { type: 'selectType', sourceType: 'podcast' }))
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
    <section aria-labelledby={legendId} className="flex flex-col gap-4 rounded-2xl border border-castle-line bg-white p-[22px]">
      <h2 id={legendId} className="m-0 text-[15px] font-semibold">{t('addSourceTitle')}</h2>
      <div role="radiogroup" aria-label={t('sourceTypeLegend')} className="flex flex-wrap gap-2">
        {SOURCE_TYPES.map((sourceType) => {
          const selected = type === sourceType
          return (
            <button
              key={sourceType}
              type="button"
              role="radio"
              aria-checked={selected}
              title={t(TYPE_FIELDS[sourceType].optionHint)}
              disabled={checking || saving}
              onClick={() => dispatch({ type: 'selectType', sourceType })}
              className={`rounded-lg border px-3.5 py-2 text-[13.5px] font-medium ${
                selected ? 'border-castle-ink bg-castle-ink text-white' : 'border-castle-input bg-white text-castle-ink hover:border-castle-ink'
              }`}
            >
              {t(TYPE_FIELDS[sourceType].chipLabel)}
            </button>
          )
        })}
      </div>

      {type && fields && (
        <form onSubmit={handleCheck} className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-2.5">
            <input
              key={type}
              id={inputId}
              type={fields.inputType}
              aria-label={t(fields.inputLabel)}
              placeholder={t(fields.addPlaceholder)}
              value={input}
              onChange={(e) => dispatch({ type: 'setInput', input: e.target.value })}
              required
              disabled={checking || !!preview}
              aria-describedby={error ? `${inputHintId} ${errorId}` : inputHintId}
              aria-invalid={error ? true : undefined}
              className="min-w-[240px] flex-1 rounded-[9px] border border-castle-input bg-castle-row px-3.5 py-3 font-mono text-[13.5px] text-castle-ink outline-none focus:border-castle-ink focus:bg-white disabled:opacity-60"
            />
            {!preview && (
              <button
                type="submit"
                disabled={checking || !input.trim()}
                className="rounded-[9px] bg-castle-ink px-[18px] py-3 text-sm font-medium text-white hover:bg-castle-ink-hover disabled:opacity-60"
              >
                {checking ? t('validateButtonLoading') : t(fields.checkButton)}
              </button>
            )}
          </div>
          <p id={inputHintId} className="m-0 text-[13px] text-castle-subtle">
            {t(fields.addHint)} <span className="sr-only">{t(fields.inputDescription)}</span>
          </p>
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
        <section aria-label={t('previewLabel')} className="space-y-4 rounded-xl border border-castle-line p-5">
          <div className="flex items-start gap-4">
            <SourceImage type={preview.type} title={preview.title} url={preview.imageUrl} size={72} />
            <div className="min-w-0 space-y-2">
              <h3 className="m-0 text-lg font-semibold">{preview.title}</h3>
              {preview.channelId && (
                <p className="font-mono text-xs text-castle-faint">{preview.channelId}</p>
              )}
              {preview.description && (
                <p className="line-clamp-3 text-sm text-castle-muted">{preview.description}</p>
              )}
              {preview.type === 'website' && preview.feedFormat && preview.contentMode && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-castle-muted">{t('websiteFeedFormatLabel')}</dt>
                  <dd>{preview.feedFormat === 'atom' ? 'Atom' : 'RSS'}</dd>
                  <dt className="text-castle-muted">{t('websiteContentModeLabel')}</dt>
                  <dd>{t(CONTENT_MODE_KEYS[preview.contentMode])}</dd>
                </dl>
              )}
              {preview.type === 'social' && preview.socialHandle && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-castle-muted">{t('socialPlatformLabel')}</dt>
                  <dd>{preview.socialPlatform === 'bluesky' ? 'Bluesky' : 'Mastodon'}</dd>
                  <dt className="text-castle-muted">{t('socialHandleLabel')}</dt>
                  <dd className="break-all font-mono">@{preview.socialHandle}</dd>
                  <dt className="text-castle-muted">{t('socialAccessLabel')}</dt>
                  <dd>{t(preview.socialPlatform === 'bluesky' ? 'socialAccessBluesky' : preview.socialAccountId ? 'socialAccessApi' : 'socialAccessRss')}</dd>
                </dl>
              )}
            </div>
          </div>
          <div className="flex gap-3">
            <Button onClick={handleAdd} disabled={saving}>
              {saving ? t('addButtonLoading') : t(fields.addButton)}
            </Button>
            <Button variant="outline" onClick={() => dispatch({ type: 'cancelPreview' })} disabled={saving}>
              {t('cancelButton')}
            </Button>
          </div>
        </section>
      )}
    </section>
  )
}
