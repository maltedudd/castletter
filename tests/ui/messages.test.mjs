import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname
const messages = {
  de: JSON.parse(readFileSync(join(root, 'messages/de.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8')),
}

function keysOf(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`])
}

function has(object, path) {
  return path.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), object) !== undefined
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx|ts)$/.test(name) ? [path] : []
  })
}

/**
 * Static translation lookups: `const t = useTranslations('ns')` / `await getTranslations('ns')`
 * and then `t('key'` – dynamic keys (t(variable)) are not checked here.
 */
function usedKeys() {
  const used = []
  for (const file of sourceFiles(join(root, 'src'))) {
    const code = readFileSync(file, 'utf8')
    const bindings = [...code.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*'([\w.]+)'\s*\)/g)]
    for (const [, name, namespace] of bindings) {
      for (const [, key] of code.matchAll(new RegExp(`\\b${name}\\(\\s*'([\\w.]+)'`, 'g'))) {
        used.push({ file: file.slice(root.length), path: `${namespace}.${key}` })
      }
    }
  }
  return used
}

test('German and English have exactly the same message keys', () => {
  const de = new Set(keysOf(messages.de))
  const en = new Set(keysOf(messages.en))
  assert.deepEqual([...de].filter((key) => !en.has(key)), [], 'missing in en.json')
  assert.deepEqual([...en].filter((key) => !de.has(key)), [], 'missing in de.json')
})

test('every statically used translation key exists in both languages', () => {
  const used = usedKeys()
  assert.ok(used.length > 100, 'scanner found the translation calls')
  for (const locale of ['de', 'en']) {
    const missing = used.filter(({ path }) => !has(messages[locale], path)).map(({ file, path }) => `${file}: ${path}`)
    assert.deepEqual(missing, [], `missing in ${locale}.json`)
  }
})

test('no message is empty', () => {
  for (const locale of ['de', 'en']) {
    const empty = keysOf(messages[locale]).filter((path) => {
      const value = path.split('.').reduce((node, part) => node[part], messages[locale])
      return typeof value !== 'string' || !value.trim()
    })
    assert.deepEqual(empty, [], locale)
  }
})

test('dynamically built translation keys exist in both languages', async () => {
  const { APP_NAV } = await import('../../src/lib/ui/layout.mjs')
  const { ARCHIVE_GROUPS } = await import('../../src/lib/ui/archive-groups.mjs')
  const { greetingKeyOf, onboardingStepsOf } = await import('../../src/lib/ui/dashboard.mjs')
  const literals = (file, pattern) => [...readFileSync(join(root, file), 'utf8').matchAll(pattern)].map((m) => m[1])
  const expected = [
    ...APP_NAV.map((item) => `nav.${item.key}`),
    ...ARCHIVE_GROUPS.map((key) => `archive.group_${key}`),
    ...[0, 6, 12, 20].map((hour) => `dashboard.${greetingKeyOf(hour)}`),
    ...onboardingStepsOf({}).map((step) => `dashboard.${step.key}`),
    // landing tables: kind/source/title/description/SOURCE_TYPES entries
    ...literals('src/app/page.tsx', /'((?:previewItem|step|source)\w+)'/g).map((key) => `landing.${key}`),
    // settings tone texts, add-source and source-list key tables
    ...literals('src/app/settings/page.tsx', /(?:label|description|sample): '(\w+)'/g).map((key) => `settings.${key}`),
    ...literals('src/app/subscriptions/AddSourceForm.tsx', /(?:chipLabel|addHint|addPlaceholder|optionHint|inputLabel|inputDescription|checkButton|addButton): '(\w+)'/g).map((key) => `subscriptions.${key}`),
    ...literals('src/app/subscriptions/SourceList.tsx', /(?:label|failedTitle|failedUnknown): '(\w+)'/g).map((key) => `subscriptions.${key}`),
  ]
  assert.ok(expected.length > 40)
  for (const locale of ['de', 'en']) {
    assert.deepEqual(expected.filter((path) => !has(messages[locale], path)), [], locale)
  }
})
