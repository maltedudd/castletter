// Admin check for server components and API routes (NIAS-61).
import type { User } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { hasRole } from '@/lib/auth/roles.mjs'

/**
 * The signed-in user and whether they are an admin. The role is read with the service role,
 * so the check does not depend on the session's RLS.
 */
export async function getSessionUserWithRole(): Promise<{ user: User | null; isAdmin: boolean }> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return { user: null, isAdmin: false }
  return { user, isAdmin: await hasRole(createAdminClient(), user.id) }
}

/** The signed-in user if they are an admin, otherwise null. */
export async function getAdminUser(): Promise<User | null> {
  const { user, isAdmin } = await getSessionUserWithRole()
  return isAdmin ? user : null
}
