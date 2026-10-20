// NIAS-59: every error code and field the AI endpoint admin can return is translated in DE and
// EN, and both locales have the same keys.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AI_PURPOSES } from '../../src/lib/ai/endpoints.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }

test('Fehlercodes, Felder und Zwecke sind in DE und EN übersetzt', () => {
  const sources = ['src/lib/ai/endpoint-admin.mjs', 'src/app/api/admin/ai-endpoints/route.ts', 'src/app/api/admin/ai-endpoints/test/route.ts'].map(read).join('\n')
  // Every quoted word in a `code:`/`error:` expression, ternaries included.
  const codes = [...new Set([...sources.matchAll(/\b(?:code|error): ([^,}\n]+)/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((q) => q[1])))]
  assert.ok(codes.length >= 10, `zu wenige Codes: ${codes}`)
  const fields = ['purpose', 'name', 'baseUrl', 'model', 'apiKey']
  const ui = read('src/app/admin/AiEndpointsSection.tsx')
  const uiKeys = [...new Set([...ui.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))]

  for (const locale of ['de', 'en']) {
    const t = messages[locale].admin.aiEndpoints
    for (const code of [...codes, 'unknown']) assert.equal(typeof t[`error_${code}`], 'string', `${locale}: error_${code}`)
    for (const field of fields) assert.equal(typeof t[`error_field_${field}`], 'string', `${locale}: error_field_${field}`)
    for (const purpose of AI_PURPOSES) {
      assert.equal(typeof t[`purpose_${purpose}`], 'string')
      assert.equal(typeof t[`purposeHint_${purpose}`], 'string')
    }
    for (const key of uiKeys) assert.equal(typeof t[key], 'string', `${locale}: ${key}`)
  }
  assert.deepEqual(Object.keys(messages.de.admin.aiEndpoints).sort(), Object.keys(messages.en.admin.aiEndpoints).sort())
})
