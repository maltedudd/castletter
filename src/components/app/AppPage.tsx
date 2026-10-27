'use client'

// Shared building blocks of the signed-in pages (Claude-Design prototype).

import { useTranslations } from 'next-intl'

export function AppPage({ children, narrow = false }: { children: React.ReactNode; narrow?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[1080px] flex-1 px-6 pb-20 pt-11">
      <div className={`flex flex-col gap-7 ${narrow ? 'max-w-[760px]' : ''}`}>{children}</div>
    </div>
  )
}

export function PageHeading({ title, description, eyebrow, aside }: {
  title: React.ReactNode
  description?: React.ReactNode
  eyebrow?: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div className="flex flex-col gap-2">
        {eyebrow && <span className="font-mono text-xs uppercase tracking-[0.06em] text-castle-subtle">{eyebrow}</span>}
        <h1 className="m-0 text-[38px] font-semibold leading-tight tracking-[-0.04em]">{title}</h1>
        {description && <p className="m-0 text-base text-castle-muted">{description}</p>}
      </div>
      {aside}
    </div>
  )
}

/** Coloured initials tile used for sources and mails. */
export function InitialsTile({ initials, color, size = 40, radius = 9, className = '' }: {
  initials: string
  color: string
  size?: number
  radius?: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center font-semibold text-white ${className}`}
      style={{ width: size, height: size, borderRadius: radius, background: color, fontSize: size >= 46 ? 13 : 12 }}
    >
      {initials}
    </span>
  )
}

/** Täglich (ink) / Sofort (amber) pill. */
export function ModeBadge({ mode, label, className = '' }: { mode: 'daily' | 'immediate'; label: string; className?: string }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full text-[11.5px] font-medium ${
        mode === 'daily' ? 'bg-castle-ink text-white' : 'bg-castle-instant-bg text-castle-instant-fg'
      } ${className}`}
    >
      {label}
    </span>
  )
}

export function PageSpinner() {
  const t = useTranslations('common')
  return (
    <div className="flex flex-1 items-center justify-center py-32" role="status">
      <div aria-hidden="true" className="h-10 w-10 animate-spin rounded-full border-b-2 border-castle-ink" />
      <span className="sr-only">{t('loading')}</span>
    </div>
  )
}
