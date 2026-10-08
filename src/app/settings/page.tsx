'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { localHourToUTC, utcHourToLocal, getHourOptions, getTimezoneName } from '@/lib/utils/timezone'
import {
  DEFAULT_SUMMARY_TONE,
  MAX_PROMPT_ADDITION_CHARS,
  SUMMARY_TONES,
  normalizePromptAddition,
  normalizeSummaryTone,
} from '@/lib/newsletter/summary-style.mjs'
import type { SummaryTone } from '@/types/database'

// Translation keys of the tone presets (label + one-line description).
const TONE_TEXTS: Record<SummaryTone, { label: string; description: string }> = {
  neutral: { label: 'toneNeutralLabel', description: 'toneNeutralDescription' },
  concise: { label: 'toneConciseLabel', description: 'toneConciseDescription' },
  analytical: { label: 'toneAnalyticalLabel', description: 'toneAnalyticalDescription' },
  warm: { label: 'toneWarmLabel', description: 'toneWarmDescription' },
}

export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth()
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

      // Scroll to top to show success message
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      console.error('Error saving settings:', err)
      setError(t('errorUnexpected'))
      setSaving(false)
    }
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!user) {
    return null
  }

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
        {success && (
          <Alert className="mb-6 border-accent bg-accent/10">
            <AlertDescription className="text-accent-foreground">
              {t('successMessage')}
            </AlertDescription>
          </Alert>
        )}

        {/* Error Message */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Settings Form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t('cardTitle')}</CardTitle>
            <CardDescription className="text-base">
              {t('cardDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="form-spacing">
              {/* Newsletter Email */}
              <div className="space-y-3">
                <Label htmlFor="newsletter-email" className="text-base font-medium">
                  {t('emailLabel')}
                </Label>
                <Input
                  id="newsletter-email"
                  type="email"
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={saving}
                  className="h-11"
                />
                <p className="text-sm text-muted-foreground">
                  {t('emailHint')}
                </p>
              </div>

              {/* Delivery Time (daily newsletter) */}
              <div className="space-y-3">
                <Label htmlFor="delivery-hour" className="text-base font-medium">
                  {t('deliveryTimeLabel')}
                </Label>
                <Select
                  value={deliveryHour.toString()}
                  onValueChange={(value) => setDeliveryHour(parseInt(value))}
                  disabled={saving}
                >
                  <SelectTrigger id="delivery-hour" className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hourOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value.toString()}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {t('timezoneHint', { timezone: timezoneName })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('deliveryModePerPodcastHint')}{' '}
                  <Link href="/subscriptions" className="underline hover:text-primary">
                    {t('deliveryModePerPodcastLink')}
                  </Link>
                </p>
              </div>

              {/* Summary style (Kanban #38): tone preset and optional prompt addition */}
              <div className="space-y-3 border-t pt-6">
                <h2 className="text-lg font-semibold">
                  {t('styleSectionTitle')}
                </h2>
                <p className="text-sm text-muted-foreground">{t('styleSectionDescription')}</p>
              </div>

              <div className="space-y-3">
                <p id="summary-tone-label" className="text-base font-medium">
                  {t('toneLabel')}
                </p>
                <RadioGroup
                  aria-labelledby="summary-tone-label"
                  value={summaryTone}
                  onValueChange={(value) => setSummaryTone(normalizeSummaryTone(value) as SummaryTone)}
                  disabled={saving}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {(SUMMARY_TONES as SummaryTone[]).map((tone) => {
                    const optionId = `summary-tone-${tone}`
                    return (
                      <Label
                        key={tone}
                        htmlFor={optionId}
                        className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 font-normal transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                      >
                        <RadioGroupItem
                          id={optionId}
                          value={tone}
                          aria-labelledby={`${optionId}-label`}
                          aria-describedby={`${optionId}-hint`}
                          className="mt-1"
                        />
                        <span className="space-y-1">
                          <span id={`${optionId}-label`} className="block font-medium">{t(TONE_TEXTS[tone].label)}</span>
                          <span id={`${optionId}-hint`} className="block text-sm text-muted-foreground">{t(TONE_TEXTS[tone].description)}</span>
                        </span>
                      </Label>
                    )
                  })}
                </RadioGroup>
              </div>

              <div className="space-y-3">
                <Label htmlFor="summary-prompt-addition" className="text-base font-medium">
                  {t('promptAdditionLabel')}
                </Label>
                <Textarea
                  id="summary-prompt-addition"
                  value={promptAddition}
                  onChange={(e) => setPromptAddition(e.target.value)}
                  maxLength={MAX_PROMPT_ADDITION_CHARS}
                  rows={3}
                  placeholder={t('promptAdditionPlaceholder')}
                  aria-describedby="summary-prompt-addition-hint summary-prompt-addition-counter"
                  disabled={saving}
                />
                <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:justify-between sm:gap-4">
                  <p id="summary-prompt-addition-hint">
                    {t('promptAdditionHint', { max: MAX_PROMPT_ADDITION_CHARS })}
                  </p>
                  <p id="summary-prompt-addition-counter" aria-live="polite" className="shrink-0 tabular-nums">
                    {t('promptAdditionCounter', { count: promptAddition.length, max: MAX_PROMPT_ADDITION_CHARS })}
                  </p>
                </div>
              </div>

              {/* Save Button */}
              <div className="pt-4">
                <Button
                  type="submit"
                  className="w-full h-11"
                  disabled={saving}
                >
                  {saving ? t('saveButtonLoading') : t('saveButton')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Info Card */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg">{t('infoCardTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>{t('infoBullet1')}</p>
            <p>{t('infoBullet2')}</p>
            <p>{t('infoBullet3')}</p>
            <p>{t('infoBullet4')}</p>
            <p>{t('infoBullet5')}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
