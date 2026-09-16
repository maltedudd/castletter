import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import { getOpenRouterConfig } from '@/lib/cron/openrouter-config.mjs'

const MAX_TRANSCRIPT_CHARS = 150_000 // ~150k chars stays safely within the model context

export const maxDuration = 60 // Vercel Hobby plan

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const openrouterConfig = getOpenRouterConfig()
  const openrouter = new OpenAI(openrouterConfig.client)

  let generated = 0
  let failed = 0

  try {
    // Fetch recent transcribed episodes only. This prevents any stale backlog
    // item from turning into a delayed newsletter when cron processing resumes.
    const { data: episodes, error: fetchError } = await supabase
      .from('episodes')
      .select(`
        id, title, transcript, audio_url, subscription_id,
        podcast_subscriptions!inner(title)
      `)
      .eq('status', 'transcribed')
      .gte('published_at', getRecentEpisodeCutoff())
      .order('published_at', { ascending: false })
      .limit(2) // Max 2 per run (60s timeout on Hobby plan)

    if (fetchError || !episodes) {
      return NextResponse.json(
        { error: 'Failed to fetch episodes', details: fetchError?.message },
        { status: 500 }
      )
    }

    if (episodes.length === 0) {
      return NextResponse.json({ success: true, generated: 0, failed: 0, message: 'No transcribed episodes' })
    }

    // Process sequentially (rate limits)
    for (const episode of episodes) {
      try {
        await generateNewsletter(supabase, openrouter, openrouterConfig.newsletterModel, episode)
        generated++
      } catch {
        failed++
      }
    }

    return NextResponse.json({ success: true, generated, failed })
  } catch (err) {
    return NextResponse.json(
      { error: 'Newsletter generation failed', details: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 }
    )
  }
}

interface EpisodeWithPodcast {
  id: string
  title: string
  transcript: string | null
  audio_url: string
  subscription_id: string
  podcast_subscriptions: { title: string }[]
}

async function generateNewsletter(
  supabase: ReturnType<typeof createAdminClient>,
  openrouter: OpenAI,
  model: string,
  episode: EpisodeWithPodcast
): Promise<void> {
  // Mark as generating
  await supabase
    .from('episodes')
    .update({ status: 'generating_newsletter' })
    .eq('id', episode.id)

  try {
    if (!episode.transcript) {
      throw new PermanentError('Kein Transkript vorhanden')
    }

    const podcastTitle = episode.podcast_subscriptions[0]?.title || 'Podcast'
    // Truncate transcript if too long
    const transcript = episode.transcript.length > MAX_TRANSCRIPT_CHARS
      ? episode.transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[Transkript gekürzt]'
      : episode.transcript

    const completion = await openrouter.chat.completions.create({
      model,
      max_tokens: 3000,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: `Du fasst eine Podcast-Episode zusammen. Dein Ziel ist, mir das Wissen aus dem Podcast so zu vermitteln, als hättest du ihn für mich gehört. Sprich mich direkt an, verwende klare Sprache, und verzichte auf Floskeln.

Podcast: ${podcastTitle}
Episode: ${episode.title}

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
      }]
    })

    const responseText = completion.choices[0]?.message?.content
    if (!responseText) {
      throw new PermanentError('Keine Textantwort vom Modell erhalten')
    }

    const parsed = parseNewsletter(responseText)

    // Save newsletter content
    const { error: insertError } = await supabase
      .from('episode_newsletters')
      .insert({
        episode_id: episode.id,
        intro: parsed.intro,
        bullet_points: parsed.bulletPoints,
        key_takeaways: parsed.keyTakeaways,
        action_items: parsed.actionItems,
        quotes: parsed.quotes,
        speakers: parsed.speakers,
        reflection: parsed.reflection,
      })

    if (insertError) {
      throw new PermanentError(`DB insert failed: ${insertError.message}`)
    }

    // Update status
    await supabase
      .from('episodes')
      .update({ status: 'newsletter_ready', error_message: null })
      .eq('id', episode.id)
  } catch (err) {
    const isPermanent = err instanceof PermanentError

    if (isPermanent) {
      await supabase
        .from('episodes')
        .update({ status: 'newsletter_failed', error_message: (err as Error).message })
        .eq('id', episode.id)
    } else {
      // Temporary error (rate limit, network) – reset for retry
      await supabase
        .from('episodes')
        .update({
          status: 'transcribed',
          error_message: `Temporärer Fehler: ${err instanceof Error ? err.message : 'Unknown'}`,
        })
        .eq('id', episode.id)
    }

    throw err
  }
}

/** Parse markdown response into structured data */
function parseNewsletter(markdown: string): {
  intro: string
  bulletPoints: string[]
  keyTakeaways: string[]
  actionItems: string[]
  quotes: string[]
  speakers: string[]
  reflection: string | null
} {
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
function extractSectionRaw(markdown: string, heading: string): string {
  const regex = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, 'i')
  return regex.exec(markdown)?.[1] || ''
}

/** Extract a section as plain text (for non-bullet sections like Zusammenfassung) */
function extractSection(markdown: string, heading: string): string {
  return extractSectionRaw(markdown, heading)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('- ') && !line.startsWith('* '))
    .join(' ')
    .trim()
}

/** Extract bullet points from a markdown section */
function extractBulletPoints(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .filter((line) => line.length > 0)
}

class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}
