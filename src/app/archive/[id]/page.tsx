import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

interface PageProps {
  params: Promise<{ id: string }>
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2 text-muted-foreground">
          <span className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

export default async function ArchiveDetailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Check auth
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Load episode with newsletter content and subscription info
  const { data: episode, error } = await supabase
    .from('episodes')
    .select(
      `
      id,
      title,
      newsletter_sent_at,
      audio_url,
      subscription_id,
      podcast_subscriptions (
        id,
        title,
        cover_image_url,
        user_id
      ),
      episode_newsletters (
        id,
        intro,
        bullet_points,
        key_takeaways
      )
      `
    )
    .eq('id', id)
    .eq('status', 'newsletter_sent')
    .single()

  if (error || !episode) {
    notFound()
  }

  // Security check: episode must belong to the logged-in user
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = episode.podcast_subscriptions as any
  if (!sub || sub.user_id !== user.id) {
    notFound()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newsletter = episode.episode_newsletters as any

  const podcastTitle: string = sub?.title ?? 'Unbekannter Podcast'
  const podcastCover: string | null = sub?.cover_image_url ?? null

  return (
    <div className="min-h-screen section-spacing">
      <div className="max-w-2xl mx-auto container-spacing">
        {/* Back Link */}
        <div className="mb-8">
          <Link
            href="/archive"
            className="text-sm text-muted-foreground hover:text-primary transition-colors inline-block"
          >
            &larr; Zurück zum Archiv
          </Link>
        </div>

        {/* Header */}
        <div className="flex gap-4 items-start mb-8">
          {podcastCover ? (
            <Image
              src={podcastCover}
              alt={podcastTitle}
              width={80}
              height={80}
              className="rounded-xl object-cover shrink-0"
            />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-muted flex items-center justify-center text-3xl shrink-0">
              🎙️
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground mb-1">{podcastTitle}</p>
            <h1 className="text-2xl font-bold leading-snug">{episode.title}</h1>
            {episode.newsletter_sent_at && (
              <Badge variant="secondary" className="mt-2">
                Versendet am {formatDate(episode.newsletter_sent_at)}
              </Badge>
            )}
          </div>
        </div>

        <Separator className="mb-8" />

        {/* Newsletter Content */}
        {newsletter ? (
          <div className="space-y-8">
            {/* Intro */}
            {newsletter.intro && (
              <Section title="Zusammenfassung">
                <p className="text-muted-foreground leading-relaxed">{newsletter.intro}</p>
              </Section>
            )}

            {/* Bullet Points / Hauptthemen */}
            {newsletter.bullet_points && newsletter.bullet_points.length > 0 && (
              <>
                <Separator />
                <Section title="Hauptthemen">
                  <BulletList items={newsletter.bullet_points} />
                </Section>
              </>
            )}

            {/* Key Takeaways / Wichtige Aussagen */}
            {newsletter.key_takeaways && newsletter.key_takeaways.length > 0 && (
              <>
                <Separator />
                <Section title="Wichtige Aussagen">
                  <BulletList items={newsletter.key_takeaways} />
                </Section>
              </>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">
            Die Newsletter-Inhalte konnten nicht geladen werden.
          </p>
        )}

        {/* Episode Link */}
        {episode.audio_url && (
          <div className="mt-10 pt-8 border-t">
            <Button asChild>
              <a href={episode.audio_url} target="_blank" rel="noopener noreferrer">
                Episode anhören
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
