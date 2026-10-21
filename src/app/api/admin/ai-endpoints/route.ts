import { NextRequest, NextResponse } from 'next/server'
import { getAdminUser } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { resetEndpoint, saveEndpoint } from '@/lib/ai/endpoint-admin.mjs'
import { parseEndpointBody } from './schema'

// NIAS-59: save (PUT) or reset (DELETE ?purpose=&slot=) the AI endpoint of one purpose and
// slot (NIAS-62: 'primary', default, or 'fallback'). Resetting the primary returns to the
// environment default, resetting the fallback removes it. Admins only; API keys are encrypted
// server-side and never returned.

export async function PUT(request: NextRequest) {
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = await parseEndpointBody(request)
  if (!body) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 })
  }
  const result = await saveEndpoint(createAdminClient(), body)
  if (!result.ok) {
    return NextResponse.json({ error: result.code, fields: result.fields }, { status: result.status })
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { searchParams } = request.nextUrl
  const result = await resetEndpoint(createAdminClient(), searchParams.get('purpose'), searchParams.get('slot') ?? 'primary')
  if (!result.ok) {
    return NextResponse.json({ error: result.code, fields: result.fields }, { status: result.status })
  }
  return NextResponse.json({ success: true })
}
