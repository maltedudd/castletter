import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { z } from 'zod'

const ADMIN_EMAIL = 'malte.dudd@gmail.com'

const RegisterSchema = z.object({
  email: z.string().email('Ungültige Email-Adresse'),
})

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Ungültiger Request-Body' }, { status: 400 })
  }

  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ungültige Email-Adresse' },
      { status: 400 }
    )
  }

  const { email } = parsed.data
  const supabase = createAdminClient()

  const { error } = await supabase
    .from('beta_requests')
    .insert({ email, status: 'pending' })

  if (error) {
    // Unique constraint violation → email already registered
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Du bist bereits auf der Warteliste' },
        { status: 409 }
      )
    }
    console.error('beta_requests insert error:', error)
    return NextResponse.json(
      { error: 'Ein Fehler ist aufgetreten. Bitte versuche es erneut.' },
      { status: 500 }
    )
  }

  // Send admin notification (fire-and-forget, don't block response)
  try {
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'Castletter <newsletter@castletter.app>',
      to: ADMIN_EMAIL,
      subject: `Neue Beta-Anfrage: ${email}`,
      text: `${email} hat sich für die Castletter-Beta eingetragen.\n\nZum Admin-Bereich: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/admin`,
    })
  } catch (err) {
    console.error('Admin notification email failed:', err)
  }

  return NextResponse.json({ success: true }, { status: 200 })
}
