import Image from 'next/image'
import type { SourceType } from '@/types/database'

/** Cover (podcast/website, square) or avatar (YouTube, round) with an emoji placeholder. */
export function SourceImage({ type, title, url, size }: { type: SourceType; title: string; url: string | null; size: number }) {
  const shape = type === 'youtube' ? 'rounded-full' : 'rounded-lg'
  if (url) {
    return <Image src={url} alt="" width={size} height={size} className={`${shape} object-cover shrink-0`} />
  }
  return (
    <div
      aria-hidden="true"
      className={`${shape} bg-muted flex items-center justify-center text-2xl shrink-0`}
      style={{ width: size, height: size }}
    >
      {type === 'youtube' ? '▶️' : type === 'website' ? '🌐' : '🎙️'}
    </div>
  )
}
