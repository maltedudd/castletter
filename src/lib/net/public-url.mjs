// Fetching user-supplied URLs (website feeds, article links from those feeds) without
// reaching internal hosts: every hop of a redirect chain is checked by hostname and, where a
// DNS lookup is injected, by resolved address. Dependency-free; fetch and lookup are injected.

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024

export const PUBLIC_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Castletter/1.0; +https://castletter.io)',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
}

/** The URL is not allowed (scheme, private/internal host) or the redirect chain is too long. */
export class PublicUrlError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicUrlError'
    this.code = code
  }
}

/** Hostnames and literal IPs of loopback, private, link-local and metadata ranges. */
export function isPrivateHost(rawHostname) {
  const hostname = String(rawHostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname === 'metadata.google.internal' || hostname.endsWith('.internal') || hostname.endsWith('.local')) return true
  return isPrivateAddress(hostname)
}

/** Literal IPv4/IPv6 addresses in non-public ranges (non-IP input → false). */
export function isPrivateAddress(address) {
  const value = String(address).toLowerCase()
  const parts = value.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const [a, b] = parts.map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||           // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224                              // multicast / reserved
    )
  }
  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(value)
  }
  return false
}

/**
 * Parses and checks a URL: http(s) only, no credentials, no private host. With `lookup`
 * (`dns.promises.lookup`-compatible, `{ all: true }`) the resolved addresses are checked too.
 * @returns {Promise<URL>}
 */
export async function assertPublicUrl(rawUrl, { lookup = null } = {}) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new PublicUrlError('invalid_url', 'Ungültige URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PublicUrlError('invalid_url', 'Nur http(s)-URLs sind erlaubt')
  if (url.username || url.password) throw new PublicUrlError('not_allowed', 'URLs mit Zugangsdaten sind nicht erlaubt')
  if (isPrivateHost(url.hostname)) throw new PublicUrlError('not_allowed', `Interne Adresse nicht erlaubt: ${url.hostname}`)
  if (lookup) {
    let addresses
    try {
      addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
    } catch {
      throw new PublicUrlError('dns_failed', `Host nicht gefunden: ${url.hostname}`)
    }
    if ([].concat(addresses).some((entry) => isPrivateAddress(entry?.address ?? entry))) {
      throw new PublicUrlError('not_allowed', `Host zeigt auf eine interne Adresse: ${url.hostname}`)
    }
  }
  return url
}

/**
 * GET with redirects followed manually (each hop checked by `assertPublicUrl`), a timeout and
 * a body size cap. Never throws for HTTP status codes: returns `{ status, ok, url, redirected,
 * contentType, text }` where `url` is the final URL. Network failures reject with the cause.
 */
export async function fetchPublicText(rawUrl, {
  fetchImpl = fetch,
  lookup = null,
  headers = {},
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  let url = await assertPublicUrl(rawUrl, { lookup })
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(url.href, {
      headers: { ...PUBLIC_FETCH_HEADERS, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const location = response.headers?.get?.('location')
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= maxRedirects) throw new PublicUrlError('too_many_redirects', 'Zu viele Weiterleitungen')
      url = await assertPublicUrl(new URL(location, url).href, { lookup })
      continue
    }
    return {
      status: response.status,
      ok: response.ok,
      url: url.href,
      redirected: hop > 0,
      contentType: response.headers?.get?.('content-type') ?? '',
      text: response.ok ? await readTextCapped(response, maxBytes) : '',
    }
  }
}

async function readTextCapped(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) return (await response.text()).slice(0, maxBytes)
  const chunks = []
  let size = 0
  while (size < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(size, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset)
    bytes.set(part, offset)
    offset += part.length
    if (offset >= bytes.length) break
  }
  return new TextDecoder('utf-8').decode(bytes)
}
