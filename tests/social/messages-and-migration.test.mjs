// Every translation key of the social (Mastodon) flow exists in German and English, and the
// migration extends the type constraints backwards-compatibly.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const messages = { de: JSON.parse(read('messages/de.json')), en: JSON.parse(read('messages/en.json')) }

test('alle Schlüssel des Social-Flows sind in DE und EN übersetzt', () => {
  const sources = [
    'src/lib/social/mastodon.mjs', 'src/lib/sources/sources.mjs', 'src/app/api/social/resolve/route.ts',
    'src/app/subscriptions/AddSourceForm.tsx', 'src/app/subscriptions/SourceList.tsx', 'src/app/subscriptions/page.tsx',
  ].map(read).join('\n')
  const keys = [...new Set(sources.match(/\b(social[A-Z]\w+|sourceTypeSocial\w+|typeBadgeSocial|suggestSocialButton|failedPost\w*|deleteDescriptionSocial)\b/g))]
    .filter((key) => !['socialAccountId', 'socialHandle', 'socialPlatform', 'socialUserIds', 'socialPost'].includes(key))
  assert.ok(keys.length >= 18, `zu wenige Schlüssel gefunden: ${keys.length}`)
  for (const locale of ['de', 'en']) {
    for (const key of keys) {
      assert.equal(typeof messages[locale].subscriptions[key], 'string', `${locale}: subscriptions.${key} fehlt`)
    }
  }

  const archivePage = read('src/app/archive/[id]/page.tsx')
  const archiveKeys = [...new Set([...archivePage.matchAll(/t\('(\w+)'\)/g), ...archivePage.matchAll(/'(media\w+)'/g)].map((m) => m[1]))]
  for (const locale of ['de', 'en']) {
    for (const key of archiveKeys) {
      assert.equal(typeof messages[locale].archive[key], 'string', `${locale}: archive.${key} fehlt`)
    }
  }
})

test('Migration erweitert die Quelltypen um social und hält andere Typen frei von Social-Spalten', () => {
  const sql = read('supabase/migrations/20261009_add_mastodon_social_sources.sql')
  assert.match(sql, /podcast_subscriptions_source_type_check\s+CHECK \(source_type IN \('podcast', 'youtube', 'website', 'social'\)\)/)
  assert.match(sql, /episodes_source_type_check\s+CHECK \(source_type IN \('podcast', 'youtube', 'website', 'social'\)\)/)
  assert.match(sql, /source_type IN \('podcast', 'website', 'social'\) AND youtube_channel_id IS NULL/)
  assert.match(sql, /source_type <> 'social'\s+AND social_platform IS NULL AND social_handle IS NULL AND social_account_id IS NULL/)
  assert.match(sql, /source_type = 'social'\s+OR \(social_content IS NULL AND social_spoiler IS NULL AND social_media IS NULL\)/)
  // Only nullable additions; nothing is dropped except the constraints that get replaced.
  assert.doesNotMatch(sql, /DROP (TABLE|COLUMN)|NOT NULL/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS social_content TEXT/)
})
