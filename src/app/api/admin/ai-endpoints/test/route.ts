import { NextRequest, NextResponse } from 'next/server'
import { getAdminUser } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { testEndpointConnection } from '@/lib/ai/endpoint-admin.mjs'
import { parseEndpointBody } from '../schema'

// NIAS-59: server-side connection test of the entered endpoint (GET <baseUrl>/models).
// The result never contains the API key.

export async function POST(request: NextRequest) {
  if (!(await getAdminUser())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = await parseEndpointBody(request)
  if (!body) {
    return NextResponse.json({ error: 'invalid' }, { status: 400 })
  }
  return NextResponse.json(await testEndpointConnection(createAdminClient(), body))
}
