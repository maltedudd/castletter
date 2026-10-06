import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PermanentError,
  transcribeAudioFromUrl,
  createOpenRouterChunkTranscriber,
  withProviderDetail,
  getAudioExtension,
  extractTranscriptText,
} from '../../src/lib/transcription/audio-transcriber.mjs'
import {
  OPENAI_TRANSCRIPTION_MAX_SIZE,
  TRANSCRIPTION_CHUNK_TARGET_SIZE,
} from '../../src/lib/cron/transcribe-ack.mjs'

const AUDIO_URL = 'https://cdn.example.com/episode.mp3?token=abc'

/** Fake fetch response: only the fields audio-transcriber reads. */
function fakeResponse({ status = 200, headers = {}, body = Buffer.alloc(0) }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: { cancel: async () => {} },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    },
  }
}

/** Records chunk uploads and answers with "part-<n>" so join order is observable. */
function recordingTranscriber() {
  const calls = []
  const transcribeChunk = async (buffer, meta) => {
    calls.push({ size: buffer.length, ...meta })
    return `part-${calls.length}`
  }
  return { calls, transcribeChunk }
}

test('small episode is uploaded once and returned as-is', async () => {
  const { calls, transcribeChunk } = recordingTranscriber()
  const fetchImpl = async () =>
    fakeResponse({ headers: { 'content-length': '1000', 'content-type': 'audio/mpeg' }, body: Buffer.alloc(1000) })

  const transcript = await transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk, fetchImpl })

  assert.equal(transcript, 'part-1')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { size: 1000, contentType: 'audio/mpeg', ext: 'mp3', basename: 'episode' })
})

test('large episode is transcribed via ordered HTTP range chunks and joined in order', async () => {
  const totalBytes = TRANSCRIPTION_CHUNK_TARGET_SIZE * 2 + 10
  const requestedRanges = []
  const fetchImpl = async (_url, init = {}) => {
    const range = init.headers?.Range
    if (!range) {
      return fakeResponse({ headers: { 'content-length': String(totalBytes), 'content-type': 'audio/mpeg' } })
    }
    requestedRanges.push(range)
    return fakeResponse({ status: 206, body: Buffer.alloc(10) })
  }
  const { calls, transcribeChunk } = recordingTranscriber()
  const progress = []

  const transcript = await transcribeAudioFromUrl({
    audioUrl: AUDIO_URL,
    transcribeChunk,
    fetchImpl,
    onChunkTranscribed: async (info) => progress.push(info),
  })

  assert.equal(transcript, 'part-1\n\npart-2\n\npart-3')
  assert.deepEqual(requestedRanges, [
    `bytes=0-${TRANSCRIPTION_CHUNK_TARGET_SIZE - 1}`,
    `bytes=${TRANSCRIPTION_CHUNK_TARGET_SIZE}-${TRANSCRIPTION_CHUNK_TARGET_SIZE * 2 - 1}`,
    `bytes=${TRANSCRIPTION_CHUNK_TARGET_SIZE * 2}-${totalBytes - 1}`,
  ])
  assert.deepEqual(calls.map((c) => c.basename), [
    'episode-part-1-of-3',
    'episode-part-2-of-3',
    'episode-part-3-of-3',
  ])
  assert.deepEqual(progress, [
    { index: 0, total: 3 },
    { index: 1, total: 3 },
    { index: 2, total: 3 },
  ])
})

test('a failing progress callback aborts before any further chunk is transcribed', async () => {
  const totalBytes = TRANSCRIPTION_CHUNK_TARGET_SIZE * 3
  const fetchImpl = async (_url, init = {}) =>
    init.headers?.Range
      ? fakeResponse({ status: 206, body: Buffer.alloc(10) })
      : fakeResponse({ headers: { 'content-length': String(totalBytes) } })
  const { calls, transcribeChunk } = recordingTranscriber()

  await assert.rejects(
    transcribeAudioFromUrl({
      audioUrl: AUDIO_URL,
      transcribeChunk,
      fetchImpl,
      onChunkTranscribed: async () => {
        throw new Error('lease lost')
      },
    }),
    /lease lost/
  )
  assert.equal(calls.length, 1)
})

test('range chunking requires HTTP 206 and never returns a partial transcript', async () => {
  const fetchImpl = async (_url, init = {}) =>
    init.headers?.Range
      ? fakeResponse({ status: 200, body: Buffer.alloc(10) })
      : fakeResponse({ headers: { 'content-length': String(OPENAI_TRANSCRIPTION_MAX_SIZE + 1) } })
  const { calls, transcribeChunk } = recordingTranscriber()

  await assert.rejects(
    transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk, fetchImpl }),
    (err) => err instanceof PermanentError && /Range-Chunking/.test(err.message)
  )
  assert.equal(calls.length, 0)
})

test('oversized range chunk is a permanent error', async () => {
  const fetchImpl = async (_url, init = {}) =>
    init.headers?.Range
      ? fakeResponse({ status: 206, body: Buffer.alloc(OPENAI_TRANSCRIPTION_MAX_SIZE + 1) })
      : fakeResponse({ headers: { 'content-length': String(OPENAI_TRANSCRIPTION_MAX_SIZE + 1) } })
  const { transcribeChunk } = recordingTranscriber()

  await assert.rejects(
    transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk, fetchImpl }),
    (err) => err instanceof PermanentError && /zu groß/.test(err.message)
  )
})

test('large body without content-length is split in memory into ordered chunks', async () => {
  const body = Buffer.alloc(OPENAI_TRANSCRIPTION_MAX_SIZE + 1)
  const fetchImpl = async () => fakeResponse({ headers: { 'content-type': 'audio/mp4' }, body })
  const { calls, transcribeChunk } = recordingTranscriber()
  const progress = []

  const transcript = await transcribeAudioFromUrl({
    audioUrl: 'https://cdn.example.com/feed/episode',
    transcribeChunk,
    fetchImpl,
    onChunkTranscribed: async (info) => progress.push(info),
  })

  assert.equal(transcript, 'part-1\n\npart-2')
  assert.deepEqual(calls.map((c) => [c.size, c.ext]), [
    [TRANSCRIPTION_CHUNK_TARGET_SIZE, 'm4a'],
    [OPENAI_TRANSCRIPTION_MAX_SIZE + 1 - TRANSCRIPTION_CHUNK_TARGET_SIZE, 'm4a'],
  ])
  assert.deepEqual(progress, [{ index: 0, total: 2 }, { index: 1, total: 2 }])
})

test('unreachable audio is a permanent error', async () => {
  const fetchImpl = async () => fakeResponse({ status: 404 })
  const { transcribeChunk } = recordingTranscriber()

  await assert.rejects(
    transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk, fetchImpl }),
    (err) => err instanceof PermanentError && /HTTP 404/.test(err.message)
  )
})

test('empty transcript is a permanent error, not a success', async () => {
  const fetchImpl = async () => fakeResponse({ headers: { 'content-length': '10' }, body: Buffer.alloc(10) })

  await assert.rejects(
    transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk: async () => '   ', fetchImpl }),
    (err) => err instanceof PermanentError && /Keine Sprache erkannt/.test(err.message)
  )
})

test('network errors stay temporary (not PermanentError)', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }

  await assert.rejects(
    transcribeAudioFromUrl({ audioUrl: AUDIO_URL, transcribeChunk: async () => 'x', fetchImpl }),
    (err) => !(err instanceof PermanentError) && /fetch failed/.test(err.message)
  )
})

test('download timeout is passed as an abort signal to every request', async () => {
  const signals = []
  const fetchImpl = async (_url, init = {}) => {
    signals.push(init.signal)
    return fakeResponse({ headers: { 'content-length': '10' }, body: Buffer.alloc(10) })
  }

  await transcribeAudioFromUrl({
    audioUrl: AUDIO_URL,
    transcribeChunk: async () => 'x',
    fetchImpl,
    downloadTimeoutMs: 1234,
  })

  assert.equal(signals.length, 1)
  assert.ok(signals[0] instanceof AbortSignal)
})

test('createOpenRouterChunkTranscriber uploads a named file with the configured model', async () => {
  const requests = []
  const openrouter = {
    audio: {
      transcriptions: {
        create: async (params) => {
          requests.push(params)
          return { text: 'hallo welt' }
        },
      },
    },
  }

  const transcribeChunk = createOpenRouterChunkTranscriber(openrouter, 'openai/whisper-large-v3')
  const text = await transcribeChunk(Buffer.from('abc'), {
    contentType: 'audio/mpeg',
    ext: 'mp3',
    basename: 'episode-part-1-of-2',
  })

  assert.equal(text, 'hallo welt')
  assert.equal(requests[0].model, 'openai/whisper-large-v3')
  assert.equal(requests[0].file.name, 'episode-part-1-of-2.mp3')
  assert.equal(requests[0].file.type, 'audio/mpeg')
  assert.equal(requests[0].file.size, 3)
})

test('provider errors from OpenRouter carry the upstream detail into the message', async () => {
  const apiError = Object.assign(new Error('400 Provider returned 400'), {
    status: 400,
    error: { message: 'Provider returned 400', code: 400, metadata: { provider_name: 'Groq', raw: '{"error":{"message":"could not process file - is it a valid media file?"}}' } },
  })
  const openrouter = { audio: { transcriptions: { create: async () => { throw apiError } } } }
  const transcribeChunk = createOpenRouterChunkTranscriber(openrouter, 'openai/whisper-large-v3')

  await assert.rejects(
    transcribeChunk(Buffer.from('abc'), { contentType: 'audio/mpeg', ext: 'mp3', basename: 'episode' }),
    (err) =>
      !(err instanceof PermanentError) &&
      err.status === 400 &&
      err.cause === apiError &&
      err.message === '400 Provider returned 400 (Groq: {"error":{"message":"could not process file - is it a valid media file?"}})'
  )

  // Without upstream detail the original error is passed through unchanged.
  const plain = new Error('fetch failed')
  assert.equal(withProviderDetail(plain), plain)
  assert.match(withProviderDetail({ message: 'x', error: { metadata: { raw: 'a'.repeat(1000) } } }).message, /^x \(a{300}\)$/)
})

test('getAudioExtension prefers URL extension, then content-type, then mp3', () => {
  assert.equal(getAudioExtension('https://x/a.M4A?x=1', 'audio/mpeg'), 'm4a')
  assert.equal(getAudioExtension('https://x/a', 'audio/ogg; codecs=opus'), 'ogg')
  assert.equal(getAudioExtension('https://x/a', null), 'mp3')
})

test('extractTranscriptText handles string, object and empty responses', () => {
  assert.equal(extractTranscriptText('plain'), 'plain')
  assert.equal(extractTranscriptText({ text: 'obj' }), 'obj')
  assert.equal(extractTranscriptText({ text: null }), '')
  assert.equal(extractTranscriptText(undefined), '')
})
