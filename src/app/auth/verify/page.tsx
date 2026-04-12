'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export default function VerifyEmailPage() {
  const [verifying, setVerifying] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const router = useRouter()
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null)
  const t = useTranslations('auth')

  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createClient()
    }
    return supabaseRef.current
  }

  useEffect(() => {
    const supabase = getSupabase()
    const verifyEmail = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()

        if (user?.email_confirmed_at) {
          setSuccess(true)
          setVerifying(false)
          setTimeout(() => {
            router.push('/settings')
          }, 2000)
          return
        }

        setVerifying(false)
      } catch (err) {
        setError(t('verifyErrorMessage'))
        setVerifying(false)
      }
    }

    verifyEmail()
  }, [router, t])

  // Listen for auth state changes
  useEffect(() => {
    const supabase = getSupabase()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user.email_confirmed_at) {
          setSuccess(true)
          setVerifying(false)
          setTimeout(() => {
            router.push('/settings')
          }, 2000)
        }
      }
    )

    return () => {
      subscription.unsubscribe()
    }
  }, [router])

  if (verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center container-spacing section-spacing">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl font-bold">{t('verifyTitle')}</CardTitle>
            <CardDescription className="text-base">
              {t('verifyDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center container-spacing section-spacing">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl font-bold">{t('verifyErrorTitle')}</CardTitle>
            <CardDescription className="text-base">
              {t('verifyErrorDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter className="flex flex-col space-y-3">
            <Link href="/login" className="w-full">
              <Button variant="outline" className="w-full">
                {t('backToLogin')}
              </Button>
            </Link>
            <p className="text-sm text-muted-foreground text-center">
              {t('contactSupport')}
            </p>
          </CardFooter>
        </Card>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center container-spacing section-spacing">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl font-bold">{t('verifySuccessTitle')}</CardTitle>
            <CardDescription className="text-base">
              {t('verifySuccessDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertDescription className="text-center">
                {t('verifySuccessMessage')}
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter className="flex justify-center">
            <Link href="/settings">
              <Button>{t('toSettings')}</Button>
            </Link>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center container-spacing section-spacing">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader className="space-y-3 text-center">
          <CardTitle className="text-3xl font-bold">{t('verifyPendingTitle')}</CardTitle>
          <CardDescription className="text-base">
            {t('verifyPendingDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription className="text-center">
              {t('verifyPendingMessage')}
            </AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground text-center">
            {t('verifySpamNote')}
          </p>
        </CardContent>
        <CardFooter className="flex justify-center">
          <Link href="/login">
            <Button variant="outline">{t('backToLoginOutline')}</Button>
          </Link>
        </CardFooter>
      </Card>
    </div>
  )
}
