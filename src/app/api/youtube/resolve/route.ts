import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveYouTubeChannel, YouTubeChannelError } from '@/lib/youtube/channel.mjs'

const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  channel_not_found: 404,
  feed_unavailable: 422,
}

/**
 * Resolves a YouTube channel ID, channel URL or @handle to its stable channel ID plus title
 * and feed URL, so only resolved IDs are ever stored as sources. Only fixed youtube.com URLs
 * are fetched (see resolveYouTubeChannel), never the entered host.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Nicht autorisiert' }, { status: 401 })
  }

  let input: unknown
  try {
    input = (await request.json())?.input
  } catch {
    return NextResponse.json({ error: 'Ungültiger Request-Body' }, { status: 400 })
  }
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 500) {
    return NextResponse.json({ error: 'Bitte gib eine Channel-ID, Kanal-URL oder ein @Handle ein', code: 'invalid_input' }, { status: 400 })
  }

  try {
    const channel = await resolveYouTubeChannel({ input })
    return NextResponse.json(channel)
  } catch (err) {
    if (err instanceof YouTubeChannelError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS_BY_CODE[err.code] ?? 422 })
    }
    return NextResponse.json(
      { error: 'YouTube ist gerade nicht erreichbar – bitte versuche es erneut', code: 'youtube_unreachable' },
      { status: 502 }
    )
  }
}
