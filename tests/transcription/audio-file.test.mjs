import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TRANSCODE_BITRATE_KBPS,
  TRANSCODE_SAMPLE_RATE,
  createFfmpeg,
  downloadAudioToFile,
  prepareAudioForTranscription,
  transcribeAudioFile,
} from '../../src/lib/transcription/audio-file.mjs'
import { PermanentError } from '../../src/lib/transcription/audio-transcriber.mjs'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe nicht installiert' }

async function workDir() {
  return mkdtemp(path.join(tmpdir(), 'castletter-audio-test-'))
}

/** Stereo 128 kbit/s 44.1 kHz MP3 tone – like a typical podcast file. */
async function toneFile(dir, seconds, name = 'tone.mp3') {
  const file = path.join(dir, name)
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=44100`,
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', file,
  ])
  return file
}

function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration', '-of', 'json', file,
  ]).toString()
  const json = JSON.parse(out)
  return { ...json.streams[0], duration: Number(json.format.duration) }
}

const ffmpeg = createFfmpeg({ timeoutMs: 60_000 })

test('small audio is converted to mono 16 kHz MP3 and uploaded once', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = await toneFile(dir, 20)

  const segments = await prepareAudioForTranscription({ inputPath: input, workDir: dir, ffmpeg })

  assert.equal(segments.length, 1)
  const info = probe(segments[0])
  assert.deepEqual([info.codec_name, info.channels, Number(info.sample_rate)], ['mp3', 1, TRANSCODE_SAMPLE_RATE])
  assert.ok(Math.abs(info.duration - 20) < 0.5)
  // 32 kbit/s instead of 128 kbit/s stereo: roughly a quarter of the size.
  assert.ok((await stat(segments[0])).size < (await stat(input)).size / 3)
  assert.equal(TRANSCODE_BITRATE_KBPS, 32)
})

test('audio above the upload limit is split by time into standalone, ordered MP3 segments', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = await toneFile(dir, 60)
  // 32 kbit/s ≈ 4 KB/s: 60 s ≈ 240 KB. Limits scaled down so the test splits.
  const segments = await prepareAudioForTranscription({
    inputPath: input, workDir: dir, ffmpeg, maxUploadBytes: 100_000, segmentTargetBytes: 80_000,
  })

  assert.ok(segments.length >= 3, `expected several segments, got ${segments.length}`)
  assert.deepEqual(segments, [...segments].sort())
  let total = 0
  for (const segment of segments) {
    assert.ok((await stat(segment)).size <= 100_000)
    const info = probe(segment) // every segment is decodable on its own
    assert.equal(info.codec_name, 'mp3')
    total += info.duration
  }
  assert.ok(Math.abs(total - 60) < 1, `segments cover the whole audio (got ${total}s)`)
})

test('undecodable input is a permanent error', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = path.join(dir, 'garbage.mp3')
  await writeFile(input, Buffer.from('<html>kein Audio</html>'))
  await assert.rejects(
    prepareAudioForTranscription({ inputPath: input, workDir: dir, ffmpeg }),
    (err) => err instanceof PermanentError && /Audio konnte nicht umgewandelt werden/.test(err.message)
  )
})

test('missing ffmpeg and timeouts are temporary errors, never partial results', async () => {
  const missing = createFfmpeg({ binary: '/nonexistent/ffmpeg', timeoutMs: 1000 })
  await assert.rejects(missing.run(['-version']), (err) => !(err instanceof PermanentError) && /ffmpeg ist nicht installiert/.test(err.message))

  const slow = createFfmpeg({
    timeoutMs: 5000,
    execFileImpl: async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }) },
  })
  await assert.rejects(slow.run(['-i', 'x']), (err) => !(err instanceof PermanentError) && /nach 5s abgebrochen \(Timeout\)/.test(err.message))
})

test('transcribeAudioFile transcribes all segments in order and joins only after all succeeded', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = await toneFile(dir, 60)
  const uploads = []
  const progress = []
  const stages = []

  const transcript = await transcribeAudioFile({
    inputPath: input,
    workDir: dir,
    ffmpeg,
    maxUploadBytes: 100_000,
    segmentTargetBytes: 80_000,
    transcribeChunk: async (buffer, meta) => {
      uploads.push({ size: buffer.length, ...meta })
      return `teil-${uploads.length}`
    },
    onChunkTranscribed: async (info) => progress.push(info),
    onProgress: async ({ stage }) => stages.push(stage),
  })

  const n = uploads.length
  assert.ok(n >= 3)
  assert.equal(transcript, Array.from({ length: n }, (_, i) => `teil-${i + 1}`).join('\n\n'))
  assert.ok(uploads.every((u) => u.contentType === 'audio/mpeg' && u.ext === 'mp3' && u.size <= 100_000))
  assert.deepEqual(uploads.map((u) => u.basename), Array.from({ length: n }, (_, i) => `episode-part-${i + 1}-of-${n}`))
  assert.deepEqual(progress.map((p) => [p.index, p.total]), Array.from({ length: n }, (_, i) => [i, n]))
  assert.deepEqual(stages, ['transcode'])
})

test('transcribeAudioFile: single upload is named "episode"; failures and empty text never succeed', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = await toneFile(dir, 5)

  const names = []
  const text = await transcribeAudioFile({
    inputPath: input, workDir: dir, ffmpeg,
    transcribeChunk: async (_buffer, meta) => { names.push(meta.basename); return 'ganzer Text' },
  })
  assert.equal(text, 'ganzer Text')
  assert.deepEqual(names, ['episode'])

  let calls = 0
  await assert.rejects(
    transcribeAudioFile({
      inputPath: input, workDir: dir, ffmpeg, maxUploadBytes: 10_000, segmentTargetBytes: 8_000,
      transcribeChunk: async () => { calls++; if (calls === 2) throw new Error('OpenRouter 503'); return 'x' },
    }),
    /OpenRouter 503/
  )
  assert.equal(calls, 2, 'no further segment after a failure')

  await assert.rejects(
    transcribeAudioFile({ inputPath: input, workDir: dir, ffmpeg, transcribeChunk: async () => '  ' }),
    (err) => err instanceof PermanentError && /Keine Sprache erkannt/.test(err.message)
  )
})

test('transcribeAudioFile: a failing onProgress/onChunkTranscribed aborts before further uploads', needsFfmpeg, async () => {
  const dir = await workDir()
  const input = await toneFile(dir, 30)
  const leaseLost = new Error('lease lost')
  let uploads = 0
  await assert.rejects(
    transcribeAudioFile({
      inputPath: input, workDir: dir, ffmpeg, maxUploadBytes: 50_000, segmentTargetBytes: 40_000,
      transcribeChunk: async () => { uploads++; return 'x' },
      onChunkTranscribed: async () => { throw leaseLost },
    }),
    (err) => err === leaseLost
  )
  assert.equal(uploads, 1)

  await assert.rejects(
    transcribeAudioFile({
      inputPath: input, workDir: dir, ffmpeg,
      transcribeChunk: async () => assert.fail('no upload after lost lease'),
      onProgress: async () => { throw leaseLost },
    }),
    (err) => err === leaseLost
  )
})

// ─── Download ────────────────────────────────────────────────────────

test('downloadAudioToFile streams the complete body into a file', async () => {
  const dir = await workDir()
  const body = Buffer.alloc(300_000, 7)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, hasSignal: init?.signal instanceof AbortSignal })
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length), 'content-type': 'audio/mpeg' } })
  }

  const result = await downloadAudioToFile({ url: 'https://cdn.example/a.mp3', fetchImpl, path: path.join(dir, 'source'), timeoutMs: 1000 })

  assert.deepEqual(result, { path: path.join(dir, 'source'), bytes: body.length, contentType: 'audio/mpeg' })
  assert.ok((await readFile(result.path)).equals(body))
  assert.deepEqual(calls, [{ url: 'https://cdn.example/a.mp3', hasSignal: true }])
})

test('downloadAudioToFile: HTTP errors are permanent, truncated downloads temporary, oversize rejected', async () => {
  const dir = await workDir()
  const target = path.join(dir, 'source')

  await assert.rejects(
    downloadAudioToFile({ url: 'u', fetchImpl: async () => new Response('nope', { status: 404 }), path: target, timeoutMs: 1000 }),
    (err) => err instanceof PermanentError && /Audio nicht erreichbar \(HTTP 404\)/.test(err.message)
  )

  const truncated = async () => new Response(Buffer.alloc(10), { status: 200, headers: { 'content-length': '20' } })
  await assert.rejects(
    downloadAudioToFile({ url: 'u', fetchImpl: truncated, path: target, timeoutMs: 1000 }),
    (err) => !(err instanceof PermanentError) && /unvollständig \(10 von 20 Bytes\)/.test(err.message)
  )

  const huge = async () => new Response(Buffer.alloc(2000), { status: 200 })
  await assert.rejects(
    downloadAudioToFile({ url: 'u', fetchImpl: huge, path: target, timeoutMs: 1000, maxBytes: 1000 }),
    (err) => err instanceof PermanentError && /größer als/.test(err.message)
  )

  const empty = async () => new Response(Buffer.alloc(0), { status: 200 })
  await assert.rejects(
    downloadAudioToFile({ url: 'u', fetchImpl: empty, path: target, timeoutMs: 1000 }),
    (err) => err instanceof PermanentError && /leer/.test(err.message)
  )
  assert.ok((await readdir(dir)).length <= 1)
})
