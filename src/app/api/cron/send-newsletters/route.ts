import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDailyDigestDue, resetStaleSendingEpisodes } from '@/lib/newsletter/delivery.mjs'
import { deliverNewsletters, type NewsletterRecipient } from '@/lib/newsletter/send'

const MAX_USERS_PER_RUN = 100

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
  const resend = new Resend(process.env.RESEND_API_KEY)

  const currentHourUTC = new Date().getUTCHours()
  let emailsSent = 0
  let errors = 0
  const errorDetails: string[] = []

  try {
    // Hand back claims of runs that died between claiming and sending.
    const staleSendingReset = await resetStaleSendingEpisodes(supabase)

    // Every user: episodes of immediate podcasts (fallback for sends the generate cron could
    // not make), plus the daily digest when their delivery hour matches the current UTC hour.
    const { data: users, error: userError } = await supabase
      .from('user_settings')
      .select('user_id, newsletter_email, newsletter_delivery_hour')
      .limit(MAX_USERS_PER_RUN)

    if (userError || !users) {
      return NextResponse.json(
        { error: 'Failed to fetch users', details: userError?.message },
        { status: 500 }
      )
    }

    // Process each user
    for (const user of users) {
      try {
        const { mailsSent } = await deliverNewsletters(supabase, resend, user as NewsletterRecipient, {
          includeDaily: isDailyDigestDue(user, currentHourUTC),
        })
        emailsSent += mailsSent
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
      staleSendingReset,
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
