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

type YouTubeSourceRow = {
  id: string
  title: string
  youtube_channel_id: string | null
  enabled: boolean
  last_checked_at: string | null
  last_check_status: 'success' | 'error' | null
  last_check_error: string | null
}

type FailedVideoRow = {
  id: string
  subscription_id: string
  title: string
  error_code: string | null
  error_message: string | null
  published_at: string
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

  // YouTube channel sources of all users with their latest feed check and failed videos.
  const { data: youtubeSourceRows, error: youtubeSourcesError } = await admin
    .from('podcast_subscriptions')
    .select('id, title, youtube_channel_id, enabled, last_checked_at, last_check_status, last_check_error')
    .eq('source_type', 'youtube')
    .order('title', { ascending: true })
  if (youtubeSourcesError) {
    console.error('Failed to load YouTube sources:', youtubeSourcesError)
  }
  const { data: failedVideoRows, error: failedVideosError } = await admin
    .from('episodes')
    .select('id, subscription_id, title, error_code, error_message, published_at')
    .eq('source_type', 'youtube')
    .eq('status', 'failed')
    .order('published_at', { ascending: false })
    .limit(20)
  if (failedVideosError) {
    console.error('Failed to load failed YouTube videos:', failedVideosError)
  }
  const youtubeSources: YouTubeSourceRow[] = youtubeSourceRows ?? []
  const failedVideos: FailedVideoRow[] = failedVideoRows ?? []
  const sourceTitle = new Map(youtubeSources.map((s) => [s.id, s.title]))

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

        <div className="mt-12 mb-4">
          <h2 className="text-2xl font-bold">YouTube-Quellen</h2>
          <p className="text-muted-foreground mt-1">
            {youtubeSources.length} Kanäle, {youtubeSources.filter((s) => s.enabled && s.last_check_status === 'error').length} mit Feed-Fehler
          </p>
        </div>

        {youtubeSources.length === 0 ? (
          <p className="text-muted-foreground">Noch keine YouTube-Kanäle angelegt.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Kanal</th>
                  <th className="text-left px-4 py-3 font-medium">Letzter Check</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {youtubeSources.map((source) => (
                  <tr key={source.id} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{source.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">{source.youtube_channel_id}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {source.last_checked_at ? formatDate(source.last_checked_at) : '–'}
                    </td>
                    <td className="px-4 py-3">
                      {!source.enabled ? (
                        <Badge variant="secondary">Deaktiviert</Badge>
                      ) : source.last_check_status === 'error' ? (
                        <>
                          <Badge className="bg-red-100 text-red-800 hover:bg-red-100">Fehler</Badge>
                          <p className="text-xs text-muted-foreground mt-1 break-words">{source.last_check_error}</p>
                        </>
                      ) : source.last_check_status === 'success' ? (
                        <Badge className="bg-green-100 text-green-800 hover:bg-green-100">OK</Badge>
                      ) : (
                        <Badge variant="outline">Ungeprüft</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {failedVideos.length > 0 && (
          <>
            <h3 className="text-lg font-semibold mt-8 mb-3">Fehlgeschlagene YouTube-Videos</h3>
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Video</th>
                    <th className="text-left px-4 py-3 font-medium">Grund</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {failedVideos.map((video) => (
                    <tr key={video.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium">{video.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {sourceTitle.get(video.subscription_id) ?? 'Unbekannter Kanal'} · {formatDate(video.published_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-xs">{video.error_code ?? 'unbekannt'}</code>
                        <p className="text-xs text-muted-foreground mt-1 break-words">{video.error_message}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
