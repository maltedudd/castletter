import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { generateEmailHTML } from '@/lib/email/template.mjs'
import { sampleIssue } from '@/lib/newsletter/sample.mjs'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('sample')
  return { title: `${t('title')} · Castletter` }
}

/** Origin of this request, so the sample mail loads the logo mark from the same deployment. */
async function requestOrigin() {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

/** The content of the generated mail's <body>; the mail styles are all inline. */
function mailBody(html: string) {
  const start = html.indexOf('>', html.indexOf('<body')) + 1
  return html.slice(start, html.lastIndexOf('</body>'))
}

/** Public sample issue: the real mail template, filled with invented content. */
export default async function SampleIssuePage() {
  const t = await getTranslations('sample')
  const locale = (await getLocale()) === 'en' ? 'en' : 'de'
  const { items, overview } = sampleIssue(locale)
  const html = generateEmailHTML(t('recipient'), items, `${await requestOrigin()}/settings`, locale, 'daily', overview)

  return (
    <div className="flex flex-1 flex-col bg-castle-paper">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-6 px-4 pb-20 pt-11 sm:px-6">
        <div className="flex flex-col gap-2 px-2">
          <span className="font-mono text-xs uppercase tracking-[0.06em] text-castle-subtle">{t('eyebrow')}</span>
          <h1 className="m-0 text-[34px] font-semibold leading-tight tracking-[-0.04em]">{t('title')}</h1>
          <p className="m-0 text-base text-castle-muted">{t('description')}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Link href="/register" className="rounded-[10px] bg-castle-ink px-5 py-3 text-[15px] font-medium text-white hover:bg-castle-ink-hover">
              {t('cta')}
            </Link>
            <Link href="/" className="rounded-[10px] border border-castle-input bg-white px-5 py-3 text-[15px] font-medium text-castle-ink hover:border-castle-ink">
              {t('back')}
            </Link>
          </div>
        </div>
        <section aria-label={t('mailLabel')} className="-mx-3 sm:mx-0" dangerouslySetInnerHTML={{ __html: mailBody(html) }} />
      </div>
    </div>
  )
}
