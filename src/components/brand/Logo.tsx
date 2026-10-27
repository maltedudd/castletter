/**
 * Castletter logo exactly as in the Claude-Design prototype: envelope with an amber dot
 * (on a white ring) and the lower-case wordmark. Same geometry as public/logo.svg.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg width="30" height="27" viewBox="0 0 31 28" fill="none" aria-hidden="true" className={className} style={{ flex: 'none' }}>
      <rect x="1.5" y="8" width="24" height="17.5" rx="3" stroke="#062F3E" strokeWidth="2.6" />
      <path d="M2.5 10 L13.5 18 L24.5 10" stroke="#062F3E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="7" r="6.5" fill="#FFFFFF" />
      <circle cx="25" cy="7" r="4.2" fill="#F0A848" />
    </svg>
  )
}

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className="flex items-center gap-1.5 text-castle-ink">
      <LogoMark />
      <span className={`font-bold tracking-[-0.055em] ${size === 'lg' ? 'text-[21px]' : 'text-[20px]'}`}>castletter</span>
    </span>
  )
}
