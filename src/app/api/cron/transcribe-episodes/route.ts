import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import OpenAI from 'openai'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const WHISPER_MAX_SIZE = 25 * 1024 * 1024 // 25 MB (Whisper API limit)
const TRUNCATE_SIZE = 10 * 1024 * 1024 // 10 MB (fits within 60s timeout)
const BATCH_SIZE = 1 // Process 1 episode per run (Hobby plan: 60s limit)

export const maxDuration = 60 // Vercel Hobby plan

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  let transcribed = 0
  let failed = 0

  try {
    // Fetch pending episodes
    const { data: episodes, error: fetchError } = await supabase
      .from('episodes')
      .select('id, audio_url, title, subscription_id, transcript')
      .eq('status', 'pending_transcription')
      .order('published_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (fetchError || !episodes) {
      return NextResponse.json(
        { error: 'Failed to fetch episodes', details: fetchError?.message },
        { status: 500 }
      )
    }

    if (episodes.length === 0) {
      return NextResponse.json({ success: true, transcribed: 0, failed: 0, message: 'No pending episodes' })
    }

    // Process one at a time (60s timeout on Hobby plan)
    for (const ep of episodes) {
      const result = await transcribeEpisode(supabase, openai, ep)
      if (result.success) transcribed++
      else failed++
    }

    return NextResponse.json({ success: true, transcribed, failed })
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

  // Mark as transcribing
  await supabase
    .from('episodes')
    .update({ status: 'transcribing' })
    .eq('id', episode.id)

  try {
    // Download audio with size check
    const response = await fetch(episode.audio_url, {
      signal: AbortSignal.timeout(20_000), // 20s download timeout (60s total budget)
    })

    if (!response.ok) {
      throw new PermanentError(`Audio nicht erreichbar (HTTP ${response.status})`)
    }

    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > MAX_FILE_SIZE) {
      throw new PermanentError(`Episode zu groß zum Transkribieren (${Math.round(contentLength / 1024 / 1024)} MB, Max: 500 MB)`)
    }

    // Read the audio into a buffer
    const audioBuffer = Buffer.from(await response.arrayBuffer())

    if (audioBuffer.length > MAX_FILE_SIZE) {
      throw new PermanentError(`Episode zu groß zum Transkribieren (${Math.round(audioBuffer.length / 1024 / 1024)} MB, Max: 500 MB)`)
    }

    // Determine file extension from URL or content-type
    const ext = getAudioExtension(episode.audio_url, response.headers.get('content-type'))
    const contentType = response.headers.get('content-type') || 'audio/mpeg'

    // Truncate to fit within 60s function timeout
    // 10MB keeps download + Whisper API within budget
    let whisperBuffer = audioBuffer
    let isPartial = false
    if (audioBuffer.length > TRUNCATE_SIZE) {
      whisperBuffer = audioBuffer.subarray(0, TRUNCATE_SIZE)
      isPartial = true
    }

    // Create a File object for OpenAI SDK
    const file = new File([whisperBuffer], `episode.${ext}`, {
      type: contentType,
    })

    // Send to Whisper API
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'text',
    })

    let transcript = typeof transcription === 'string' ? transcription : String(transcription)

    if (!transcript || transcript.trim().length === 0) {
      throw new PermanentError('Keine Sprache erkannt – die Episode enthält möglicherweise nur Musik')
    }

    if (isPartial) {
      const pctTranscribed = Math.round((whisperBuffer.length / audioBuffer.length) * 100)
      transcript += `\n\n[Hinweis: Transkript enthält ca. ${pctTranscribed}% der Episode (${Math.round(audioBuffer.length / 1024 / 1024)} MB Original, ${Math.round(whisperBuffer.length / 1024 / 1024)} MB transkribiert)]`
    }

    // Save transcript
    await supabase
      .from('episodes')
      .update({
        status: 'transcribed',
        transcript,
        error_message: isPartial ? 'Teiltranskript (Audio > 25MB)' : null,
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
