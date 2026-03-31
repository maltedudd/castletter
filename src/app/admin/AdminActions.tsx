'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

interface AdminActionsProps {
  email: string
}

export function AdminActions({ email }: AdminActionsProps) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)
  const router = useRouter()

  async function handleAction(action: 'approve' | 'reject') {
    setLoading(action)
    try {
      const res = await fetch(`/api/admin/beta/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      if (!res.ok) {
        const data = await res.json()
        alert(`Fehler: ${data.error ?? 'Unbekannter Fehler'}`)
        return
      }

      // Refresh the server component data
      router.refresh()
    } catch {
      alert('Ein unerwarteter Fehler ist aufgetreten')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="flex gap-2 justify-end">
      <Button
        size="sm"
        variant="outline"
        className="text-green-700 border-green-300 hover:bg-green-50 hover:text-green-800"
        disabled={loading !== null}
        onClick={() => handleAction('approve')}
      >
        {loading === 'approve' ? 'Wird freigeschaltet...' : 'Freischalten'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-red-700 border-red-300 hover:bg-red-50 hover:text-red-800"
        disabled={loading !== null}
        onClick={() => handleAction('reject')}
      >
        {loading === 'reject' ? 'Wird abgelehnt...' : 'Ablehnen'}
      </Button>
    </div>
  )
}
