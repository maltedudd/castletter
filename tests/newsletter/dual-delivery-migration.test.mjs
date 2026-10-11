// Kanban #43: the expand migration and the DE/EN texts of the delivery checkboxes. There is no
// database in the test run, so the migration is checked for its safety-relevant statements.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }
const sql = read('supabase/migrations/20261011_add_dual_delivery_targets.sql')
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ')

test('migration adds both flags and backfills them from delivery_mode only once (immediate → immediate only)', () => {
  assert.match(normalized, /ADD COLUMN deliver_immediately BOOLEAN NOT NULL DEFAULT false/)
  assert.match(normalized, /ADD COLUMN deliver_daily BOOLEAN NOT NULL DEFAULT true/)
  assert.match(normalized, /SET deliver_immediately = true, deliver_daily = false WHERE delivery_mode = 'immediate'/)
  // The backfill sits inside the "column does not exist yet" branch, so a rerun keeps user choices.
  const guard = normalized.indexOf("column_name = 'deliver_immediately' ) THEN")
  const backfill = normalized.indexOf("WHERE delivery_mode = 'immediate'")
  const endIf = normalized.indexOf('END IF;')
  assert.ok(guard > 0 && guard < backfill && backfill < endIf)
})

test('migration requires at least one target and keeps delivery_mode in sync for older code', () => {
  assert.match(normalized, /CHECK \(deliver_immediately OR deliver_daily\)/)
  assert.match(normalized, /CREATE TRIGGER sync_subscription_delivery_targets BEFORE INSERT OR UPDATE ON podcast_subscriptions/)
  assert.match(normalized, /NEW\.deliver_immediately := NEW\.delivery_mode = 'immediate'/)
  assert.match(normalized, /WHEN NEW\.deliver_daily AND NOT NEW\.deliver_immediately THEN 'daily' ELSE 'immediate'/)
  assert.doesNotMatch(normalized, /DROP COLUMN/i, 'expand only – delivery_mode stays')
})

test('migration tracks delivery per episode and target, readable only by the owner', () => {
  assert.match(normalized, /CREATE TABLE IF NOT EXISTS newsletter_deliveries/)
  assert.match(normalized, /target TEXT NOT NULL CHECK \(target IN \('immediate', 'daily'\)\)/)
  assert.match(normalized, /status TEXT NOT NULL CHECK \(status IN \('sending', 'sent'\)\)/)
  assert.match(normalized, /UNIQUE \(episode_id, target\)/)
  assert.match(normalized, /ALTER TABLE newsletter_deliveries ENABLE ROW LEVEL SECURITY/)
  assert.match(normalized, /FOR SELECT USING \(auth\.uid\(\) = user_id\)/)
  assert.doesNotMatch(normalized, /ON newsletter_deliveries FOR (INSERT|UPDATE|DELETE|ALL)/, 'writes with the service role only')
  // Mails sent before the migration stay in the archive, idempotently.
  assert.match(normalized, /JOIN newsletter_mails m ON m\.id = e\.newsletter_mail_id ON CONFLICT \(episode_id, target\) DO NOTHING/)
})

test('delivery checkbox texts exist in German and English', () => {
  for (const locale of ['de', 'en']) {
    for (const key of ['deliveryModeLabel', 'deliveryTargetImmediate', 'deliveryTargetDaily', 'deliveryTargetRequired',
      'successDeliveryImmediate', 'successDeliveryDaily', 'successDeliveryBoth', 'errorSaveDeliveryMode']) {
      assert.equal(typeof messages[locale].subscriptions[key], 'string', `${locale}: subscriptions.${key} fehlt`)
    }
    assert.equal(messages[locale].subscriptions.deliveryModeImmediate, undefined, `${locale}: alter Select-Text entfernt`)
  }
  assert.equal(messages.de.subscriptions.deliveryTargetImmediate, 'Sofort benachrichtigen')
  assert.equal(messages.en.subscriptions.deliveryTargetDaily, 'In the daily newsletter')
})
