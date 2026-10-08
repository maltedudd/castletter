// Every archive text key used by the list and detail page exists in German and English.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')

test('alle Archiv-Texte sind in DE und EN übersetzt', () => {
  const pages = read('src/app/archive/page.tsx') + read('src/app/archive/[id]/page.tsx')
  const keys = new Set([
    ...[...pages.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]),
    ...[...pages.matchAll(/'((?:mode|section)[A-Z]\w*|(?:itemCount|mailCount)_[a-z]+)'/g)].map((m) => m[1]),
  ])
  assert.ok(keys.size > 20, `zu wenige Schlüssel: ${keys.size}`)
  for (const locale of ['de', 'en']) {
    const archive = JSON.parse(read(`messages/${locale}.json`)).archive
    for (const key of keys) assert.equal(typeof archive[key], 'string', `${locale}: archive.${key} fehlt`)
  }
})
