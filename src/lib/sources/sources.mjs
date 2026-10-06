// Sources: podcast RSS feeds, YouTube channels and website RSS/Atom feeds are source types of
// one product. This module holds the type-independent "add source" flow (type selection →
// type-specific input → preview → save) so the UI stays thin and the flow is testable with
// node:test.
//
// The type-specific technical steps stay separate: podcasts are validated by
// /api/podcasts/validate, channels resolved by /api/youtube/resolve, website feeds validated
// by /api/websites/validate, and all are stored in the existing podcast_subscriptions table.

/** @typedef {'podcast' | 'youtube' | 'website'} SourceType */

/**
 * Type-independent preview of a validated source.
 * @typedef {{
 *   type: SourceType
 *   title: string
 *   description: string | null
 *   imageUrl: string | null
 *   feedUrl: string
 *   channelId: string | null
 *   feedFormat?: 'rss' | 'atom'
 *   contentMode?: 'full_text' | 'excerpt' | 'empty'
 * }} SourcePreview
 */

/**
 * `suggestedType` is set when the input belongs to another source type (e.g. a podcast feed
 * entered as website), so the UI can offer to switch.
 * @typedef {{ type: SourceType | null, input: string, preview: SourcePreview | null, error: string | null, suggestedType: SourceType | null }} AddSourceState
 * @typedef {
 *   | { type: 'selectType', sourceType: string }
 *   | { type: 'switchType', sourceType: string }
 *   | { type: 'setInput', input: string }
 *   | { type: 'setPreview', preview: SourcePreview }
 *   | { type: 'setError', error: string | null, suggestedType?: SourceType | null }
 *   | { type: 'cancelPreview' }
 *   | { type: 'reset' }
 * } AddSourceAction
 */

/** @type {readonly SourceType[]} */
export const SOURCE_TYPES = Object.freeze(['podcast', 'youtube', 'website'])

/** @returns {value is SourceType} */
export function isSourceType(/** @type {unknown} */ value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (SOURCE_TYPES).includes(value)
}

/** @type {AddSourceState} */
export const initialAddSourceState = Object.freeze({ type: null, input: '', preview: null, error: null, suggestedType: null })

/**
 * State of the "add source" form. Switching the type discards everything entered for the
 * previous type, so only the fields of the selected type are ever shown or submitted. Only
 * `switchType` (accepting a suggested type) keeps the entered address.
 * @param {AddSourceState} state
 * @param {AddSourceAction} action
 * @returns {AddSourceState}
 */
export function addSourceReducer(state, action) {
  switch (action.type) {
    case 'selectType':
      if (!isSourceType(action.sourceType) || action.sourceType === state.type) return state
      return { type: action.sourceType, input: '', preview: null, error: null, suggestedType: null }
    case 'switchType':
      if (!isSourceType(action.sourceType)) return state
      return { type: action.sourceType, input: state.input, preview: null, error: null, suggestedType: null }
    case 'setInput':
      return { ...state, input: action.input }
    case 'setPreview':
      return { ...state, preview: action.preview, error: null, suggestedType: null }
    case 'setError':
      return { ...state, error: action.error, suggestedType: isSourceType(action.suggestedType) ? action.suggestedType : null }
    case 'cancelPreview':
      return { ...state, preview: null, error: null, suggestedType: null }
    case 'reset':
      return { type: state.type, input: '', preview: null, error: null, suggestedType: null }
    default:
      return state
  }
}

const RESOLVERS = {
  podcast: {
    endpoint: '/api/podcasts/validate',
    body: (/** @type {string} */ input) => ({ feedUrl: input }),
    fallbackErrorKey: 'errorValidateFeed',
    /** @returns {SourcePreview} */
    toPreview: (/** @type {any} */ data) => ({
      type: 'podcast',
      title: data.title,
      description: data.description ?? null,
      imageUrl: data.coverImageUrl ?? null,
      feedUrl: data.feedUrl,
      channelId: null,
    }),
  },
  youtube: {
    endpoint: '/api/youtube/resolve',
    body: (/** @type {string} */ input) => ({ input }),
    fallbackErrorKey: 'youtubeErrorResolve',
    /** @returns {SourcePreview} */
    toPreview: (/** @type {any} */ data) => ({
      type: 'youtube',
      title: data.title,
      description: data.description ?? null,
      imageUrl: data.thumbnailUrl ?? null,
      feedUrl: data.feedUrl,
      channelId: data.channelId,
    }),
  },
  website: {
    endpoint: '/api/websites/validate',
    body: (/** @type {string} */ input) => ({ url: input }),
    fallbackErrorKey: 'websiteErrorFetch',
    /** @returns {SourcePreview} */
    toPreview: (/** @type {any} */ data) => ({
      type: 'website',
      title: data.title,
      description: data.description ?? null,
      imageUrl: data.imageUrl ?? null,
      feedUrl: data.feedUrl,
      channelId: null,
      feedFormat: data.feedFormat,
      contentMode: data.contentMode,
    }),
  },
}

/**
 * Validates the entered feed URL / resolves the entered channel through the type's API route.
 * Errors are either the API's own message (`error`) or a translation key (`errorKey`, sent by
 * the website route or used as fallback), optionally with a `suggestedType`.
 * @param {{ type: SourceType, input: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: true, preview: SourcePreview } | { ok: false, error?: string, errorKey?: string, suggestedType?: SourceType }>}
 */
export async function resolveSourcePreview({ type, input, fetchImpl = fetch }) {
  const resolver = RESOLVERS[type]
  const value = input.trim()
  if (!value) return { ok: false, errorKey: 'errorInputRequired' }

  let res
  let data
  try {
    res = await fetchImpl(resolver.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolver.body(value)),
    })
    data = await res.json().catch(() => ({}))
  } catch {
    return { ok: false, errorKey: 'errorNetworkFeed' }
  }

  if (!res.ok) {
    if (typeof data?.errorKey === 'string' && data.errorKey) {
      return isSourceType(data.suggestedType)
        ? { ok: false, errorKey: data.errorKey, suggestedType: data.suggestedType }
        : { ok: false, errorKey: data.errorKey }
    }
    return typeof data?.error === 'string' && data.error
      ? { ok: false, error: data.error }
      : { ok: false, errorKey: resolver.fallbackErrorKey }
  }
  return { ok: true, preview: resolver.toPreview(data) }
}

/**
 * Row for podcast_subscriptions; podcast rows stay exactly as before the YouTube sources
 * (source_type defaults to 'podcast' in the database). Website rows only carry the feed URL.
 * @param {SourcePreview} preview
 * @param {string} userId
 */
export function buildSourceInsert(preview, userId) {
  const common = {
    user_id: userId,
    feed_url: preview.feedUrl,
    title: preview.title,
    description: preview.description,
    cover_image_url: preview.imageUrl,
  }
  if (preview.type === 'youtube') {
    return { ...common, source_type: 'youtube', youtube_channel_id: preview.channelId }
  }
  if (preview.type === 'website') {
    return { ...common, source_type: 'website' }
  }
  return common
}

const DUPLICATE_ERROR_KEYS = {
  podcast: 'errorAlreadySubscribed',
  youtube: 'youtubeErrorAlreadyAdded',
  website: 'websiteErrorAlreadyAdded',
}

/**
 * @param {{ supabase: any, userId: string, preview: SourcePreview }} options
 * @returns {Promise<{ ok: true } | { ok: false, errorKey: string }>}
 */
export async function saveSource({ supabase, userId, preview }) {
  try {
    const { error } = await supabase.from('podcast_subscriptions').insert(buildSourceInsert(preview, userId))
    if (error) {
      // 23505 = unique constraint violation → source already exists for this user
      return { ok: false, errorKey: error.code === '23505' ? DUPLICATE_ERROR_KEYS[preview.type] : 'errorSaveFeed' }
    }
    return { ok: true }
  } catch {
    return { ok: false, errorKey: 'errorUnexpected' }
  }
}
