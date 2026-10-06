import { NextRequest, NextResponse } from 'next/server'
import { lookup } from 'node:dns/promises'
import Parser from 'rss-parser'
import { createClient } from '@/lib/supabase/server'
import { validateWebsiteFeed } from '@/lib/websites/validate.mjs'

// Atom feeds carry their description and image in <subtitle>/<logo>/<icon>.
const parser = new Parser({ customFields: { feed: ['subtitle', 'logo', 'icon'] } })

/**
 * Validates a Website (RSS) source: a public RSS/Atom feed URL or a web page that advertises
 * one. Errors are translation keys (`errorKey`), for podcast or YouTube input together with the
 * `suggestedType` to switch to. Only public hosts are fetched (hostname + DNS check per redirect).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ errorKey: 'errorUnauthorized' }, { status: 401 })
  }

  let input: unknown
  try {
    input = (await request.json())?.url
  } catch {
    return NextResponse.json({ errorKey: 'websiteErrorInvalidUrl' }, { status: 400 })
  }

  const result = await validateWebsiteFeed({ input, lookup, parseXml: (xml: string) => parser.parseString(xml) })
  if (!result.ok) {
    const { status, errorKey, suggestedType } = result
    return NextResponse.json(suggestedType ? { errorKey, suggestedType } : { errorKey }, { status })
  }
  return NextResponse.json(result.preview)
}
