import { NextRequest, NextResponse } from 'next/server'
import Parser from 'rss-parser'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkAllFeeds } from '@/lib/feeds/check-feeds.mjs'

const parser = new Parser()

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The Docker worker runs the feed check once this is set.
  if (process.env.FEED_CHECK_CRON_DISABLED === 'true') {
    return NextResponse.json({ success: true, disabled: true, message: 'Feed check cron disabled (handled by worker)' })
  }

  try {
    const summary = await checkAllFeeds({
      supabase: createAdminClient(),
      parseXml: (xml: string) => parser.parseString(xml),
    })
    return NextResponse.json({ success: true, ...summary })
  } catch (err) {
    return NextResponse.json(
      { error: 'Cron job failed', details: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
