// User roles (NIAS-61): who is an admin is stored in `user_roles` instead of a fixed e-mail
// address. Dependency-free with an injected Supabase client (service role), so the checks run
// under node:test. Every read failure counts as "no role" (fail closed).

export const USER_ROLES_TABLE = 'user_roles'
export const ADMIN_ROLE = 'admin'

/** Whether `userId` has `role`; false on a missing user id or any read error. */
export async function hasRole(supabase, userId, role = ADMIN_ROLE, { log = console.error } = {}) {
  if (!userId) return false
  const { data, error } = await supabase
    .from(USER_ROLES_TABLE)
    .select('user_id')
    .eq('user_id', userId)
    .eq('role', role)
    .limit(1)
  if (error) {
    log('user_roles read failed:', error.message)
    return false
  }
  return (data?.length ?? 0) > 0
}

/** Ids of all users with `role`; empty on a read error. */
export async function listUserIdsWithRole(supabase, role = ADMIN_ROLE, { log = console.error } = {}) {
  const { data, error } = await supabase.from(USER_ROLES_TABLE).select('user_id').eq('role', role)
  if (error) {
    log('user_roles read failed:', error.message)
    return []
  }
  return [...new Set((data ?? []).map((row) => row.user_id))]
}

/**
 * E-mail addresses of all admins (via the Auth admin API), e.g. for notifications. Users that
 * no longer exist or have no address are skipped.
 */
export async function listAdminEmails(supabase, { log = console.error } = {}) {
  const emails = []
  for (const userId of await listUserIdsWithRole(supabase, ADMIN_ROLE, { log })) {
    const { data, error } = await supabase.auth.admin.getUserById(userId)
    if (error) {
      log('admin user lookup failed:', error.message)
      continue
    }
    if (data?.user?.email) emails.push(data.user.email)
  }
  return emails
}
