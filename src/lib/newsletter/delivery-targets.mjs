// Kanban #43: every source has two independent delivery targets – an immediate mail and the
// daily digest – of which at least one is active. Shared by the delivery logic and the source
// settings UI; dependency-free so it runs under node:test.

export const DELIVERY_TARGETS = ['immediate', 'daily']

/**
 * The delivery targets of a subscription: `deliver_immediately` / `deliver_daily` (Kanban #43).
 * Rows without valid flags (written before the migration, or with no target at all) fall back
 * to the legacy exclusive `delivery_mode`, so a source never silently loses its delivery.
 * @returns {{ immediate: boolean, daily: boolean }}
 */
export function deliveryTargetsOf(subscription) {
  const immediate = subscription?.deliver_immediately
  const daily = subscription?.deliver_daily
  if (typeof immediate === 'boolean' && typeof daily === 'boolean' && (immediate || daily)) {
    return { immediate, daily }
  }
  return subscription?.delivery_mode === 'immediate'
    ? { immediate: true, daily: false }
    : { immediate: false, daily: true }
}

/** Active targets of a subscription in the order immediate, daily. */
export function wantedTargetsOf(subscription) {
  const targets = deliveryTargetsOf(subscription)
  return DELIVERY_TARGETS.filter((target) => targets[target])
}

/**
 * Turns one target on or off. Switching off the last active target is refused
 * (`ok: false`, targets unchanged), so "no delivery" can never be saved.
 * @returns {{ ok: boolean, targets: { immediate: boolean, daily: boolean } }}
 */
export function toggleDeliveryTarget(targets, target, checked) {
  if (!DELIVERY_TARGETS.includes(target)) return { ok: false, targets }
  const next = { ...targets, [target]: Boolean(checked) }
  if (!next.immediate && !next.daily) return { ok: false, targets }
  return { ok: true, targets: next }
}

/** Database columns for a set of targets. */
export function deliveryPatchOf(targets) {
  return { deliver_immediately: Boolean(targets.immediate), deliver_daily: Boolean(targets.daily) }
}
