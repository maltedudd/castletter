import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEpisodeTranscriber } from '../../worker/transcribers.mjs'
import { createFfmpeg } from '../../src/lib/transcription/audio-file.mjs'
import { PermanentError } from '../../src/lib/transcription/audio-transcriber.mjs'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const needsFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg nicht installiert' }
const CONFIG = { downloadTimeoutMs: 5000, youtube: { captionLanguages: ['de'] } }

/** Stereo 128 kbit/s podcast-like MP3 with an ID3 cover-less tag, as bytes. */
async function podcastMp3(seconds) {
  const dir = await mkdtemp(path.join(tmpdir(), 'castletter-pod-'))
  const file = path.join(dir, 'episode.mp3')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=500:duration=${seconds}`,
    '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=Folge', file,
  ])
  return readFile(file)
}

function audioResponse(bytes) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) } })
}

test('podcast episode: whole file downloaded, converted and uploaded once; temp dir removed', needsFfmpeg, async () => {
  const bytes = await podcastMp3(30)
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'castletter-root-'))
  const requests = []
  const uploads = []
  const stages = []

  const transcribe = createEpisodeTranscriber({
    config: CONFIG,
    ffmpeg: createFfmpeg({ timeoutMs: 60_000 }),
    tmpRoot,
    fetchImpl: async (url, init) => {
      requests.push({ url, range: init?.headers?.Range })
      return audioResponse(bytes)
    },
    transcribeChunk: async (buffer, meta) => {
      uploads.push({ size: buffer.length, ...meta })
      return 'Komplettes Transkript der Folge.'
    },
  })

  const transcript = await transcribe(
    { id: 'ep-1', audio_url: 'https://cdn.example/folge.mp3' },
    async () => assert.fail('single upload has no chunk callback'),
    async ({ stage }) => stages.push(stage)
  )

  assert.equal(transcript, 'Komplettes Transkript der Folge.')
  assert.deepEqual(requests, [{ url: 'https://cdn.example/folge.mp3', range: undefined }], 'one plain request, no range chunking')
  assert.equal(uploads.length, 1)
  assert.deepEqual([uploads[0].basename, uploads[0].ext, uploads[0].contentType], ['episode', 'mp3', 'audio/mpeg'])
  assert.ok(uploads[0].size < bytes.length / 3, 'mono 32 kbit/s upload is much smaller than the 128 kbit/s source')
  assert.deepEqual(stages, ['download', 'transcode'])
  assert.deepEqual(await readdir(tmpRoot), [], 'work dir cleaned up')
})

test('podcast episode: unreachable audio stays a permanent error and the temp dir is removed', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'castletter-root-'))
  const transcribe = createEpisodeTranscriber({
    config: CONFIG,
    ffmpeg: createFfmpeg({ timeoutMs: 1000 }),
    tmpRoot,
    fetchImpl: async () => new Response('gone', { status: 410 }),
    transcribeChunk: async () => assert.fail('nothing to upload'),
  })

  await assert.rejects(
    transcribe({ id: 'ep-1', audio_url: 'https://cdn.example/weg.mp3' }, async () => {}),
    (err) => err instanceof PermanentError && /HTTP 410/.test(err.message)
  )
  assert.deepEqual(await readdir(tmpRoot), [])
})

test('a lost lease during the download keep-alive stops before conversion and upload', needsFfmpeg, async () => {
  const bytes = await podcastMp3(3)
  const leaseLost = new Error('lease lost')
  const transcribe = createEpisodeTranscriber({
    config: CONFIG,
    ffmpeg: createFfmpeg({ timeoutMs: 60_000 }),
    fetchImpl: async () => audioResponse(bytes),
    transcribeChunk: async () => assert.fail('no upload after lost lease'),
  })

  await assert.rejects(
    transcribe({ id: 'ep-1', audio_url: 'https://cdn.example/a.mp3' }, async () => {}, async () => { throw leaseLost }),
    (err) => err === leaseLost
  )
})
