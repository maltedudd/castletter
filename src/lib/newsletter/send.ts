// Wires the dependency-free delivery logic to Resend and the email template.
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateEmailHTML, generateEmailPlainText } from '@/lib/email/template'
import { getRecentEpisodeCutoff } from '@/lib/cron/recent-episodes.mjs'
import { sendNewsletterToUser } from '@/lib/newsletter/delivery.mjs'

const FROM_EMAIL = process.env.FROM_EMAIL || 'Castletter <newsletter@castletter.app>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

export type DeliveryMode = 'daily' | 'immediate'

export interface NewsletterRecipient {
  user_id: string
  newsletter_email: string
  newsletter_delivery_mode: DeliveryMode | null
}

type NewsletterItem = Parameters<typeof generateEmailPlainText>[0][number]

export function createResendMailer(resend: Resend) {
  const settingsUrl = `${APP_URL}/settings`

  return async function sendEmail({ to, subject, items }: { to: string; subject: string; items: NewsletterItem[] }) {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html: generateEmailHTML(to, items, settingsUrl),
      text: generateEmailPlainText(items, settingsUrl),
    })
    if (error) {
      throw new Error(`Resend error: ${error.message}`)
    }
  }
}

/** Sends a user's ready newsletters per their delivery mode (see delivery.mjs). */
export function deliverNewsletters(
  supabase: ReturnType<typeof createAdminClient>,
  resend: Resend,
  user: NewsletterRecipient,
  episodeIds?: string[]
): Promise<{ mailsSent: number; episodesSent: number }> {
  return sendNewsletterToUser({
    supabase,
    user,
    sendEmail: createResendMailer(resend),
    recentCutoff: getRecentEpisodeCutoff(),
    episodeIds,
  })
}
