// Kanban #48: the source categories migration and the DE/EN texts. There is no database in the
// test run, so the migration is checked for its safety-relevant statements.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MAX_CATEGORY_NAME_LENGTH } from '../../src/lib/sources/categories.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }
const sql = read('supabase/migrations/20261014_add_source_categories.sql')
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ')

test('categories belong to one user, have a trimmed, bounded name unique per user and a persistent position', () => {
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS source_categories/)
  assert.match(normalized, /user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/)
  assert.match(normalized, new RegExp(`CHECK \\(name = btrim\\(name\\) AND char_length\\(name\\) BETWEEN 1 AND ${MAX_CATEGORY_NAME_LENGTH}\\)`))
  assert.match(normalized, /CREATE UNIQUE INDEX IF NOT EXISTS source_categories_user_name_key ON source_categories \(user_id, lower\(name\)\)/)
  assert.match(normalized, /position INTEGER NOT NULL/)
  assert.match(normalized, /UNIQUE \(user_id, position\) DEFERRABLE INITIALLY DEFERRED/)
  assert.match(normalized, /CREATE TRIGGER set_source_category_position BEFORE INSERT ON source_categories/)
})

test('row level security: every operation on own categories only', () => {
  assert.match(normalized, /ALTER TABLE source_categories ENABLE ROW LEVEL SECURITY/)
  for (const operation of ['SELECT', 'DELETE']) {
    assert.match(normalized, new RegExp(`ON source_categories FOR ${operation} USING \\(auth\\.uid\\(\\) = user_id\\)`))
  }
  assert.match(normalized, /ON source_categories FOR INSERT WITH CHECK \(auth\.uid\(\) = user_id\)/)
  assert.match(normalized, /ON source_categories FOR UPDATE USING \(auth\.uid\(\) = user_id\) WITH CHECK \(auth\.uid\(\) = user_id\)/)
  assert.doesNotMatch(normalized, /FOR ALL|TO anon/i)
})

test('a source has at most one category of the same user; deleting a category only unassigns its sources', () => {
  assert.match(normalized, /ALTER TABLE podcast_subscriptions ADD COLUMN IF NOT EXISTS category_id UUID;/)
  assert.match(normalized, /FOREIGN KEY \(user_id, category_id\) REFERENCES source_categories \(user_id, id\) ON DELETE SET NULL \(category_id\)/)
  assert.match(normalized, /CONSTRAINT source_categories_user_id_id_key UNIQUE \(user_id, id\)/)
  assert.doesNotMatch(normalized, /ON DELETE CASCADE[^;]*category/i, 'a category never deletes sources')
  assert.doesNotMatch(normalized, /\b(UPDATE|DELETE FROM) podcast_subscriptions\b/, 'existing sources are not changed')
  assert.doesNotMatch(normalized, /\bepisodes\b|newsletter_deliveries/, 'episodes and delivery state are untouched')
})

test('reordering is one atomic, row-level-secured call for exactly the caller\'s categories', () => {
  assert.match(normalized, /CREATE OR REPLACE FUNCTION reorder_source_categories\(category_ids UUID\[\]\) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER/)
  assert.doesNotMatch(normalized, /SECURITY DEFINER/)
  assert.match(normalized, /owner UUID := auth\.uid\(\)/)
  assert.match(normalized, /count\(DISTINCT id\) FROM unnest\(category_ids\)/, 'no id twice')
  assert.match(normalized, /count\(\*\) FROM source_categories WHERE user_id = owner/, 'none missing')
  assert.match(normalized, /c\.id = ids\.id AND c\.user_id = owner/, 'none foreign')
  assert.match(normalized, /REVOKE ALL ON FUNCTION reorder_source_categories\(UUID\[\]\) FROM PUBLIC/)
  assert.match(normalized, /REVOKE ALL ON FUNCTION reorder_source_categories\(UUID\[\]\) FROM anon/)
  assert.match(normalized, /GRANT EXECUTE ON FUNCTION reorder_source_categories\(UUID\[\]\) TO authenticated/)
})

test('the migration is idempotent', () => {
  assert.doesNotMatch(normalized, /CREATE TABLE (?!IF NOT EXISTS)/)
  assert.doesNotMatch(normalized, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/)
  for (const [, name] of normalized.matchAll(/CREATE POLICY "([^"]+)"/g)) {
    assert.ok(normalized.includes(`DROP POLICY IF EXISTS "${name}"`), name)
  }
  for (const [, name] of normalized.matchAll(/CREATE TRIGGER (\w+)/g)) {
    assert.ok(normalized.includes(`DROP TRIGGER IF EXISTS ${name}`), name)
  }
  assert.match(normalized, /DROP CONSTRAINT IF EXISTS podcast_subscriptions_category_fkey/)
})

test('every category text used by the sources page exists in German and English', () => {
  const sources = ['src/app/subscriptions/CategoryManager.tsx', 'src/app/subscriptions/SourceList.tsx', 'src/app/subscriptions/page.tsx']
    .map(read).join('\n')
  const keys = [...new Set([...sources.matchAll(/['"]((?:categor(?:y|ies)|sourceCategory|successCategory)[A-Z]\w*|errorSaveCategory)['"]/g)].map((m) => m[1]))]
  assert.ok(keys.length >= 30, `zu wenige Schlüssel gefunden: ${keys.length}`)
  for (const locale of ['de', 'en']) {
    for (const key of keys) {
      assert.equal(typeof messages[locale].subscriptions[key], 'string', `${locale}: subscriptions.${key} fehlt`)
    }
  }
  assert.match(messages.de.subscriptions.categoryDeleteDescription, /bleib.*erhalten.*Weitere Quellen/)
  assert.match(messages.en.subscriptions.categoryDeleteDescription, /kept.*More sources/)
  assert.match(messages.de.subscriptions.categoryMoveUp, /nach oben/)
  assert.match(messages.en.subscriptions.categoryMoveDown, /down/)
})
