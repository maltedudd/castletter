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
import { localHourToUTC, utcHourToLocal, getHourOptions, getTimezoneName } from '@/lib/utils/timezone'

interface UserSettings {
  newsletter_email: string
  newsletter_delivery_hour: number
}

export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('settings')

  const [email, setEmail] = useState('')
  const [deliveryHour, setDeliveryHour] = useState(8) // Default: 8:00 AM local time
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
          .select('newsletter_email, newsletter_delivery_hour')
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

    try {
      // Convert local hour to UTC before saving
      const utcHour = localHourToUTC(deliveryHour)

      const { error } = await supabase
        .from('user_settings')
        .upsert({
          user_id: user.id,
          newsletter_email: email,
          newsletter_delivery_hour: utcHour,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      if (error) {
        console.error('Error saving settings:', error)
        setError(t('errorSaveSettings'))
        setSaving(false)
        return
      }

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

              {/* Delivery Time */}
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
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
