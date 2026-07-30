import { NextRequest, NextResponse, after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import {
  WHISPER_MAX_SIZE,
  isTooLargeForWhisper,
  buildAcceptedResponse,
  buildNoPendingResponse,
  buildClaimMarker,
  isStaleTranscribingRow,
} from '@/lib/cron/transcribe-ack.mjs'
import OpenAI from 'openai'

// maxDuration bounds the whole function (fast ack + background after() work). cron-job.org
// itself only ever sees the fast ack below — its 30s timeout no longer applies to the
// actual transcription, but Vercel still tears the function down after maxDuration.
export const maxDuration = 60 // Vercel Hobby plan

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()

  try {
    // Recover recent episodes orphaned in `transcribing` by a run that claimed them but
    // never finished (crash, redeploy, OOM before after() completed). Bounded by the same
    // recent-episode window as candidate selection so the April→July backlog is never
    // touched. There is no dedicated claim-timestamp column, so each row's claim marker
    // (stored in error_message at claim time below) is parsed and compared against the
    // lease; only rows with no parseable marker (claimed before this marker existed) fall
    // back to created_at for one-time legacy recovery. A fresh marker always wins over
    // created_at, so a still-in-flight claim is never reclaimed out from under a
    // concurrent Whisper job.
    const { data: transcribingRows, error: transcribingFetchError } = await supabase
      .from('episodes')
      .select('id, created_at, error_message')
      .eq('status', 'transcribing')
      .gte('published_at', getRecentEpisodeCutoff())

    if (transcribingFetchError) {
      return NextResponse.json(
        { error: 'Failed to fetch transcribing episodes', details: transcribingFetchError.message },
        { status: 500 }
      )
    }

    const staleIds = (transcribingRows ?? [])
      .filter((row) => isStaleTranscribingRow({ errorMessage: row.error_message, createdAt: row.created_at }))
      .map((row) => row.id)

    let staleReset = 0
    if (staleIds.length > 0) {
      const { data: staleResetRows, error: staleResetError } = await supabase
        .from('episodes')
        .update({
          status: 'pending_transcription',
          error_message: 'Automatischer Reset: Transkriptions-Lease abgelaufen (verwaiste transcribing-Episode)',
        })
        .in('id', staleIds)
        .eq('status', 'transcribing')
        .select('id')

      if (staleResetError) {
        return NextResponse.json(
          { error: 'Failed to reset stale transcribing episodes', details: staleResetError.message },
          { status: 500 }
        )
      }

      staleReset = staleResetRows?.length ?? 0
    }

    // Fetch newest recent pending episode only. The date filter intentionally skips
    // the old April→July backlog after cron restoration so a stale timeout
    // cannot starve fresh daily episodes.
    const { data: candidates, error: fetchError } = await supabase
      .from('episodes')
      .select('id, audio_url, title, subscription_id, transcript')
      .eq('status', 'pending_transcription')
      .gte('published_at', getRecentEpisodeCutoff())
      .order('published_at', { ascending: false })
      .limit(1)

    if (fetchError) {
      return NextResponse.json(
        { error: 'Failed to fetch episodes', details: fetchError.message },
        { status: 500 }
      )
    }

    const candidate = candidates?.[0]
    if (!candidate) {
      return NextResponse.json(buildNoPendingResponse(staleReset))
    }

    // Claim before ack: status-guarded update so a parallel/overlapping cron run can't
    // claim the same episode. If the row didn't match (already claimed elsewhere),
    // `claimed` comes back empty and we ack "nothing to do" instead of double-processing.
    const { data: claimed, error: claimError } = await supabase
      .from('episodes')
      .update({ status: 'transcribing', error_message: buildClaimMarker() })
      .eq('id', candidate.id)
      .eq('status', 'pending_transcription')
      .select('id, audio_url, title, subscription_id, transcript')

    if (claimError) {
      return NextResponse.json(
        { error: 'Failed to claim episode', details: claimError.message },
        { status: 500 }
      )
    }

    const episode = claimed?.[0]
    if (!episode) {
      return NextResponse.json(buildNoPendingResponse(staleReset))
    }

    // Response semantics: this ack means "work accepted", not "work finished". The full
    // download + Whisper + DB update continues below via after() within the function's
    // remaining maxDuration budget, well past when this response has already been sent.
    after(async () => {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      await transcribeEpisode(supabase, openai, episode)
    })

    return NextResponse.json(buildAcceptedResponse(episode.id, staleReset), { status: 202 })
  } catch (err) {
    return NextResponse.json(
      { error: 'Transcription cron failed', details: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 }
    )
  }
}

interface Episode {
  id: string
  audio_url: string
  title: string
  subscription_id: string
  transcript: string | null
}

/**
 * Runs in the background (via after()). The episode has already been claimed
 * (status flipped pending_transcription -> transcribing) by the caller, so this
 * never needs to guess whether it's allowed to start work.
 */
async function transcribeEpisode(
  supabase: ReturnType<typeof createAdminClient>,
  openai: OpenAI,
  episode: Episode
): Promise<{ success: boolean }> {
  // Skip Whisper API if transcript already exists in DB
  if (episode.transcript && episode.transcript.trim().length > 0) {
    await supabase
      .from('episodes')
      .update({ status: 'transcribed', error_message: null })
      .eq('id', episode.id)
    return { success: true }
  }

  try {
    // Download audio. Timeout is generous relative to the old 20s cron-facing budget
    // because this now runs after the response was already sent, inside the
    // function's remaining maxDuration=60 window rather than cron-job.org's 30s one.
    const response = await fetch(episode.audio_url, {
      signal: AbortSignal.timeout(45_000),
    })

    if (!response.ok) {
      throw new PermanentError(`Audio nicht erreichbar (HTTP ${response.status})`)
    }

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (isTooLargeForWhisper(contentLength)) {
      throw new PermanentError(
        `Episode zu groß für Whisper (${Math.round(contentLength / 1024 / 1024)} MB, Max: ${Math.round(WHISPER_MAX_SIZE / 1024 / 1024)} MB). Kein Teiltranskript – Chunking ist ein separates Ticket.`
      )
    }

    // Read the full audio into a buffer. No truncation: either it fits Whisper's
    // limit and gets transcribed completely, or it's honestly marked failed.
    const audioBuffer = Buffer.from(await response.arrayBuffer())

    if (isTooLargeForWhisper(audioBuffer.length)) {
      throw new PermanentError(
        `Episode zu groß für Whisper (${Math.round(audioBuffer.length / 1024 / 1024)} MB, Max: ${Math.round(WHISPER_MAX_SIZE / 1024 / 1024)} MB). Kein Teiltranskript – Chunking ist ein separates Ticket.`
      )
    }

    // Determine file extension from URL or content-type
    const ext = getAudioExtension(episode.audio_url, response.headers.get('content-type'))
    const contentType = response.headers.get('content-type') || 'audio/mpeg'

    // Create a File object for OpenAI SDK from the complete audio buffer
    const file = new File([audioBuffer], `episode.${ext}`, {
      type: contentType,
    })

    // Send to Whisper API
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    })

    const transcript = typeof transcription === 'string' ? transcription : String(transcription)

    if (!transcript || transcript.trim().length === 0) {
      throw new PermanentError('Keine Sprache erkannt – die Episode enthält möglicherweise nur Musik')
    }

    // Save full transcript
    await supabase
      .from('episodes')
      .update({
        status: 'transcribed',
        transcript,
        error_message: null,
      })
      .eq('id', episode.id)

    return { success: true }
  } catch (err) {
    const isPermanent = err instanceof PermanentError

    if (isPermanent) {
      // Permanent failure – mark as failed
      await supabase
        .from('episodes')
        .update({
          status: 'failed',
          error_message: err.message,
        })
        .eq('id', episode.id)
    } else {
      // Temporary failure (rate limit, network) – reset to pending for retry
      const message = err instanceof Error ? err.message : 'Unknown error'
      await supabase
        .from('episodes')
        .update({
          status: 'pending_transcription',
          error_message: `Temporärer Fehler: ${message}`,
        })
        .eq('id', episode.id)
    }

    return { success: false }
  }
}

/** Determine audio file extension from URL or content-type */
function getAudioExtension(url: string, contentType: string | null): string {
  // Try URL extension first
  const urlExt = url.split('?')[0].split('.').pop()?.toLowerCase()
  if (urlExt && ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'webm', 'mp4'].includes(urlExt)) {
    return urlExt
  }

  // Fallback to content-type
  const typeMap: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  }

  if (contentType) {
    const baseType = contentType.split(';')[0].trim()
    if (typeMap[baseType]) return typeMap[baseType]
  }

  return 'mp3' // Default
}

/** Error class for permanent failures that should not be retried */
class PermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentError'
  }
}
