import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WHISPER_MAX_SIZE,
  isTooLargeForWhisper,
  buildAcceptedResponse,
  buildNoPendingResponse,
} from '../../src/lib/cron/transcribe-ack.mjs'

test('flags audio over the 25MB Whisper limit without ever suggesting truncation', () => {
  assert.equal(isTooLargeForWhisper(WHISPER_MAX_SIZE), false)
  assert.equal(isTooLargeForWhisper(WHISPER_MAX_SIZE + 1), true)
  assert.equal(isTooLargeForWhisper(15 * 1024 * 1024), false) // typical daily episode size
  assert.equal(isTooLargeForWhisper(undefined), false)
})

test('accepted response acks the claim without claiming the transcript is done', () => {
  const response = buildAcceptedResponse('episode-1')
  assert.equal(response.success, true)
  assert.equal(response.accepted, 1)
  assert.equal(response.processing, true)
  assert.equal(response.episodeId, 'episode-1')
  assert.equal('transcribed' in response, false)
})

test('no-pending response reports zero accepted for cron-job.org', () => {
  assert.deepEqual(buildNoPendingResponse(), {
    success: true,
    accepted: 0,
    message: 'No claimable episode',
  })
})
