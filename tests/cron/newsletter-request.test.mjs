import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNewsletterCompletionOptions } from '../../src/lib/cron/newsletter-request.mjs'

test('disables reasoning for the default Gemini newsletter model to protect visible output', () => {
  const messages = [{ role: 'user', content: 'unchanged newsletter prompt' }]

  assert.deepEqual(buildNewsletterCompletionOptions('google/gemini-2.5-flash', messages), {
    model: 'google/gemini-2.5-flash',
    max_tokens: 3000,
    temperature: 0.7,
    reasoning: { effort: 'none' },
    messages,
  })
})

test('leaves reasoning unspecified for a generic model override', () => {
  const messages = [{ role: 'user', content: 'unchanged newsletter prompt' }]
  const options = buildNewsletterCompletionOptions('provider/custom-model', messages)

  assert.deepEqual(options, {
    model: 'provider/custom-model',
    max_tokens: 3000,
    temperature: 0.7,
    messages,
  })
  assert.equal(Object.hasOwn(options, 'reasoning'), false)
})
