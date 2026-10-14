// Kanban #48: user-defined source categories. A category is a private, named group of sources
// with its own position; a source belongs to at most one category (podcast_subscriptions.
// category_id). Categories only organise the sources page and the daily digest – they never
// change ingestion, summaries or delivery. Dependency-free, shared by the UI and the digest.

/** Same limit as the CHECK constraint in 20261013_add_source_categories.sql. */
export const MAX_CATEGORY_NAME_LENGTH = 50

/** Trimmed name with inner whitespace collapsed to single spaces. */
export function normalizeCategoryName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Error code of a category name, or null when it is valid: `empty`, `tooLong` (in characters,
 * like char_length) or `duplicate` (case-insensitive, like the unique index on lower(name)).
 * `excludeId` is the category being renamed, so it may keep its own name.
 * @param {string} name
 * @param {{ id: string, name: string }[]} categories
 * @param {string | null} [excludeId]
 * @returns {'empty' | 'tooLong' | 'duplicate' | null}
 */
export function validateCategoryName(name, categories, excludeId = null) {
  const clean = normalizeCategoryName(name)
  if (!clean) return 'empty'
  if (Array.from(clean).length > MAX_CATEGORY_NAME_LENGTH) return 'tooLong'
  const lower = clean.toLowerCase()
  const taken = (categories ?? []).some((category) =>
    category.id !== excludeId && normalizeCategoryName(category.name).toLowerCase() === lower
  )
  return taken ? 'duplicate' : null
}

// Code-unit comparison: the same data gives the same order everywhere.
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Categories in the user's order (position, then id). Returns a new array.
 * @template {{ id: string, position: number }} T
 * @param {T[] | null | undefined} categories
 * @returns {T[]}
 */
export function sortCategories(categories) {
  return [...(categories ?? [])].sort((a, b) => a.position - b.position || compareIds(String(a.id), String(b.id)))
}

/**
 * New order of all category ids after moving one category a place `up` or `down`; null when
 * it is already at that edge or unknown.
 * @param {{ id: string, position: number }[]} categories
 * @param {string} id
 * @param {'up' | 'down'} direction
 * @returns {string[] | null}
 */
export function moveCategory(categories, id, direction) {
  const order = sortCategories(categories).map((category) => category.id)
  const from = order.indexOf(id)
  const to = direction === 'up' ? from - 1 : direction === 'down' ? from + 1 : -1
  if (from < 0 || to < 0 || to >= order.length) return null
  ;[order[from], order[to]] = [order[to], order[from]]
  return order
}

/**
 * The category of a source as `{ id, name, position }`, or null without one. `categoriesById`
 * holds the user's categories only, so an unknown id counts as uncategorised.
 */
export function categoryOf(source, categoriesById) {
  const category = source?.category_id ? categoriesById.get(source.category_id) : null
  return category ? { id: category.id, name: category.name, position: category.position } : null
}
