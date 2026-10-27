'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AppPage, PageHeading, PageSpinner } from '@/components/app/AppPage'
import { localHourToUTC, utcHourToLocal, getHourOptions, getTimezoneName, formatHour } from '@/lib/utils/timezone'
import {
  DEFAULT_SUMMARY_TONE,
  MAX_PROMPT_ADDITION_CHARS,
  SUMMARY_TONES,
  normalizePromptAddition,
  normalizeSummaryTone,
} from '@/lib/newsletter/summary-style.mjs'
import type { SummaryTone } from '@/types/database'

// Translation keys of the tone presets (label, one-line description, sample sentence).
const TONE_TEXTS: Record<SummaryTone, { label: string; description: string; sample: string }> = {
  neutral: { label: 'toneNeutralLabel', description: 'toneNeutralDescription', sample: 'toneNeutralSample' },
  concise: { label: 'toneConciseLabel', description: 'toneConciseDescription', sample: 'toneConciseSample' },
  analytical: { label: 'toneAnalyticalLabel', description: 'toneAnalyticalDescription', sample: 'toneAnalyticalSample' },
  warm: { label: 'toneWarmLabel', description: 'toneWarmDescription', sample: 'toneWarmSample' },
}

// Quick picks of the prototype; every other hour stays reachable through the select.
const QUICK_HOURS = [6, 7, 8, 9, 12, 18]

const chip = (selected: boolean) =>
  selected ? 'border-castle-ink bg-castle-ink text-white' : 'border-castle-input bg-white text-castle-ink hover:border-castle-ink'

function Section({ title, titleId, hint, hintId, children, last = false }: { title: string; titleId?: string; hint: string; hintId?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`grid gap-6 p-6 md:grid-cols-3 ${last ? '' : 'border-b border-castle-line-soft'}`}>
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="m-0 text-[15px] font-semibold">{title}</h2>
        <p id={hintId} className="m-0 text-[13.5px] leading-[1.45] text-castle-subtle">{hint}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3.5 md:col-span-2">{children}</div>
    </div>
  )
}

export default function SettingsPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('settings')

  const [email, setEmail] = useState('')
  const [deliveryHour, setDeliveryHour] = useState(8) // Default: 8:00 AM local time
  const [summaryTone, setSummaryTone] = useState<SummaryTone>(DEFAULT_SUMMARY_TONE as SummaryTone)
  const [promptAddition, setPromptAddition] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const hourOptions = getHourOptions()
  const timezoneName = getTimezoneName()

  // Load existing settings
  useEffect(() => {
    if (!user) return
    const currentUser = user

    async function loadSettings() {
      try {
        const { data, error } = await supabase
          .from('user_settings')
          .select('newsletter_email, newsletter_delivery_hour, summary_tone, summary_prompt_addition')
          .eq('user_id', currentUser.id)
          .single()

        if (error && error.code !== 'PGRST116') {
          // PGRST116 = no rows found (first time user)
          console.error('Error loading settings:', error)
          setError(t('errorLoadSettings'))
        }

        if (data) {
          // Convert UTC hour to local hour for display
          setEmail(data.newsletter_email)
          setDeliveryHour(utcHourToLocal(data.newsletter_delivery_hour))
          setSummaryTone(normalizeSummaryTone(data.summary_tone) as SummaryTone)
          setPromptAddition(normalizePromptAddition(data.summary_prompt_addition) ?? '')
        } else {
          // First time: use login email as default
          setEmail(currentUser.email || '')
        }
      } catch (err) {
        console.error('Error loading settings:', err)
        setError(t('errorUnexpected'))
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
  }, [user, supabase, t])

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setSaving(true)

    if (!user) {
      setError(t('errorUnexpected'))
      setSaving(false)
      return
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError(t('errorInvalidEmail'))
      setSaving(false)
      return
    }

    // maxLength already limits the field; this guards pasted or programmatic values.
    if (promptAddition.length > MAX_PROMPT_ADDITION_CHARS) {
      setError(t('errorPromptAdditionTooLong', { max: MAX_PROMPT_ADDITION_CHARS }))
      setSaving(false)
      return
    }
    const cleanedAddition = normalizePromptAddition(promptAddition)

    try {
      // Convert local hour to UTC before saving
      const utcHour = localHourToUTC(deliveryHour)

      const { error } = await supabase
        .from('user_settings')
        .upsert({
          user_id: user.id,
          newsletter_email: email,
          newsletter_delivery_hour: utcHour,
          summary_tone: normalizeSummaryTone(summaryTone),
          summary_prompt_addition: cleanedAddition,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      if (error) {
        console.error('Error saving settings:', error)
        setError(t('errorSaveSettings'))
        setSaving(false)
        return
      }

      setPromptAddition(cleanedAddition ?? '')
      setSuccess(true)
      setSaving(false)
    } catch (err) {
      console.error('Error saving settings:', err)
      setError(t('errorUnexpected'))
      setSaving(false)
    }
  }

  if (authLoading || loading) return <PageSpinner />

  if (!user) {
    return null
  }

  const otherHour = !QUICK_HOURS.includes(deliveryHour)

  return (
    <AppPage narrow>
      <PageHeading title={t('title')} description={t('description')} />

      <form onSubmit={handleSave} className="rounded-2xl border border-castle-line bg-white" noValidate={false}>
        <Section title={t('deliverySectionTitle')} hint={t('emailHint')}>
          <label htmlFor="newsletter-email" className="flex flex-col gap-1.5 text-[13.5px] font-medium">
            {t('emailLabel')}
            <input
              id="newsletter-email"
              type="email"
              placeholder={t('emailPlaceholder')}
              value={email}
              onChange={(e) => { setEmail(e.target.value); setSuccess(false) }}
              required
              disabled={saving}
              className="rounded-[9px] border border-castle-input px-[13px] py-[11px] text-[14.5px] font-normal text-castle-ink outline-none focus:border-castle-ink disabled:opacity-60"
            />
          </label>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-[13.5px] font-medium">{t('deliveryTimeLabel')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_HOURS.map((hour) => (
                <button
                  key={hour}
                  type="button"
                  aria-pressed={deliveryHour === hour}
                  disabled={saving}
                  onClick={() => { setDeliveryHour(hour); setSuccess(false) }}
                  className={`rounded-lg border px-3 py-2 font-mono text-[13px] ${chip(deliveryHour === hour)}`}
                >
                  {formatHour(hour)}
                </button>
              ))}
              <Select
                value={deliveryHour.toString()}
                onValueChange={(value) => { setDeliveryHour(parseInt(value)); setSuccess(false) }}
                disabled={saving}
              >
                <SelectTrigger aria-label={t('deliveryTimeOtherLabel')} className={`h-[38px] w-auto gap-2 rounded-lg font-mono text-[13px] ${otherHour ? 'border-castle-ink bg-castle-ink text-white' : 'border-castle-input'}`}>
                  {otherHour ? <SelectValue /> : <span className="font-sans">{t('deliveryTimeOther')}</span>}
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value.toString()} className="font-mono">
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="m-0 text-[13px] font-normal text-castle-subtle">{t('timezoneHint', { timezone: timezoneName })}</p>
            <p className="m-0 text-[13px] font-normal text-castle-subtle">
              {t('deliveryModePerPodcastHint')}{' '}
              <Link href="/subscriptions" className="underline underline-offset-2 hover:text-castle-ink">
                {t('deliveryModePerPodcastLink')}
              </Link>
            </p>
          </fieldset>
        </Section>

        <Section title={t('toneLabel')} titleId="summary-tone-label" hint={t('toneSectionHint')}>
          <div role="radiogroup" aria-labelledby="summary-tone-label" className="grid gap-2.5 sm:grid-cols-2">
            {(SUMMARY_TONES as SummaryTone[]).map((tone) => {
              const selected = summaryTone === tone
              return (
                <button
                  key={tone}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-describedby={`summary-tone-${tone}-hint`}
                  disabled={saving}
                  onClick={() => { setSummaryTone(normalizeSummaryTone(tone) as SummaryTone); setSuccess(false) }}
                  className={`flex flex-col gap-2 rounded-[11px] border-[1.5px] p-3.5 text-left text-castle-ink ${selected ? 'border-castle-ink bg-[#F4F7F6]' : 'border-castle-line bg-white hover:border-castle-control'}`}
                >
                  <span className="flex w-full items-center justify-between">
                    <span className="text-[14.5px] font-semibold">{t(TONE_TEXTS[tone].label)}</span>
                    <span
                      aria-hidden="true"
                      className={`h-4 w-4 rounded-full border-[1.5px] shadow-[inset_0_0_0_3px_#FFFFFF] ${selected ? 'border-castle-ink bg-castle-ink' : 'border-castle-control bg-white'}`}
                    />
                  </span>
                  <span className="font-serif text-[15px] leading-[1.4] text-castle-text">{t(TONE_TEXTS[tone].sample)}</span>
                  <span id={`summary-tone-${tone}-hint`} className="sr-only">{t(TONE_TEXTS[tone].description)}</span>
                </button>
              )
            })}
          </div>
        </Section>

        <Section title={t('promptAdditionLabel')} hint={t('promptAdditionHint', { max: MAX_PROMPT_ADDITION_CHARS })} hintId="summary-prompt-addition-hint" last>
          <div className="flex flex-col gap-1.5">
            <textarea
              id="summary-prompt-addition"
              aria-label={t('promptAdditionLabel')}
              value={promptAddition}
              onChange={(e) => { setPromptAddition(e.target.value); setSuccess(false) }}
              maxLength={MAX_PROMPT_ADDITION_CHARS}
              rows={3}
              placeholder={t('promptAdditionPlaceholder')}
              aria-describedby="summary-prompt-addition-hint summary-prompt-addition-counter"
              disabled={saving}
              className="resize-y rounded-[9px] border border-castle-input px-[13px] py-[11px] text-[14.5px] text-castle-ink outline-none focus:border-castle-ink disabled:opacity-60"
            />
            <span id="summary-prompt-addition-counter" aria-live="polite" className="self-end font-mono text-xs tabular-nums text-castle-faint">
              {t('promptAdditionCounter', { count: promptAddition.length, max: MAX_PROMPT_ADDITION_CHARS })}
            </span>
          </div>
        </Section>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-castle-line-soft bg-castle-row px-6 py-4">
          <p className={`m-0 text-[13px] ${error ? 'text-destructive' : 'text-castle-subtle'}`} role={error ? 'alert' : 'status'} aria-live="polite">
            {error ?? (success ? t('successMessage') : t('saveHint'))}
          </p>
          <button
            type="submit"
            disabled={saving}
            className="rounded-[9px] bg-castle-ink px-5 py-[11px] text-sm font-medium text-white hover:bg-castle-ink-hover disabled:opacity-60"
          >
            {saving ? t('saveButtonLoading') : t('saveButton')}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-castle-muted">
        <span>{t('signedInAs', { email: user.email ?? '' })}</span>
        <button
          type="button"
          onClick={signOut}
          className="rounded-lg border border-castle-input bg-white px-3.5 py-2 text-sm text-castle-ink hover:border-castle-ink"
        >
          {t('signOut')}
        </button>
      </div>
    </AppPage>
  )
}
