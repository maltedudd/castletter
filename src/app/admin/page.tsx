import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { Badge } from '@/components/ui/badge'
import { AdminActions } from './AdminActions'

const ADMIN_EMAIL = 'malte.dudd@gmail.com'

type BetaRequest = {
  id: string
  email: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
  approved_at: string | null
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function StatusBadge({ status }: { status: BetaRequest['status'] }) {
  if (status === 'approved') {
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
        Freigeschalten
      </Badge>
    )
  }
  if (status === 'rejected') {
    return (
      <Badge className="bg-red-100 text-red-800 hover:bg-red-100">
        Abgelehnt
      </Badge>
    )
  }
  return (
    <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100">
      Ausstehend
    </Badge>
  )
}

export default async function AdminPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  if (user.email !== ADMIN_EMAIL) {
    notFound()
  }

  const admin = createAdminClient()
  const { data: requests, error } = await admin
    .from('beta_requests')
    .select('id, email, status, created_at, approved_at')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Failed to load beta_requests:', error)
  }

  const betaRequests: BetaRequest[] = requests ?? []
  const pendingCount = betaRequests.filter((r) => r.status === 'pending').length

  return (
    <div className="min-h-screen section-spacing">
      <div className="max-w-4xl mx-auto container-spacing">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Admin: Beta-Anfragen</h1>
          <p className="text-muted-foreground mt-1">
            {betaRequests.length} Anfragen insgesamt, {pendingCount} ausstehend
          </p>
        </div>

        {betaRequests.length === 0 ? (
          <p className="text-muted-foreground">Noch keine Beta-Anfragen vorhanden.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Email</th>
                  <th className="text-left px-4 py-3 font-medium">Datum</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-right px-4 py-3 font-medium">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {betaRequests.map((req) => (
                  <tr key={req.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{req.email}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {formatDate(req.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={req.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {req.status === 'pending' && (
                        <AdminActions email={req.email} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
