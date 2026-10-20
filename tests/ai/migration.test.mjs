// NIAS-58: the ai_endpoints migration. There is no database in the test run, so the migration
// is checked for its safety-relevant statements and for the limits shared with endpoints.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AI_PURPOSES, LIMITS, apiKeyHint, encryptApiKey } from '../../src/lib/ai/endpoints.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sql = readFileSync(path.join(ROOT, 'supabase/migrations/20261020_create_ai_endpoints.sql'), 'utf8')
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ')

test('genau ein Endpunkt je bekanntem Zweck', () => {
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS ai_endpoints \( purpose TEXT PRIMARY KEY/)
  assert.match(normalized, new RegExp(`CHECK \\(purpose IN \\(${AI_PURPOSES.map((p) => `'${p}'`).join(', ')}\\)\\)`))
})

test('Grenzen entsprechen der Validierung in endpoints.mjs', () => {
  assert.match(normalized, new RegExp(`char_length\\(name\\) BETWEEN 1 AND ${LIMITS.name}\\)`))
  assert.match(normalized, new RegExp(`char_length\\(model\\) BETWEEN 1 AND ${LIMITS.model}\\)`))
  assert.match(normalized, new RegExp(`char_length\\(base_url\\) <= ${LIMITS.baseUrl}\\)`))
  assert.match(normalized, /api_key_encrypted IS NULL OR api_key_encrypted LIKE 'v1:%'/)
  assert.ok(encryptApiKey('sk', { masterKey: Buffer.alloc(32), purpose: 'transcription' }).startsWith('v1:'))
  const hintLimit = Number(normalized.match(/char_length\(api_key_hint\) <= (\d+)/)[1])
  assert.ok(apiKeyHint('sk-or-v1-0123456789').length <= hintLimit)
})

test('nur die Service-Role darf die Tabelle lesen oder schreiben', () => {
  assert.match(normalized, /ALTER TABLE ai_endpoints ENABLE ROW LEVEL SECURITY/)
  assert.match(normalized, /REVOKE ALL ON ai_endpoints FROM anon, authenticated/)
  assert.doesNotMatch(normalized, /CREATE POLICY/)
  assert.doesNotMatch(normalized, /GRANT /)
})
