// Kanban #38: the summary-style settings are translated, bounded and persisted per user.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUMMARY_TONES, MAX_PROMPT_ADDITION_CHARS } from '../../src/lib/newsletter/summary-style.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }
const page = read('src/app/settings/page.tsx')
const migration = read('supabase/migrations/20261008_add_summary_style_settings.sql')

test('every settings key used by the page exists in German and English', () => {
  const keys = [...new Set([...page.matchAll(/\bt\('(\w+)'/g), ...page.matchAll(/(?:label|description): '(\w+)'/g)].map((m) => m[1]))]
  assert.ok(keys.includes('toneWarmDescription') && keys.includes('promptAdditionCounter'), 'style keys found')
  for (const locale of ['de', 'en']) {
    for (const key of keys) {
      assert.equal(typeof messages[locale].settings[key], 'string', `${locale}: settings.${key} fehlt`)
    }
  }
})

test('four understandable tone presets with label and description in both languages', () => {
  assert.equal(SUMMARY_TONES.length, 4)
  const de = messages.de.settings
  assert.deepEqual([de.toneNeutralLabel, de.toneConciseLabel, de.toneAnalyticalLabel, de.toneWarmLabel], ['Sachlich', 'Prägnant', 'Analytisch', 'Warm'])
  for (const locale of ['de', 'en']) {
    const s = messages[locale].settings
    for (const tone of ['Neutral', 'Concise', 'Analytical', 'Warm']) {
      assert.ok(s[`tone${tone}Label`].length > 0 && s[`tone${tone}Description`].length > 10, `${locale}: ${tone}`)
    }
    assert.match(s.promptAdditionHint, /\{max\}/)
    assert.match(s.promptAdditionCounter, /\{count\} \/ \{max\}/)
  }
})

test('the prompt addition field is limited and described accessibly', () => {
  assert.match(page, /maxLength=\{MAX_PROMPT_ADDITION_CHARS\}/)
  assert.match(page, /aria-describedby="summary-prompt-addition-hint summary-prompt-addition-counter"/)
  assert.match(page, /aria-live="polite"/)
  assert.match(page, /aria-labelledby="summary-tone-label"/)
  assert.match(page, /summary_tone: normalizeSummaryTone\(summaryTone\)/)
  assert.match(page, /summary_prompt_addition: cleanedAddition/)
})

test('migration adds both per-user columns with the same bounds as the app', () => {
  assert.match(migration, /ALTER TABLE user_settings\s+ADD COLUMN IF NOT EXISTS summary_tone TEXT NOT NULL DEFAULT 'neutral'/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS summary_prompt_addition TEXT;/)
  const tones = migration.match(/CHECK \(summary_tone IN \(([^)]+)\)\)/)[1].split(',').map((t) => t.trim().replace(/'/g, ''))
  assert.deepEqual(tones, SUMMARY_TONES)
  assert.match(migration, new RegExp(`char_length\\(summary_prompt_addition\\) BETWEEN 1 AND ${MAX_PROMPT_ADDITION_CHARS}`))
  assert.match(migration, /DROP CONSTRAINT IF EXISTS user_settings_summary_tone_check/)
})
