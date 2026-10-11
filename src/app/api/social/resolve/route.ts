import { NextRequest, NextResponse } from 'next/server'
import { lookup } from 'node:dns/promises'
import Parser from 'rss-parser'
import { createClient } from '@/lib/supabase/server'
import { MASTODON_RSS_CUSTOM_FIELDS } from '@/lib/social/mastodon.mjs'
import { resolveSocialAccount } from '@/lib/social/platforms.mjs'

const parser = new Parser({ customFields: MASTODON_RSS_CUSTOM_FIELDS })

/**
 * Resolves a Mastodon profile (URL or @user@instance) or a Bluesky profile (bsky.app URL, handle
 * or DID) for the "add source" preview: the platform's public API without login, the profile's
 * RSS feed as fallback. Errors are translation keys (`errorKey`). Only public hosts are fetched
 * (hostname + DNS check per redirect).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ errorKey: 'errorUnauthorized' }, { status: 401 })
  }

  let input: unknown
  try {
    input = (await request.json())?.input
  } catch {
    return NextResponse.json({ errorKey: 'socialErrorInvalidInput' }, { status: 400 })
  }

  const result = await resolveSocialAccount({ input, lookup, parseXml: (xml: string) => parser.parseString(xml) })
  if (!result.ok) {
    return NextResponse.json({ errorKey: result.errorKey }, { status: result.status })
  }
  return NextResponse.json(result.preview)
}
