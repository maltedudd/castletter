'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function DashboardPage() {
  const { user, loading, signOut } = useAuth()
  const router = useRouter()

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
            <h1 className="text-4xl font-bold mb-2">Dashboard</h1>
            <p className="text-muted-foreground text-lg">
              Willkommen zurück, {user.email}
            </p>
          </div>
          <Button onClick={signOut} variant="outline">
            Abmelden
          </Button>
        </div>

        {/* Quick Actions */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/settings')}>
            <CardHeader>
              <CardTitle className="text-xl">Einstellungen</CardTitle>
              <CardDescription>
                Newsletter-Email und Versandzeit konfigurieren
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/subscriptions')}>
            <CardHeader>
              <CardTitle className="text-xl">Podcast-Abos</CardTitle>
              <CardDescription>
                Podcasts abonnieren und verwalten
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => router.push('/archive')}>
            <CardHeader>
              <CardTitle className="text-xl">Newsletter-Archiv</CardTitle>
              <CardDescription>
                Alle versendeten Newsletter einsehen und nachlesen
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        {/* Welcome Message */}
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Willkommen bei Castletter!</CardTitle>
            <CardDescription className="text-base">
              Erhalte täglich personalisierte Newsletter zu deinen Lieblings-Podcasts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <h3 className="font-semibold text-lg">Nächste Schritte:</h3>
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Konfiguriere deine Newsletter-Einstellungen</li>
                <li>Abonniere deine Lieblings-Podcasts</li>
                <li>Erhalte täglich Newsletter mit Podcast-Zusammenfassungen</li>
              </ol>
            </div>
            <div className="pt-4">
              <Button onClick={() => router.push('/settings')} size="lg">
                Einstellungen konfigurieren
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
