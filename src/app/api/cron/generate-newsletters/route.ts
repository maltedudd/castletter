import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import { getOpenRouterConfig } from '@/lib/cron/openrouter-config.mjs'
import { generateNewsletterForEpisode, getPodcastRef } from '@/lib/newsletter/generate.mjs'
import { deliverImmediatelyIfWanted } from '@/lib/newsletter/delivery.mjs'
import { createResendMailer } from '@/lib/newsletter/send'

export const maxDuration = 60 // Vercel Hobby plan

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The Docker worker runs the newsletter pipeline once this is set.
  if (process.env.NEWSLETTER_CRON_DISABLED === 'true') {
    return NextResponse.json({ success: true, disabled: true, message: 'Newsletter cron disabled (handled by worker)' })
  }

  const supabase = createAdminClient()
  const openrouterConfig = getOpenRouterConfig()
  const openrouter = new OpenAI(openrouterConfig.client)
  const sendEmail = createResendMailer(new Resend(process.env.RESEND_API_KEY))

  let generated = 0
  let failed = 0
  let sentImmediately = 0

  try {
    // Fetch recent transcribed episodes only. This prevents any stale backlog
    // item from turning into a delayed newsletter when cron processing resumes.
    const { data: episodes, error: fetchError } = await supabase
      .from('episodes')
      .select(`
        id, title, transcript, audio_url, subscription_id,
        podcast_subscriptions!inner(title, user_id)
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
      const outcome = await generateNewsletterForEpisode({
        supabase,
        openrouter,
        model: openrouterConfig.newsletterModel,
        episode,
      })
      if (outcome !== 'ready') {
        if (outcome !== 'lost_race') failed++
        continue
      }
      generated++

      // Users who chose immediate delivery get this episode right away. A failure here
      // leaves the episode `newsletter_ready`; the send cron retries it.
      try {
        sentImmediately += await deliverImmediatelyIfWanted({
          supabase,
          userId: getPodcastRef(episode)?.user_id,
          episodeId: episode.id,
          sendEmail,
          recentCutoff: getRecentEpisodeCutoff(),
        })
      } catch (err) {
        console.error(`Immediate newsletter for episode ${episode.id} failed:`, err instanceof Error ? err.message : err)
      }
    }

    return NextResponse.json({ success: true, generated, failed, sentImmediately })
  } catch (err) {
    return NextResponse.json(
      { error: 'Newsletter generation failed', details: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 }
    )
  }
}
