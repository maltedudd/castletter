// Redesign: sources and mails are shown as coloured initials tiles (Claude-Design prototype).
// The colour is derived from the source title, so the same source always looks the same.

/** Tile colours of the prototype. */
export const AVATAR_COLORS = ['#1F6F8B', '#C8102E', '#B4532A', '#7A3B2E', '#2D3A40', '#E2B714', '#3B2F4A', '#D9A21B', '#1E5A8C', '#0D4E8C']

/** Up to two letters/digits: first letters of the first two words, else the first two characters. */
export function initialsOf(title) {
  const words = String(title ?? '')
    .split(/[\s|·–—\-:/.,&]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** Stable colour for a key (source title); empty keys get the first colour. */
export function avatarColorOf(key) {
  const text = String(key ?? '')
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}
