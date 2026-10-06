// The worker image copies src/lib folder by folder (Dockerfile + Dockerfile.dockerignore). Every
// module the worker imports, directly or transitively, must be part of that copy, otherwise the
// container crashes on start while all tests pass.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function localImports(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)]
    .map((match) => path.resolve(path.dirname(file), match[1]))
}

test('Worker-Image enthält alle vom Worker importierten src/lib-Module', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'worker/Dockerfile'), 'utf8')
  const dockerignore = readFileSync(path.join(ROOT, 'worker/Dockerfile.dockerignore'), 'utf8')
  const queue = readdirSync(path.join(ROOT, 'worker')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, 'worker', f))
  const seen = new Set(queue)
  while (queue.length > 0) {
    for (const dep of localImports(queue.pop())) {
      if (!seen.has(dep)) {
        seen.add(dep)
        queue.push(dep)
      }
    }
  }
  const libDirs = [...new Set([...seen].map((f) => path.relative(ROOT, f)).filter((f) => f.startsWith('src/lib/')).map(path.dirname))]
  assert.ok(libDirs.includes('src/lib/websites') && libDirs.includes('src/lib/net'))
  for (const dir of libDirs) {
    assert.match(dockerfile, new RegExp(`^COPY ${dir}[/ ]`, 'm'), `Dockerfile kopiert ${dir} nicht`)
    assert.ok(dockerignore.includes(`!${dir}/*.mjs`), `Dockerfile.dockerignore schließt ${dir} aus`)
  }
})
