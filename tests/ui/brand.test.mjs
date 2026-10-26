import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../../', import.meta.url).pathname
const read = (path) => readFileSync(join(root, path), 'utf8')

// Geometry of the original logo in the Claude-Design prototype (envelope with amber dot).
const ORIGINAL_LOGO = [
  /viewBox="0 0 31 28"/,
  /<rect x="1\.5" y="8" width="24" height="17\.5" rx="3" stroke="#062F3E" stroke-width="2\.6"/,
  /d="M2\.5 10 L13\.5 18 L24\.5 10"/,
  /<circle cx="25" cy="7" r="6\.5" fill="#FFFFFF"/,
  /<circle cx="25" cy="7" r="4\.2" fill="#F0A848"/,
]

test('public/logo.svg is the original prototype logo, not an invented one', () => {
  const svg = read('public/logo.svg')
  for (const part of ORIGINAL_LOGO) assert.match(svg, part)
  assert.doesNotMatch(svg, /linearGradient|#9FC131|#005C53/)
})

test('the Logo component draws the same original geometry and the wordmark', () => {
  const component = read('src/components/brand/Logo.tsx').replace(/strokeWidth/g, 'stroke-width').replace(/viewBox=\{?"?/g, 'viewBox="')
  for (const part of ORIGINAL_LOGO) assert.match(component, part)
  assert.match(component, />castletter</)
})

// Example data of the prototype must not show up as if it were the user's own data.
const APP_PAGES = [
  'src/app/dashboard/page.tsx',
  'src/app/subscriptions/page.tsx',
  'src/app/subscriptions/SourceList.tsx',
  'src/app/archive/page.tsx',
  'src/app/settings/page.tsx',
  'src/components/site/SiteHeader.tsx',
]
const PROTOTYPE_DATA = [/Malte/i, /malte\.dudd/i, /jipido/i, /St\. Pauli/, /Julian Ivanov/, /Magnussen/, /tagesschau/i, /Hotel Matze/, /14 neue Inhalte/, /20 neue Inhalte/, /Ausgabe 39/]

test('signed-in pages contain no prototype example data', () => {
  for (const file of APP_PAGES) {
    const code = read(file)
    for (const pattern of PROTOTYPE_DATA) assert.doesNotMatch(code, pattern, `${file} contains ${pattern}`)
  }
  const appMessages = ['dashboard', 'subscriptions', 'archive', 'settings', 'nav'].map((ns) => JSON.stringify(JSON.parse(read('messages/de.json'))[ns]))
  for (const text of appMessages) {
    for (const pattern of PROTOTYPE_DATA) assert.doesNotMatch(text, pattern)
  }
})
