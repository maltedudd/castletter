import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/server'
import { getTranslations, getLocale } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { socialPostOf, sortMailEpisodes } from '@/lib/newsletter/archive.mjs'
import type { SocialMedia } from '@/types/database'

interface PageProps {
  params: Promise<{ id: string }>
}

interface MailEpisode {
  id: string
  title: string
  audio_url: string | null
  source_type: string | null
  published_at: string
  social_content: string | null
  social_spoiler: string | null
  social_media: SocialMedia[] | null
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

const MEDIA_LABEL_KEYS: Record<string, string> = {
  image: 'mediaImage',
  gifv: 'mediaGifv',
  video: 'mediaVideo',
  audio: 'mediaAudio',
  link: 'mediaLink',
}

const SOURCE_PLACEHOLDERS: Record<string, string> = { website: '🌐', youtube: '▶️', social: '💬' }

/** A social post as it was mailed: content warning, original (sanitised) text and media links. */
function SocialPost({ post, t }: { post: NonNullable<ReturnType<typeof socialPostOf>>; t: Awaited<ReturnType<typeof getTranslations>> }) {
  return (
    <div className="space-y-4">
      {post.spoiler && (
        <p className="rounded-md border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          {t('contentWarning')}: {post.spoiler}
        </p>
      )}
      {post.html && (
        <div
          className="space-y-3 leading-relaxed text-muted-foreground break-words [&_a]:underline [&_a]:text-primary [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
          // Sanitised by socialPostOf (allowlist: formatting tags and http(s) links only).
          dangerouslySetInnerHTML={{ __html: post.html }}
        />
      )}
      {post.media.length > 0 && (
        <ul className="space-y-3">
          {post.media.map((media, index) => {
            const label = t(MEDIA_LABEL_KEYS[media.type] ?? 'mediaUnknown')
            const text = media.description ? `${label}: ${media.description}` : label
            return (
              <li key={index}>
                <a href={media.url ?? undefined} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-3 text-sm hover:text-primary">
                  {media.previewUrl?.startsWith('https://') && (
                    <Image src={media.previewUrl} alt="" width={96} height={64} className="h-16 w-24 rounded-md object-cover shrink-0" />
                  )}
                  <span className="underline">{text}</span>
                  <span className="sr-only">{t('opensInNewTab')}</span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** One sent mail of the archive with every episode it contained, in mail order. */
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
        social_content,
        social_spoiler,
        social_media,
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

  const episodes = sortMailEpisodes(mail.episodes as MailEpisode[]) as MailEpisode[]
  // As in the mail: in a digest the social posts follow the summaries under their own heading.
  const firstSocialId = mail.mode === 'daily' && episodes.some((e) => e.source_type !== 'social')
    ? episodes.find((e) => e.source_type === 'social')?.id
    : undefined
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
            {t(episodes.length === 1 ? 'itemCount_one' : 'itemCount_other', { count: episodes.length })}
          </p>
        </header>

        {episodes.length === 0 && <p className="text-muted-foreground">{t('contentLoadError')}</p>}

        <div className="space-y-12">
          {episodes.map((episode) => {
            const source = one(episode.podcast_subscriptions)
            const newsletter = one(episode.episode_newsletters)
            const socialPost = socialPostOf(episode)
            const sourceTitle = source?.title ?? t('unknownPodcast')
            const lists: [string, string[] | null][] = newsletter
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
                {episode.id === firstSocialId && (
                  <div className="space-y-1 pt-4">
                    <h2 className="text-2xl font-bold">{t('socialSection')}</h2>
                    <p className="text-sm text-muted-foreground">{t('socialSectionNote')}</p>
                  </div>
                )}
                <Separator />
                <div className="flex gap-4 items-start">
                  {source?.cover_image_url ? (
                    <Image src={source.cover_image_url} alt="" width={64} height={64} className="rounded-xl object-cover shrink-0" />
                  ) : (
                    <div aria-hidden="true" className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center text-2xl shrink-0">
                      {SOURCE_PLACEHOLDERS[episode.source_type ?? ''] ?? '🎙️'}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground mb-1">{sourceTitle}</p>
                    <h2 id={`episode-${episode.id}`} className="text-xl font-bold leading-snug">{episode.title}</h2>
                  </div>
                </div>

                {socialPost ? (
                  <SocialPost post={socialPost} t={t} />
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
                      {t(episode.source_type === 'social' ? 'viewPostButton' : episode.source_type === 'website' ? 'readArticleButton' : 'listenButton')}
                      <span className="sr-only">: {episode.title} {t('opensInNewTab')}</span>
                    </a>
                  </Button>
                )}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}
