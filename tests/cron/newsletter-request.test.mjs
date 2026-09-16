import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNewsletterCompletionOptions } from '../../src/lib/cron/newsletter-request.mjs'

test('builds the newsletter request with visible-output budget and reasoning disabled', () => {
  const messages = [{ role: 'user', content: 'unchanged newsletter prompt' }]

  assert.deepEqual(buildNewsletterCompletionOptions('provider/custom-model', messages), {
    model: 'provider/custom-model',
    max_tokens: 3000,
    temperature: 0.7,
    reasoning: { effort: 'none' },
    messages,
  })
})
