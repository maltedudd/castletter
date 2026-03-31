import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const ADMIN_EMAIL = 'malte.dudd@gmail.com'

const RejectSchema = z.object({
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

  const parsed = RejectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ungültige Email-Adresse' }, { status: 400 })
  }

  const { email } = parsed.data
  const admin = createAdminClient()

  const { error } = await admin
    .from('beta_requests')
    .update({ status: 'rejected' })
    .eq('email', email)

  if (error) {
    console.error('beta_requests update error:', error)
    return NextResponse.json(
      { error: 'Status-Update fehlgeschlagen' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
