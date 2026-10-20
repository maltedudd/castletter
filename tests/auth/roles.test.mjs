import assert from 'node:assert/strict'
import test from 'node:test'
import { hasRole, listAdminEmails, listUserIdsWithRole } from '../../src/lib/auth/roles.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const ROLES = [
  { user_id: 'u-malte', role: 'admin' },
  { user_id: 'u-zweit', role: 'admin' },
]

function failing(message) {
  const chain = { select: () => chain, eq: () => chain, limit: async () => ({ data: null, error: { message } }), then: (resolve) => resolve({ data: null, error: { message } }) }
  return { from: () => chain }
}

test('hasRole: nur User mit Eintrag sind Admin', async () => {
  const supabase = makeFakeSupabase({ user_roles: ROLES })
  assert.equal(await hasRole(supabase, 'u-malte'), true)
  assert.equal(await hasRole(supabase, 'u-anderer'), false)
  assert.equal(await hasRole(supabase, null), false)
  assert.equal(await hasRole(supabase, undefined), false)
  assert.equal(await hasRole(makeFakeSupabase({ user_roles: [] }), 'u-malte'), false)
})

test('hasRole: Lesefehler gilt als kein Admin und wird geloggt', async () => {
  const logs = []
  assert.equal(await hasRole(failing('db down'), 'u-malte', 'admin', { log: (...a) => logs.push(a) }), false)
  assert.deepEqual(logs, [['user_roles read failed:', 'db down']])
})

test('listUserIdsWithRole: eindeutige Ids, leer bei Fehler', async () => {
  assert.deepEqual(await listUserIdsWithRole(makeFakeSupabase({ user_roles: [...ROLES, ROLES[0]] })), ['u-malte', 'u-zweit'])
  assert.deepEqual(await listUserIdsWithRole(failing('x'), 'admin', { log: () => {} }), [])
})

test('listAdminEmails: alle Admins, fehlende User und Adressen werden übersprungen', async () => {
  const supabase = makeFakeSupabase({ user_roles: [...ROLES, { user_id: 'u-weg', role: 'admin' }, { user_id: 'u-ohne', role: 'admin' }] })
  const users = { 'u-malte': 'malte@example.org', 'u-zweit': 'zweit@example.org', 'u-ohne': null }
  supabase.auth = {
    admin: {
      getUserById: async (id) =>
        id in users ? { data: { user: { id, email: users[id] } }, error: null } : { data: { user: null }, error: { message: 'User not found' } },
    },
  }
  const logs = []
  assert.deepEqual(await listAdminEmails(supabase, { log: (...a) => logs.push(a) }), ['malte@example.org', 'zweit@example.org'])
  assert.deepEqual(logs, [['admin user lookup failed:', 'User not found']])
})
