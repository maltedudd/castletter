'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function DashboardPage() {
  const { user, loading, signOut } = useAuth()
  const router = useRouter()
  const t = useTranslations('dashboard')
  const tNav = useTranslations('nav')

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login')
    }
  }, [user, loading, router])

  if (loading) {
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
      <div className="max-w-7xl mx-auto container-spacing">
        {/* Header */}
        <div className="flex items-center justify-between mb-12">
          <div>
            <h1 className="text-4xl font-bold mb-2">{t('title')}</h1>
            <p className="text-muted-foreground text-lg">
              {t('welcome', { email: user.email ?? '' })}
            </p>
          </div>
          <Button onClick={signOut} variant="outline">
            {tNav('signOut')}
          </Button>
        </div>

        {/* Quick Actions */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/settings')}>
            <CardHeader>
              <CardTitle className="text-xl">{t('settingsTitle')}</CardTitle>
              <CardDescription>
                {t('settingsDescription')}
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/subscriptions')}>
            <CardHeader>
              <CardTitle className="text-xl">{t('subscriptionsTitle')}</CardTitle>
              <CardDescription>
                {t('subscriptionsDescription')}
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/archive')}>
            <CardHeader>
              <CardTitle className="text-xl">{t('archiveTitle')}</CardTitle>
              <CardDescription>
                {t('archiveDescription')}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        {/* Welcome Message */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{t('welcomeCardTitle')}</CardTitle>
            <CardDescription className="text-base">
              {t('welcomeCardDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <h3 className="font-semibold text-lg">{t('nextStepsTitle')}</h3>
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>{t('nextStep1')}</li>
                <li>{t('nextStep2')}</li>
                <li>{t('nextStep3')}</li>
              </ol>
            </div>
            <div className="pt-4">
              <Button onClick={() => router.push('/settings')} size="lg">
                {t('configureSettings')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
