import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

// Example issue on the landing page (Claude-Design prototype); marketing illustration only.
const PREVIEW_ITEMS = [
  { kind: 'previewItem1Kind', source: 'previewItem1Source', title: 'previewItem1Title', initials: 'AI', color: '#3B2F4A' },
  { kind: 'previewItem2Kind', source: 'previewItem2Source', title: 'previewItem2Title', initials: 'JI', color: '#7A3B2E' },
  { kind: 'previewItem3Kind', source: 'previewItem3Source', title: 'previewItem3Title', initials: 'SP', color: '#C8102E' },
] as const

const STEPS = [
  { number: '01', title: 'step1Title', description: 'step1Description' },
  { number: '02', title: 'step2Title', description: 'step2Description' },
  { number: '03', title: 'step3Title', description: 'step3Description' },
] as const

const SOURCE_TYPES = ['sourcePodcasts', 'sourceYoutube', 'sourceRss', 'sourceSocial'] as const

export default async function Home() {
  const t = await getTranslations('landing')

  return (
    <div className="flex flex-1 flex-col bg-white">
      <section className="mx-auto grid w-full max-w-[1160px] items-center gap-16 px-7 pb-[88px] pt-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))]">
        <div className="flex flex-col gap-7">
          <div className="inline-flex items-center gap-2 self-start rounded-full border border-castle-line py-1.5 pl-2 pr-3 font-mono text-xs uppercase tracking-[0.04em] text-castle-muted">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-castle-amber" />
            {t('badge')}
          </div>
          <h1 className="m-0 text-[clamp(44px,6vw,72px)] font-semibold leading-[0.98] tracking-[-0.045em] [text-wrap:balance]">
            {t('heroTitle')}{' '}
            <span className="font-serif font-normal italic tracking-[-0.02em]">{t('heroTitleAccent')}</span>
          </h1>
          <p className="m-0 max-w-[30em] text-[19px] leading-normal text-castle-text [text-wrap:pretty]">{t('heroDescription')}</p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register"
              className="rounded-[10px] bg-castle-ink px-6 py-[15px] text-base font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.15),0_6px_20px_-8px_rgba(6,47,62,.6)] transition-colors hover:bg-castle-ink-hover"
            >
              {t('ctaStart')}
            </Link>
            <a
              href="#beispiel"
              className="rounded-[10px] border border-castle-input bg-white px-6 py-[15px] text-base font-medium text-castle-ink transition-colors hover:border-castle-ink"
            >
              {t('ctaPreview')}
            </a>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-sm text-castle-muted" aria-label={t('sourceTypesLabel')}>
            {SOURCE_TYPES.map((key, index) => (
              <li key={key} className="flex gap-5">
                {index > 0 && <span aria-hidden="true" className="text-[#C3CDD0]">/</span>}
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Example issue */}
        <figure id="beispiel" aria-label={t('previewLabel')} className="relative m-0 scroll-mt-6">
          <div aria-hidden="true" className="absolute inset-[24px_-12px_-16px_24px] rounded-[18px] bg-castle-mist" />
          <div className="relative overflow-hidden rounded-2xl border border-castle-line bg-white shadow-[0_24px_60px_-30px_rgba(6,47,62,.35)]">
            <div className="flex items-center justify-between gap-3 border-b border-castle-line-soft px-[22px] py-4 text-[13px] text-castle-muted">
              <span><strong className="font-semibold text-castle-ink">{t('previewFrom')}</strong> &lt;{t('previewFromEmail')}&gt;</span>
              <span className="font-mono text-xs">{t('previewTime')}</span>
            </div>
            <div className="px-[26px] pb-2.5 pt-[26px]">
              <div className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-castle-muted">{t('previewDate')}</div>
              <h2 className="mb-3 mt-2.5 font-serif text-[30px] font-medium leading-[1.1] tracking-[-0.015em]">{t('previewTitle')}</h2>
              <p className="m-0 text-[14.5px] leading-relaxed text-castle-text">{t('previewIntro')}</p>
            </div>
            <ul className="m-0 flex list-none flex-col px-[26px] pb-6 pt-2.5">
              {PREVIEW_ITEMS.map((item) => (
                <li key={item.initials} className="flex items-start gap-3.5 border-t border-castle-line-soft py-3.5">
                  <span
                    aria-hidden="true"
                    className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-lg text-xs font-semibold text-white"
                    style={{ background: item.color }}
                  >
                    {item.initials}
                  </span>
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-castle-subtle">{t(item.kind)} · {t(item.source)}</span>
                    <span className="text-[14.5px] font-medium leading-[1.35]">{t(item.title)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </figure>
      </section>

      <section aria-label={t('stepsLabel')} className="border-y border-[#EAEEEE] bg-castle-paper">
        <ol className="m-0 mx-auto grid max-w-[1160px] list-none gap-10 px-7 py-[72px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))]">
          {STEPS.map((step) => (
            <li key={step.number} className="flex flex-col gap-3">
              <span aria-hidden="true" className="font-mono text-[13px] text-castle-amber-deep">{step.number}</span>
              <h3 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t(step.title)}</h3>
              <p className="m-0 text-base leading-[1.55] text-castle-text">{t(step.description)}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
