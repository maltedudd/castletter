import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { groupMailEpisodes } from '@/lib/newsletter/archive.mjs'
import { websiteSummary } from '@/lib/newsletter/digest.mjs'

interface PageProps {
  params: Promise<{ id: string }>
}

interface MailEpisode {
  id: string
  title: string
  audio_url: string | null
  source_type: string | null
  published_at: string
  podcast_subscriptions: { title: string; cover_image_url: string | null } | { title: string; cover_image_url: string | null }[] | null
  episode_newsletters: NewsletterContent | NewsletterContent[] | null
}

interface NewsletterContent {
  intro: string | null
  bullet_points: string[] | null
  key_takeaways: string[] | null
  action_items: string[] | null
  quotes: string[] | null
  speakers: string[] | null
  reflection: string | null
}

const SECTION_KEYS: Record<string, string> = {
  podcast: 'sectionGroupPodcast',
  youtube: 'sectionGroupYoutube',
  website: 'sectionGroupWebsite',
  social: 'sectionGroupSocial',
  other: 'sectionGroupOther',
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function one<T>(ref: T | T[] | null): T | null {
  return (Array.isArray(ref) ? ref[0] : ref) ?? null
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-base font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2 text-muted-foreground">
          <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-2" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** One sent mail of the archive with every episode it contained, in the sections and order of the mail. */
export default async function ArchiveMailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()
  const t = await getTranslations('archive')
  const locale = await getLocale()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }
  if (!UUID_PATTERN.test(id)) {
    notFound()
  }

  // RLS limits newsletter_mails and episodes to the logged-in user's own rows.
  const { data: mail, error } = await supabase
    .from('newsletter_mails')
    .select(
      `
      id,
      user_id,
      mode,
      subject,
      sent_at,
      episodes (
        id,
        title,
        audio_url,
        source_type,
        published_at,
        podcast_subscriptions ( title, cover_image_url ),
        episode_newsletters ( intro, bullet_points, key_takeaways, action_items, quotes, speakers, reflection )
      )
      `
    )
    .eq('id', id)
    .maybeSingle()

  if (error || !mail || mail.user_id !== user.id) {
    notFound()
  }

  const groups = groupMailEpisodes(mail.episodes as MailEpisode[]) as { type: string; episodes: MailEpisode[] }[]
  const episodeCount = groups.reduce((count, group) => count + group.episodes.length, 0)
  const showSections = mail.mode === 'daily'
  const EpisodeTitle = showSections ? 'h3' : 'h2'
  const sentAt = new Date(mail.sent_at).toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className="min-h-screen section-spacing">
      <div className="max-w-2xl mx-auto container-spacing">
        <div className="mb-8">
          <Link
            href="/archive"
            className="text-sm text-muted-foreground hover:text-primary transition-colors inline-block"
          >
            {t('backToArchive')}
          </Link>
        </div>

        {/* Mail header */}
        <header className="mb-8 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={mail.mode === 'daily' ? 'default' : 'outline'}>
              {t(mail.mode === 'daily' ? 'modeDaily' : 'modeImmediate')}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {t('sentBadge', { date: sentAt })}
            </span>
          </div>
          <h1 className="text-2xl font-bold leading-snug">{mail.subject}</h1>
          <p className="text-sm text-muted-foreground">
            {t(episodeCount === 1 ? 'itemCount_one' : 'itemCount_other', { count: episodeCount })}
          </p>
        </header>

        {episodeCount === 0 && <p className="text-muted-foreground">{t('contentLoadError')}</p>}

        <div className="space-y-12">
          {groups.map((group) => (
            <section key={group.type} aria-labelledby={showSections ? `section-${group.type}` : undefined} className="space-y-12">
              {showSections && (
                <h2 id={`section-${group.type}`} className="text-2xl font-bold border-b-4 border-primary pb-2">
                  {t(SECTION_KEYS[group.type])}
                </h2>
              )}
              {group.episodes.map((episode) => {
                const source = one(episode.podcast_subscriptions)
                const newsletter = one(episode.episode_newsletters)
                const sourceTitle = source?.title ?? t('unknownPodcast')
                // Website (RSS) articles: at most three sentences under title and link, like the mail.
                const articleSummary = episode.source_type === 'website' && newsletter
                  ? websiteSummary({ intro: newsletter.intro, keyTakeaways: newsletter.key_takeaways, bulletPoints: newsletter.bullet_points })
                  : null
                const lists: [string, string[] | null][] = newsletter && articleSummary === null
                  ? [
                      ['sectionTopics', newsletter.bullet_points],
                      ['sectionTakeaways', newsletter.key_takeaways],
                      ['sectionTips', newsletter.action_items],
                      ['sectionQuotes', newsletter.quotes],
                      ['sectionSpeakers', newsletter.speakers],
                    ]
                  : []
                return (
                  <article key={episode.id} aria-labelledby={`episode-${episode.id}`} className="space-y-6">
                    <Separator />
                    <div className="flex gap-4 items-start">
                      {source?.cover_image_url ? (
                        <Image src={source.cover_image_url} alt="" width={64} height={64} className="rounded-xl object-cover shrink-0" />
                      ) : (
                        <div aria-hidden="true" className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center text-2xl shrink-0">
                          {episode.source_type === 'website' ? '🌐' : episode.source_type === 'youtube' ? '▶️' : '🎙️'}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm text-muted-foreground mb-1">{sourceTitle}</p>
                        <EpisodeTitle id={`episode-${episode.id}`} className="text-xl font-bold leading-snug">{episode.title}</EpisodeTitle>
                      </div>
                    </div>

                    {articleSummary !== null ? (
                      <p className="text-muted-foreground leading-relaxed">{articleSummary || t('contentLoadError')}</p>
                    ) : newsletter ? (
                      <div className="space-y-6">
                        {newsletter.intro && (
                          <Section title={t('sectionSummary')}>
                            <p className="text-muted-foreground leading-relaxed">{newsletter.intro}</p>
                          </Section>
                        )}
                        {lists
                          .filter(([, items]) => items && items.length > 0)
                          .map(([key, items]) => (
                            <Section key={key} title={t(key)}>
                              <BulletList items={items as string[]} />
                            </Section>
          ))}
                        {newsletter.reflection && (
                          <Section title={t('sectionReflection')}>
                            <p className="text-muted-foreground leading-relaxed italic">{newsletter.reflection}</p>
                          </Section>
                        )}
                      </div>
                    ) : (
                      <p className="text-muted-foreground">{t('contentLoadError')}</p>
                    )}

                    {episode.audio_url && (
                      <Button asChild variant="outline">
                        <a href={episode.audio_url} target="_blank" rel="noopener noreferrer">
                          {t(episode.source_type === 'website' ? 'readArticleButton' : 'listenButton')}
                          <span className="sr-only">: {episode.title} {t('opensInNewTab')}</span>
                        </a>
                      </Button>
                    )}
                  </article>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
