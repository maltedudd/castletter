import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { generateEmailHTML, generateEmailPlainText } from '../../src/lib/email/template.mjs'
import { sampleIssue } from '../../src/lib/newsletter/sample.mjs'

const root = new URL('../../', import.meta.url).pathname
const read = (path) => readFileSync(join(root, path), 'utf8')

// Decision (Malte, 2026-10-26): no real third-party names in examples.
const THIRD_PARTY = [/St\. Pauli/, /Julian Ivanov/, /AI to the DNA/, /Mainz/, /tagesschau/i, /Hotel Matze/, /Malte/i]

for (const locale of ['de', 'en']) {
  test(`${locale}: the sample issue renders through the real mail template with overview, all four source types and the logo`, () => {
    const { items, overview } = sampleIssue(locale)
    const html = generateEmailHTML('du@example.org', items, 'https://castletter.example/settings', locale, 'daily', overview)
    assert.match(html, /<!-- Overview -->/)
    for (const section of ['Podcasts', 'YouTube', 'Website (RSS)']) assert.ok(html.includes(`<!-- Section: ${section} -->`), section)
    assert.match(html, /<!-- Section: Social -->/)
    assert.match(html, /castletter\.example\/email\/logo-mark\.png/)
    for (const item of items) assert.match(item.audioUrl, /^https:\/\/example\.org\//, 'links only to the reserved example domain')
    const text = generateEmailPlainText(items, 'https://castletter.example/settings', locale, 'daily', overview)
    for (const pattern of THIRD_PARTY) {
      assert.doesNotMatch(html, pattern, `${locale}: ${pattern}`)
      assert.doesNotMatch(text, pattern, `${locale}: ${pattern}`)
    }
  })
}

test('unknown locales fall back to the German sample', () => {
  assert.deepEqual(sampleIssue('fr'), sampleIssue('de'))
})

test('the landing page "sample issue" button opens the sample page', () => {
  assert.match(read('src/app/page.tsx'), /href="\/beispiel"[\s\S]{0,300}\{t\('ctaPreview'\)\}/)
})
