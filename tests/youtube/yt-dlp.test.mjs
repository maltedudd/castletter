import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyYtDlpError, createYtDlpClient } from '../../src/lib/youtube/yt-dlp.mjs'
import { YouTubePermanentError, YouTubeTemporaryError } from '../../src/lib/youtube/transcript.mjs'

const VIDEO_ID = 'abcDEF12345'
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`

/** Fake execFile: records the call and writes the files yt-dlp would write into the -o directory. */
function fakeExec({ stdout = '', files = {}, error } = {}) {
  const calls = []
  const execFileImpl = async (binary, args, options) => {
    calls.push({ binary, args, options })
    if (error) throw error
    const outputIndex = args.indexOf('-o')
    if (outputIndex !== -1) {
      const dir = path.dirname(args[outputIndex + 1])
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content)
    }
    return { stdout, stderr: '' }
  }
  return { calls, execFileImpl }
}

async function makeTmpRoot() {
  return mkdtemp(path.join(tmpdir(), 'castletter-test-'))
}

test('fetchMetadata runs yt-dlp with a timeout and parses its JSON', async () => {
  const { calls, execFileImpl } = fakeExec({ stdout: JSON.stringify({ id: VIDEO_ID, duration: 61 }) })
  const client = createYtDlpClient({ binary: '/opt/yt-dlp', timeoutMs: 5000, execFileImpl })

  assert.deepEqual(await client.fetchMetadata(VIDEO_ID), { id: VIDEO_ID, duration: 61 })
  assert.equal(calls[0].binary, '/opt/yt-dlp')
  assert.deepEqual(calls[0].args.slice(-3), ['--dump-single-json', '--skip-download', WATCH_URL])
  assert.equal(calls[0].options.timeout, 5000)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
})

test('fetchMetadata rejects video IDs that are not 11 URL-safe characters (no argument injection)', async () => {
  const { execFileImpl, calls } = fakeExec()
  const client = createYtDlpClient({ timeoutMs: 1000, execFileImpl })
  await assert.rejects(client.fetchMetadata('--exec=rm'), /Ungültige YouTube-Video-ID/)
  assert.equal(calls.length, 0)
})

test('downloadCaptions requests the selected track as json3 and cleans up its temp dir', async () => {
  const tmpRoot = await makeTmpRoot()
  const doc = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hallo' }] }] }
  const { calls, execFileImpl } = fakeExec({ files: { 'captions.de-orig.json3': JSON.stringify(doc) } })
  const client = createYtDlpClient({ timeoutMs: 1000, execFileImpl, tmpRoot })

  assert.deepEqual(await client.downloadCaptions(VIDEO_ID, { language: 'de-orig', automatic: true }), doc)
  const args = calls[0].args
  assert.ok(args.includes('--write-auto-subs') && !args.includes('--write-subs'))
  assert.equal(args[args.indexOf('--sub-langs') + 1], 'de-orig')
  assert.equal(args[args.indexOf('--sub-format') + 1], 'json3')
  assert.deepEqual(await readdir(tmpRoot), [])

  const manual = fakeExec({ files: {} })
  const manualClient = createYtDlpClient({ timeoutMs: 1000, execFileImpl: manual.execFileImpl, tmpRoot })
  await assert.rejects(manualClient.downloadCaptions(VIDEO_ID, { language: 'en', automatic: false }), /nicht erzeugt/)
  assert.ok(manual.calls[0].args.includes('--write-subs'))
  assert.deepEqual(await readdir(tmpRoot), [])
})

test('downloadAudio extracts the complete audio as mono MP3 and returns it in memory', async () => {
  const tmpRoot = await makeTmpRoot()
  const { calls, execFileImpl } = fakeExec({ files: { 'audio.mp3': 'ID3-audio' } })
  const client = createYtDlpClient({ timeoutMs: 1000, execFileImpl, tmpRoot })

  const audio = await client.downloadAudio(VIDEO_ID)

  assert.equal(audio.audioBuffer.toString(), 'ID3-audio')
  assert.deepEqual([audio.contentType, audio.ext], ['audio/mpeg', 'mp3'])
  const args = calls[0].args
  assert.ok(args.includes('--extract-audio'))
  assert.equal(args[args.indexOf('--audio-format') + 1], 'mp3')
  assert.equal(args[args.indexOf('--postprocessor-args') + 1], 'ExtractAudio:-ac 1')
  assert.ok(!args.some((a) => /download-sections|max-filesize/.test(a)), 'no partial download options')
  assert.deepEqual(await readdir(tmpRoot), [])

  const noFile = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec().execFileImpl, tmpRoot })
  await assert.rejects(noFile.downloadAudio(VIDEO_ID), (err) => err.code === 'audio_download_failed')
})

test('classifyYtDlpError maps stderr and process failures to actionable codes', () => {
  const stderr = (line) => Object.assign(new Error('Command failed'), { stderr: `[youtube] x: Downloading\nERROR: [youtube] ${VIDEO_ID}: ${line}\n` })
  const classify = (err, operationCode = 'youtube_fetch_failed') => classifyYtDlpError(err, { operationCode, timeoutMs: 600_000 })

  const privateVideo = classify(stderr('Private video. Sign in if you\'ve been granted access to this video'))
  assert.ok(privateVideo instanceof YouTubePermanentError)
  assert.equal(privateVideo.code, 'video_unavailable')
  assert.match(privateVideo.message, /^Video nicht verfügbar: \[youtube\] abcDEF12345: Private video/)

  assert.equal(classify(stderr('Video unavailable. This video has been removed by the uploader')).code, 'video_unavailable')
  // Verbatim yt-dlp 2026.08.19 output for a non-existent video ID.
  assert.equal(classify(stderr('This video is unavailable')).code, 'video_unavailable')
  assert.equal(classify(stderr('Join this channel to get access to members-only content')).code, 'video_unavailable')

  const premiere = classify(stderr('Premieres in 3 hours'))
  assert.ok(premiere instanceof YouTubeTemporaryError)
  assert.equal(premiere.code, 'video_not_yet_available')

  assert.equal(classify(stderr('Sign in to confirm you’re not a bot')).code, 'youtube_blocked')
  assert.equal(classify(stderr('HTTP Error 429: Too Many Requests')).code, 'youtube_blocked')

  const other = classify(stderr('Unable to extract player response'), 'audio_download_failed')
  assert.ok(other instanceof YouTubeTemporaryError)
  assert.equal(other.code, 'audio_download_failed')

  const timeout = classify(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }), 'audio_download_failed')
  assert.ok(timeout instanceof YouTubeTemporaryError)
  assert.equal(timeout.code, 'audio_download_failed')
  assert.match(timeout.message, /nach 600s abgebrochen \(Timeout\) – kein Teilergebnis/)

  const missing = classify(Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }))
  assert.equal(missing.code, 'youtube_tool_missing')
})

test('client errors from yt-dlp surface classified', async () => {
  const error = Object.assign(new Error('Command failed'), { stderr: 'ERROR: Private video' })
  const client = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec({ error }).execFileImpl })
  await assert.rejects(client.fetchMetadata(VIDEO_ID), (err) => err instanceof YouTubePermanentError && err.code === 'video_unavailable')
})
