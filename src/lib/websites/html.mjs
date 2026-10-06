// Readable text from HTML for website sources: feed item bodies and public article pages.
// Dependency-free and regex-based by design – it only has to find the main text block of an
// article and drop navigation/scripts, not render arbitrary documents.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', sbquo: '‚', copy: '©', reg: '®', trade: '™', euro: '€', middot: '·', bull: '•',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è',
  agrave: 'à', aacute: 'á', ccedil: 'ç', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ',
}

// Elements whose content is never article text.
const DROP_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'nav', 'header', 'footer',
  'aside', 'button', 'select', 'figure', 'video', 'audio', 'canvas', 'dialog', 'head',
]
const BLOCK_TAGS = /<\/?(p|div|section|article|main|h[1-6]|li|ul|ol|blockquote|pre|tr|table|dl|dt|dd|hr)\b[^>]*>/gi

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Removes the given elements including their content (nested occurrences included). */
function dropElements(html, tags) {
  let result = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  for (const tag of tags) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi')
    let previous
    do {
      previous = result
      result = result.replace(pattern, ' ')
    } while (result !== previous)
    result = result.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  }
  return result
}

/** Plain text with paragraph breaks; tags removed, entities decoded, whitespace normalised. */
export function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  const text = dropElements(html, ['script', 'style', 'noscript', 'template', 'svg', 'iframe'])
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_TAGS, '\n\n')
    .replace(/<[^>]+>/g, ' ')
  return normalizeText(decodeEntities(text))
}

export function normalizeText(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Returns the outer HTML of every element opened at a match of `openPattern` (a regex with the
 * `g` flag matching an opening tag of `tag`), balancing nested tags of the same name.
 */
function findElements(html, tag, openPattern) {
  const results = []
  const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  openPattern.lastIndex = 0
  let open
  while ((open = openPattern.exec(html))) {
    tagPattern.lastIndex = open.index + open[0].length
    let depth = 1
    let match
    while (depth > 0 && (match = tagPattern.exec(html))) {
      depth += match[1] ? -1 : 1
    }
    const end = depth === 0 && match ? match.index + match[0].length : html.length
    results.push(html.slice(open.index, end))
    openPattern.lastIndex = end
  }
  return results
}

function longest(texts) {
  return texts.reduce((best, text) => (text.length > best.length ? text : best), '')
}

/**
 * Main readable text of an article page: schema.org `articleBody` › `<article>` › `<main>`
 * › `<body>`, with navigation, header/footer, asides, forms and scripts removed.
 */
export function extractMainContent(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  const cleaned = dropElements(html, DROP_ELEMENTS)

  const articleBody = /<([a-z][a-z0-9]*)\b[^>]*\bitemprop=["']?articleBody\b[^>]*>/i.exec(cleaned)
  if (articleBody) {
    const tag = articleBody[1].toLowerCase()
    const text = longest(findElements(cleaned, tag, new RegExp(`<${tag}\\b[^>]*\\bitemprop=["']?articleBody\\b[^>]*>`, 'gi')).map(htmlToText))
    if (text) return text
  }
  for (const tag of ['article', 'main']) {
    const text = longest(findElements(cleaned, tag, new RegExp(`<${tag}\\b[^>]*>`, 'gi')).map(htmlToText))
    if (text) return text
  }
  const body = /<body\b[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(cleaned)
  return htmlToText(body ? body[1] : cleaned)
}

/**
 * Paywall signals of a page. `declaredNotFree` is the schema.org marker publishers set for
 * paywalled articles (`isAccessibleForFree: false`); `markers` are typical paywall containers.
 */
export function detectPaywall(html) {
  if (typeof html !== 'string') return { declaredNotFree: false, markers: false }
  const declaredNotFree =
    /["']?isAccessibleForFree["']?\s*:\s*(false|["']false["'])/i.test(html) ||
    /<meta\b[^>]*itemprop=["']isAccessibleForFree["'][^>]*content=["']false["']/i.test(html)
  const markers =
    /\b(class|id)=["'][^"']*\b(paywall|paywalled|regwall|piano-offer|tp-modal|subscriber-only|subscribers-only|premium-content|article-locked|plus-teaser|abo-teaser)\b/i.test(html)
  return { declaredNotFree, markers }
}
