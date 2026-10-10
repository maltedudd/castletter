// Newsletter archive: one entry per sent mail (`newsletter_mails`) with the episodes it held.
// Pure mapping of the Supabase rows, so list and detail page share it and it runs under node:test.

import { safeHttpUrl, sanitizeSocialHtml } from '../social/sanitize.mjs'

export const ARCHIVE_PAGE_SIZE = 20
export const ARCHIVE_MODES = ['daily', 'immediate']

/** Many-to-one embeds come back as an object, sometimes as a one-element array. */
function one(ref) {
  return (Array.isArray(ref) ? ref[0] : ref) ?? null
}

const isSocial = (episode) => episode?.source_type === 'social'

/**
 * Episodes of a mail in the order they appeared in it: summaries oldest first, then the social
 * posts (their own section in the mail), oldest first.
 */
export function sortMailEpisodes(episodes) {
  return [...(episodes ?? [])].sort((a, b) =>
    Number(isSocial(a)) - Number(isSocial(b)) || String(a.published_at).localeCompare(String(b.published_at))
  )
}

/**
 * The original post of a social episode for display: HTML sanitised again (defense in depth),
 * content warning and only media with http(s) links. null for every other source type.
 * @returns {{ html: string, spoiler: string | null, media: { type: string, url: string | null, previewUrl: string | null, description: string | null }[] } | null}
 */
export function socialPostOf(episode) {
  if (!isSocial(episode)) return null
  const media = (Array.isArray(episode.social_media) ? episode.social_media : [])
    .map((entry) => ({
      type: typeof entry?.type === 'string' ? entry.type : 'unknown',
      url: safeHttpUrl(entry?.url ?? ''),
      previewUrl: safeHttpUrl(entry?.previewUrl ?? ''),
      description: typeof entry?.description === 'string' && entry.description.trim() ? entry.description.trim() : null,
    }))
    .filter((entry) => entry.url)
  return {
    html: sanitizeSocialHtml(episode.social_content ?? ''),
    spoiler: typeof episode.social_spoiler === 'string' && episode.social_spoiler.trim() ? episode.social_spoiler.trim() : null,
    media,
  }
}

/**
 * List entry of a mail: when, which kind, subject, how many episodes and from which sources
 * (unique, in mail order). The cover is the first source's image, if any.
 */
export function toArchiveEntry(mail) {
  const sources = []
  let coverImageUrl = null
  for (const episode of sortMailEpisodes(mail.episodes)) {
    const source = one(episode.podcast_subscriptions)
    if (!source?.title) continue
    if (!sources.includes(source.title)) sources.push(source.title)
    coverImageUrl ??= source.cover_image_url ?? null
  }
  return {
    id: mail.id,
    mode: ARCHIVE_MODES.includes(mail.mode) ? mail.mode : 'daily',
    subject: mail.subject,
    sentAt: mail.sent_at,
    itemCount: mail.episode_count ?? mail.episodes?.length ?? 0,
    sources,
    coverImageUrl,
  }
}

/** Unique mail ids of episodes (for the source filter: mails that contain this source). */
export function mailIdsOf(episodes) {
  return [...new Set((episodes ?? []).map((episode) => episode.newsletter_mail_id).filter(Boolean))]
}
