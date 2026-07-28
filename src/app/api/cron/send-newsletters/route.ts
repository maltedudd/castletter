import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmailHTML, generateEmailPlainText } from '@/lib/email/template'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'

const MAX_USERS_PER_RUN = 100
const FROM_EMAIL = process.env.FROM_EMAIL || 'Castletter <newsletter@castletter.app>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const resend = new Resend(process.env.RESEND_API_KEY)

  const currentHourUTC = new Date().getUTCHours()
  let emailsSent = 0
  let errors = 0
  const errorDetails: string[] = []

  try {
    // Find users whose delivery hour matches the current UTC hour
    const { data: users, error: userError } = await supabase
      .from('user_settings')
      .select('user_id, newsletter_email')
      .eq('newsletter_delivery_hour', currentHourUTC)
      .limit(MAX_USERS_PER_RUN)

    if (userError || !users) {
      return NextResponse.json(
        { error: 'Failed to fetch users', details: userError?.message },
        { status: 500 }
      )
    }

    if (users.length === 0) {
      return NextResponse.json({
        success: true,
        currentHourUTC,
        emailsSent: 0,
        message: 'No users scheduled for this hour',
      })
    }

    // Process each user
    for (const user of users) {
      try {
        const sent = await sendUserNewsletter(supabase, resend, user)
        if (sent) emailsSent++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown'
        console.error(`Failed to send newsletter to ${user.newsletter_email}:`, msg)
        errorDetails.push(msg)
        errors++
      }
    }

    return NextResponse.json({
      success: true,
      currentHourUTC,
      usersChecked: users.length,
      emailsSent,
      errors,
      ...(errorDetails.length > 0 && { errorDetails }),
    })
  } catch (err) {
    return NextResponse.json(
      { error: 'Send newsletters failed', details: err instanceof Error ? err.message : 'Unknown' },
      { status: 500 }
    )
  }
}

interface UserSettings {
  user_id: string
  newsletter_email: string
}

/** Send newsletter digest email to a single user. Returns true if email was sent. */
async function sendUserNewsletter(
  supabase: ReturnType<typeof createAdminClient>,
  resend: Resend,
  user: UserSettings
): Promise<boolean> {
  // Get all user's subscriptions
  const { data: subscriptions } = await supabase
    .from('podcast_subscriptions')
    .select('id, title')
    .eq('user_id', user.user_id)

  if (!subscriptions || subscriptions.length === 0) return false

  const subscriptionIds = subscriptions.map((s) => s.id)
  const subscriptionMap = new Map(subscriptions.map((s) => [s.id, s.title]))

  // Get recent newsletter_ready episodes for this user's subscriptions.
  // This prevents old backlog items from being mailed when cron processing resumes.
  const { data: episodes } = await supabase
    .from('episodes')
    .select(`
      id, title, audio_url, subscription_id,
      episode_newsletters!inner(intro, bullet_points, key_takeaways, action_items, quotes, speakers, reflection)
    `)
    .eq('status', 'newsletter_ready')
    .gte('published_at', getRecentEpisodeCutoff())
    .in('subscription_id', subscriptionIds)

  if (!episodes || episodes.length === 0) return false

  // Build newsletter items
  const newsletterItems = episodes.map((ep) => {
    const newsletter = Array.isArray(ep.episode_newsletters)
      ? ep.episode_newsletters[0]
      : ep.episode_newsletters

    return {
      podcastTitle: subscriptionMap.get(ep.subscription_id) || 'Podcast',
      episodeTitle: ep.title,
      intro: newsletter?.intro || '',
      bulletPoints: (newsletter?.bullet_points || []) as string[],
      keyTakeaways: (newsletter?.key_takeaways || []) as string[],
      actionItems: (newsletter?.action_items || []) as string[],
      quotes: (newsletter?.quotes || []) as string[],
      speakers: (newsletter?.speakers || []) as string[],
      reflection: (newsletter?.reflection as string) || null,
      audioUrl: ep.audio_url,
    }
  })

  const settingsUrl = `${APP_URL}/settings`

  // Generate email content
  const html = generateEmailHTML(user.newsletter_email, newsletterItems, settingsUrl)
  const text = generateEmailPlainText(newsletterItems, settingsUrl)

  // Send email via Resend
  const { error: sendError } = await resend.emails.send({
    from: FROM_EMAIL,
    to: user.newsletter_email,
    subject: `Deine neuen Podcast-Updates (${newsletterItems.length} ${newsletterItems.length === 1 ? 'Episode' : 'Episoden'})`,
    html,
    text,
  })

  if (sendError) {
    throw new Error(`Resend error: ${sendError.message}`)
  }

  // Mark episodes as sent
  const episodeIds = episodes.map((ep) => ep.id)
  await supabase
    .from('episodes')
    .update({
      status: 'newsletter_sent',
      newsletter_sent_at: new Date().toISOString(),
    })
    .in('id', episodeIds)

  return true
}
