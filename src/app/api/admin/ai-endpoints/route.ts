import { NextRequest, NextResponse } from 'next/server'
import { getAdminUser } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { resetEndpoint, saveEndpoint } from '@/lib/ai/endpoint-admin.mjs'
import { parseEndpointBody } from './schema'

// NIAS-59: save (PUT) or reset to the environment default (DELETE ?purpose=) the AI endpoint
// of one purpose. Admins only; API keys are encrypted server-side and never returned.

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
  const result = await resetEndpoint(createAdminClient(), request.nextUrl.searchParams.get('purpose'))
  if (!result.ok) {
    return NextResponse.json({ error: result.code, fields: result.fields }, { status: result.status })
  }
  return NextResponse.json({ success: true })
}
