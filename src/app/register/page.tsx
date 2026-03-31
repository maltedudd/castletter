'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export default function RegisterPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const response = await fetch('/api/beta/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error ?? 'Ein Fehler ist aufgetreten')
        setLoading(false)
        return
      }

      setSuccess(true)
      setLoading(false)
    } catch {
      setError('Ein unerwarteter Fehler ist aufgetreten')
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center container-spacing section-spacing">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <CardTitle className="text-3xl font-bold">Du bist auf der Warteliste!</CardTitle>
            <CardDescription className="text-base">
              Wir melden uns, sobald du freigeschaltet wirst
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert className="border-accent bg-accent/10">
              <AlertDescription className="text-center text-accent-foreground">
                Wir haben deine Anfrage erhalten. Sobald wir deinen Beta-Zugang freischalten, bekommst du eine Email mit deinem Einladungslink.
              </AlertDescription>
            </Alert>
            <p className="text-sm text-muted-foreground text-center pt-2">
              In der Zwischenzeit freuen wir uns, wenn du Castletter weiterempfiehlst.
            </p>
          </CardContent>
          <CardFooter className="flex justify-center">
            <Link href="/login">
              <Button variant="outline">Zur Anmeldung</Button>
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
          <CardTitle className="text-3xl font-bold">Beta-Zugang anfragen</CardTitle>
          <CardDescription className="text-base">
            Trag dich auf die Warteliste ein und erhalte als einer der Ersten Zugang zu Castletter
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleRegister} className="form-spacing">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email-Adresse
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="deine@email.de"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
                className="h-11"
              />
            </div>

            <Button
              type="submit"
              className="w-full h-11 mt-4"
              disabled={loading}
            >
              {loading ? 'Wird eingetragen...' : 'Auf Warteliste eintragen'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <div className="text-sm text-center text-muted-foreground">
            Bereits eingeladen?{' '}
            <Link
              href="/login"
              className="font-medium text-primary hover:text-primary/80 transition-colors"
            >
              Jetzt anmelden
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}
