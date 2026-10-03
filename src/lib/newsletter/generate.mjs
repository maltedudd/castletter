// Newsletter generation shared by the Vercel cron route and the Docker worker.
// Dependency-free: the Supabase client and the OpenRouter (OpenAI-compatible) client are
// injected, so prompt, parsing and the claim/lease handling run under node:test.

import { buildNewsletterCompletionOptions } from '../cron/newsletter-request.mjs'

export const MAX_TRANSCRIPT_CHARS = 150_000 // ~150k chars stays safely within the model context

// A `generating_newsletter` claim older than this means the run died mid-generation.
export const GENERATION_LEASE_MS = 15 * 60 * 1000
export const GENERATION_MARKER_PREFIX = 'Newsletter-Generierung gestartet: '

/** Failure that retrying will not fix (no transcript, empty model answer, DB constraint). */
export class NewsletterPermanentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NewsletterPermanentError'
  }
}

export function buildGenerationMarker(now = new Date()) {
  return `${GENERATION_MARKER_PREFIX}${now.toISOString()}`
}

function parseGenerationMarker(errorMessage) {
  if (typeof errorMessage !== 'string' || !errorMessage.startsWith(GENERATION_MARKER_PREFIX)) return null
  const time = new Date(errorMessage.slice(GENERATION_MARKER_PREFIX.length).trim()).getTime()
  return Number.isNaN(time) ? null : time
}

/** `podcast_subscriptions` is a many-to-one embed: PostgREST returns an object, not an array. */
export function getPodcastRef(episode) {
  const ref = episode.podcast_subscriptions
  return (Array.isArray(ref) ? ref[0] : ref) ?? undefined
}

export function buildNewsletterPrompt({ podcastTitle, episodeTitle, transcript: fullTranscript }) {
  const transcript = fullTranscript.length > MAX_TRANSCRIPT_CHARS
    ? fullTranscript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[Transkript gekürzt]'
    : fullTranscript

  return `Du fasst eine Podcast-Episode zusammen. Dein Ziel ist, mir das Wissen aus dem Podcast so zu vermitteln, als hättest du ihn für mich gehört. Sprich mich direkt an, verwende klare Sprache, und verzichte auf Floskeln.

Podcast: ${podcastTitle}
Episode: ${episodeTitle}

Transkript:
${transcript}

Erstelle folgende Struktur (exakt diese Überschriften verwenden):

## Zusammenfassung
[Prägnante Zusammenfassung in max. 5 Sätzen – für einen schnellen Überblick]

## Hauptthemen
- [Die Hauptthemen des Podcasts als Stichpunkte]

## Wichtige Aussagen und Erkenntnisse
- [Alle wichtigen Aussagen und Erkenntnisse – logisch gruppiert]

## Tipps und Methoden
- [Konkrete Tipps, Methoden, Handlungsempfehlungen oder Frameworks – falls vorhanden. Wenn nicht vorhanden, diese Sektion weglassen.]

## Zitate und Begriffe
- [Wichtige Zitate oder Begriffe, die im Podcast hervorgehoben wurden – falls vorhanden. Wenn nicht vorhanden, diese Sektion weglassen.]

## Wer sagt was
- [Falls der Podcast ein Interview ist: Wer sagt was? Rollen oder Perspektiven angeben. Falls kein Interview, diese Sektion weglassen.]

## Einordnung
[Kritische Reflexion oder Kontext – wie das Gesagte einzuordnen ist. 2-3 Sätze. Falls nicht sinnvoll, diese Sektion weglassen.]

Mindestens 3 Bullet Points pro Sektion. Optionale Sektionen nur aufnehmen, wenn der Inhalt sie hergibt.`
}

/**
 * Claims a `transcribed` episode (compare-and-swap with a lease marker), generates and stores
 * its newsletter and marks it `newsletter_ready`. Every later write is guarded by the marker,
 * so a run that lost its claim never overwrites the new owner.
 *
 * Returns 'ready' | 'failed' | 'retry_later' | 'lost_race' | 'lease_lost'.
 */
export async function generateNewsletterForEpisode({ supabase, openrouter, model, episode, now = new Date() }) {
  const marker = buildGenerationMarker(now)
  const { data: claimed, error: claimError } = await supabase
    .from('episodes')
    .update({ status: 'generating_newsletter', error_message: marker })
    .eq('id', episode.id)
    .eq('status', 'transcribed')
    .select('id')
  if (claimError) throw new Error(`Episode konnte nicht beansprucht werden: ${claimError.message}`)
  if (!claimed?.length) return 'lost_race'

  const casUpdate = async (patch) => {
    const { data, error } = await supabase
      .from('episodes')
      .update(patch)
      .eq('id', episode.id)
      .eq('status', 'generating_newsletter')
      .eq('error_message', marker)
      .select('id')
    if (error) throw new Error(`Episode ${episode.id} konnte nicht aktualisiert werden: ${error.message}`)
    return (data?.length ?? 0) > 0
  }

  try {
    if (!episode.transcript) {
      throw new NewsletterPermanentError('Kein Transkript vorhanden')
    }

    const prompt = buildNewsletterPrompt({
      podcastTitle: getPodcastRef(episode)?.title || 'Podcast',
      episodeTitle: episode.title,
      transcript: episode.transcript,
    })
    const completion = await openrouter.chat.completions.create(
      buildNewsletterCompletionOptions(model, [{ role: 'user', content: prompt }])
    )

    const responseText = completion.choices?.[0]?.message?.content
    if (!responseText) {
      throw new NewsletterPermanentError('Keine Textantwort vom Modell erhalten')
    }

    const parsed = parseNewsletter(responseText)

    // Lease check before writing the newsletter row, so a superseded run stores nothing.
    if (!(await casUpdate({ error_message: marker }))) return 'lease_lost'

    // Upsert: a previous run may have stored the row but died before marking the episode.
    const { error: insertError } = await supabase
      .from('episode_newsletters')
      .upsert({
        episode_id: episode.id,
        intro: parsed.intro,
        bullet_points: parsed.bulletPoints,
        key_takeaways: parsed.keyTakeaways,
        action_items: parsed.actionItems,
        quotes: parsed.quotes,
        speakers: parsed.speakers,
        reflection: parsed.reflection,
      }, { onConflict: 'episode_id' })

    if (insertError) {
      throw new NewsletterPermanentError(`DB insert failed: ${insertError.message}`)
    }

    return (await casUpdate({ status: 'newsletter_ready', error_message: null })) ? 'ready' : 'lease_lost'
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown'
    if (err instanceof NewsletterPermanentError) {
      return (await casUpdate({ status: 'newsletter_failed', error_message: message })) ? 'failed' : 'lease_lost'
    }
    // Temporary error (rate limit, network) – hand back for retry
    return (await casUpdate({ status: 'transcribed', error_message: `Temporärer Fehler: ${message}` }))
      ? 'retry_later'
      : 'lease_lost'
  }
}

/**
 * Hands `generating_newsletter` episodes published after `publishedAfter` back to
 * `transcribed` when their claim is older than the lease. Rows without a marker were claimed
 * by the pre-marker cron and can only be stuck. Compare-and-swap on the exact marker read.
 */
export async function resetStaleGeneratingEpisodes(supabase, publishedAfter, now = new Date()) {
  const { data: rows, error } = await supabase
    .from('episodes')
    .select('id, error_message')
    .eq('status', 'generating_newsletter')
    .gte('published_at', publishedAfter)
  if (error) throw new Error(`generating_newsletter-Episoden konnten nicht gelesen werden: ${error.message}`)

  let reset = 0
  for (const row of rows ?? []) {
    const claimedAt = parseGenerationMarker(row.error_message)
    if (claimedAt !== null && now.getTime() - claimedAt <= GENERATION_LEASE_MS) continue

    let query = supabase
      .from('episodes')
      .update({ status: 'transcribed', error_message: 'Automatischer Reset: Newsletter-Generierung abgebrochen' })
      .eq('id', row.id)
      .eq('status', 'generating_newsletter')
    query = row.error_message == null ? query.is('error_message', null) : query.eq('error_message', row.error_message)
    const { data, error: resetError } = await query.select('id')
    if (resetError) throw new Error(`Stale-Reset fehlgeschlagen: ${resetError.message}`)
    reset += data?.length ?? 0
  }
  return reset
}

/** Parse markdown response into structured data */
export function parseNewsletter(markdown) {
  const intro = extractSection(markdown, 'Zusammenfassung')
  const bulletPoints = extractBulletPoints(extractSectionRaw(markdown, 'Hauptthemen'))
  const keyTakeaways = extractBulletPoints(extractSectionRaw(markdown, 'Wichtige Aussagen und Erkenntnisse'))
  const actionItems = extractBulletPoints(extractSectionRaw(markdown, 'Tipps und Methoden'))
  const quotes = extractBulletPoints(extractSectionRaw(markdown, 'Zitate und Begriffe'))
  const speakers = extractBulletPoints(extractSectionRaw(markdown, 'Wer sagt was'))
  const reflection = extractSection(markdown, 'Einordnung') || null

  // Fallback: if parsing failed, use the whole response as intro
  if (!intro && bulletPoints.length === 0 && keyTakeaways.length === 0) {
    return {
      intro: markdown.trim(),
      bulletPoints: [],
      keyTakeaways: [],
      actionItems: [],
      quotes: [],
      speakers: [],
      reflection: null,
    }
  }

  return { intro, bulletPoints, keyTakeaways, actionItems, quotes, speakers, reflection }
}

/** Extract raw text of a markdown section (between ## heading and next ## or end) */
function extractSectionRaw(markdown, heading) {
  const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i')
  return regex.exec(markdown)?.[1] || ''
}

/** Extract a section as plain text (for non-bullet sections like Zusammenfassung) */
function extractSection(markdown, heading) {
  return extractSectionRaw(markdown, heading)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('- ') && !line.startsWith('* '))
    .join(' ')
    .trim()
}

/** Extract bullet points from a markdown section */
function extractBulletPoints(section) {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => line.length > 0)
}
