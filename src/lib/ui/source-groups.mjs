// Redesign: the sources page lists sources under the user's own categories, in their order,
// with the sources without (or with a deleted) category last.

/**
 * `[{ category, sources }]` – one group per category in the given (already sorted) order,
 * then `{ category: null }` for the rest. Empty category groups are kept, so a new category
 * can still be reordered; an empty "no category" group is left out.
 * @template {{ category_id?: string | null }} S
 * @template {{ id: string }} C
 * @param {S[]} sources
 * @param {C[]} categories
 * @returns {{ category: C | null, sources: S[] }[]}
 */
export function groupSourcesByCategory(sources, categories) {
  const known = new Set((categories ?? []).map((category) => category.id))
  const groups = (categories ?? []).map((category) => ({
    category,
    sources: (sources ?? []).filter((source) => source.category_id === category.id),
  }))
  /** @type {{ category: C | null, sources: S[] }[]} */
  const all = groups
  const rest = (sources ?? []).filter((source) => !source.category_id || !known.has(source.category_id))
  if (rest.length > 0) all.push({ category: null, sources: rest })
  return all
}

/** Most recent `last_checked_at` of the sources, or null. */
export function lastCheckedOf(sources) {
  let latest = null
  for (const source of sources ?? []) {
    const time = source?.last_checked_at ? new Date(source.last_checked_at).getTime() : NaN
    if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time
  }
  return latest === null ? null : new Date(latest).toISOString()
}
