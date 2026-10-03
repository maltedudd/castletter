import { NextRequest, NextResponse, after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import { getOpenRouterConfig } from '@/lib/cron/openrouter-config.mjs'
import {
  buildAcceptedResponse,
  buildNoPendingResponse,
  buildDisabledResponse,
  buildClaimMarker,
  isStaleTranscribingRow,
  resetStaleTranscribingRows,
} from '@/lib/cron/transcribe-ack.mjs'
import {
  PermanentError,
  createOpenRouterChunkTranscriber,
  transcribeAudioFromUrl,
} from '@/lib/transcription/audio-transcriber.mjs'
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

  // The Docker transcription worker replaces this route; once it is live, this switch
  // keeps an accidental cron call from claiming episodes and timing out at maxDuration.
  if (process.env.TRANSCRIPTION_CRON_DISABLED === 'true') {
    return NextResponse.json(buildDisabledResponse())
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

    const staleRows = (transcribingRows ?? [])
      .filter((row) => isStaleTranscribingRow({ errorMessage: row.error_message, createdAt: row.created_at }))
      .map((row) => ({ id: row.id, errorMessage: row.error_message }))

    // Reset as a compare-and-swap on the exact marker read above (see
    // resetStaleTranscribingRows), not just id+status. Two overlapping cron runs can both
    // read the same orphaned row before either writes; an id+status-only update would let a
    // later run wipe out an earlier run's fresh reclaim (ABA race).
    let staleReset = 0
    if (staleRows.length > 0) {
      const { staleReset: resetCount, error: staleResetError } = await resetStaleTranscribingRows(
        supabase,
        staleRows,
        'Automatischer Reset: Transkriptions-Lease abgelaufen (verwaiste transcribing-Episode)'
      )

      if (staleResetError) {
        return NextResponse.json(
          { error: 'Failed to reset stale transcribing episodes', details: staleResetError.message },
          { status: 500 }
        )
      }

      staleReset = resetCount
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
      const openrouterConfig = getOpenRouterConfig()
      const openrouter = new OpenAI(openrouterConfig.client)
      await transcribeEpisode(supabase, openrouter, openrouterConfig.transcriptionModel, episode)
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
  openrouter: OpenAI,
  model: string,
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
    // Download + ordered chunk transcription + join; rejects instead of returning a
    // partial transcript. Runs inside the function's remaining maxDuration window.
    const transcript = await transcribeAudioFromUrl({
      audioUrl: episode.audio_url,
      transcribeChunk: createOpenRouterChunkTranscriber(openrouter, model),
    })

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
