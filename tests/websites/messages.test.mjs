// Every translation key the Website (RSS) flow can produce must exist in German and English,
// and the visible type name is exactly „Website (RSS)“.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }

test('alle Fehler- und Statusschlüssel des Website-Flows sind in DE und EN übersetzt', () => {
  const sources = [
    'src/lib/websites/validate.mjs', 'src/lib/websites/feed.mjs', 'src/lib/sources/sources.mjs',
    'src/app/subscriptions/AddSourceForm.tsx', 'src/app/subscriptions/SourceList.tsx', 'src/app/subscriptions/page.tsx',
    'src/app/api/websites/validate/route.ts',
  ].map(read).join('\n')
  const keys = [...new Set(sources.match(/\b(website[A-Z]\w+|suggest[A-Z]\w+|failedArticle\w*|typeBadgeWebsite|sourceTypeWebsite\w+|deleteDescriptionWebsite|errorUnauthorized)\b/g))]
  assert.ok(keys.length > 25, `zu wenige Schlüssel gefunden: ${keys.length}`)
  for (const locale of ['de', 'en']) {
    for (const key of keys) {
      assert.equal(typeof messages[locale].subscriptions[key], 'string', `${locale}: subscriptions.${key} fehlt`)
    }
  }
})

test('der dritte Quelltyp heißt „Website (RSS)“ – nicht „Newsletter“', () => {
  for (const locale of ['de', 'en']) {
    const s = messages[locale].subscriptions
    assert.equal(s.sourceTypeWebsiteLabel, 'Website (RSS)')
    const websiteTexts = Object.entries(s).filter(([key]) => /website|Website/.test(key)).map(([, value]) => value)
    for (const text of websiteTexts) assert.doesNotMatch(text, /newsletter/i, text)
    assert.equal(typeof messages[locale].archive.readArticleButton, 'string')
  }
})
