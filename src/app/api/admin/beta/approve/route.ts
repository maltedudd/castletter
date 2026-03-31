import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const ADMIN_EMAIL = 'malte.dudd@gmail.com'

const ApproveSchema = z.object({
  email: z.string().email(),
})

export async function POST(request: Request) {
  // Auth check: only the admin may call this
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Ungültiger Request-Body' }, { status: 400 })
  }

  const parsed = ApproveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ungültige Email-Adresse' }, { status: 400 })
  }

  const { email } = parsed.data
  const admin = createAdminClient()

  // Send invite email via Supabase Auth Admin API
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email)
  if (inviteError) {
    // User might already exist — treat as non-fatal if status code is 422
    if (!inviteError.message.includes('already been registered')) {
      console.error('inviteUserByEmail error:', inviteError)
      return NextResponse.json(
        { error: `Invite fehlgeschlagen: ${inviteError.message}` },
        { status: 500 }
      )
    }
  }

  // Update beta_requests status
  const { error: updateError } = await admin
    .from('beta_requests')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('email', email)

  if (updateError) {
    console.error('beta_requests update error:', updateError)
    return NextResponse.json(
      { error: 'Status-Update fehlgeschlagen' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
