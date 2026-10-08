// Wires the dependency-free delivery logic to Resend and the email template.
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmailHTML, generateEmailPlainText } from '@/lib/email/template.mjs'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import { sendNewsletterToUser } from '@/lib/newsletter/delivery.mjs'

const FROM_EMAIL = process.env.FROM_EMAIL || 'castletter.io <newsletter@castletter.io>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

export interface NewsletterRecipient {
  user_id: string
  newsletter_email: string
}

type NewsletterItem = Parameters<typeof generateEmailPlainText>[0][number]
type DigestOverview = Parameters<typeof generateEmailPlainText>[4]

export function createResendMailer(resend: Resend) {
  const settingsUrl = `${APP_URL}/settings`

  return async function sendEmail({
    to,
    subject,
    items,
    mode,
    overview = null,
  }: {
    to: string
    subject: string
    items: NewsletterItem[]
    mode: 'daily' | 'immediate'
    overview?: DigestOverview
  }) {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html: generateEmailHTML(to, items, settingsUrl, 'de', mode, overview),
      text: generateEmailPlainText(items, settingsUrl, 'de', mode, overview),
    })
    if (error) {
      throw new Error(`Resend error: ${error.message}`)
    }
  }
}

/**
 * Sends a user's ready newsletters per podcast delivery mode (see delivery.mjs). This Vercel
 * fallback sorts and groups the digest but creates no AI overview: the model call would not
 * fit its time limit, and the Docker worker (which does create it) handles delivery.
 */
export function deliverNewsletters(
  supabase: ReturnType<typeof createAdminClient>,
  resend: Resend,
  user: NewsletterRecipient,
  { includeDaily }: { includeDaily: boolean }
): Promise<{ mailsSent: number; episodesSent: number }> {
  return sendNewsletterToUser({
    supabase,
    user,
    sendEmail: createResendMailer(resend),
    recentCutoff: getRecentEpisodeCutoff(),
    includeDaily,
  })
}
