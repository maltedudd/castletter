// NIAS-61: the user_roles migration. There is no database in the test run, so the migration is
// checked for its safety-relevant statements (see the PR for a PGlite run).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ADMIN_ROLE, USER_ROLES_TABLE } from '../../src/lib/auth/roles.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sql = readFileSync(path.join(ROOT, 'supabase/migrations/20261020_create_user_roles.sql'), 'utf8')
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ')

test('eine Rolle je User, nur bekannte Rollen, gelöscht mit dem User', () => {
  assert.match(normalized, new RegExp(`CREATE TABLE IF NOT EXISTS ${USER_ROLES_TABLE} \\(`))
  assert.match(normalized, /user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
  assert.match(normalized, new RegExp(`CHECK \\(role IN \\('${ADMIN_ROLE}'\\)\\)`))
  assert.match(normalized, /PRIMARY KEY \(user_id, role\)/)
})

test('User lesen nur eigene Rollen, schreiben kann nur die Service-Role', () => {
  assert.match(normalized, /ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY/)
  assert.match(normalized, /REVOKE ALL ON user_roles FROM anon, authenticated/)
  assert.match(normalized, /GRANT SELECT ON user_roles TO authenticated/)
  assert.match(normalized, /ON user_roles FOR SELECT USING \(auth\.uid\(\) = user_id\)/)
  assert.doesNotMatch(normalized, /FOR (INSERT|UPDATE|DELETE|ALL)/)
  assert.doesNotMatch(normalized, /GRANT (INSERT|UPDATE|DELETE|ALL)/)
})

test('der bisherige feste Admin wird idempotent übernommen', () => {
  assert.match(normalized, /INSERT INTO user_roles \(user_id, role\) SELECT id, 'admin' FROM auth\.users WHERE lower\(email\) = 'malte\.dudd@gmail\.com' ON CONFLICT DO NOTHING/)
})
