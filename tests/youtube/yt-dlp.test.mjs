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

test('downloadAudio fetches the complete original audio track into the given work dir', async () => {
  const dir = await makeTmpRoot()
  const { calls, execFileImpl } = fakeExec({ files: { 'source.webm': 'opus-audio' } })
  const client = createYtDlpClient({ timeoutMs: 1000, execFileImpl })

  const audio = await client.downloadAudio(VIDEO_ID, { dir })

  assert.deepEqual(audio, { path: path.join(dir, 'source.webm') })
  const args = calls[0].args
  assert.equal(args[args.indexOf('-f') + 1], 'bestaudio/best')
  assert.equal(args[args.indexOf('-o') + 1], path.join(dir, 'source.%(ext)s'))
  assert.ok(!args.some((a) => /download-sections|max-filesize|extract-audio/.test(a)), 'no partial download, no own conversion')

  const empty = await makeTmpRoot()
  const noFile = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec().execFileImpl })
  await assert.rejects(noFile.downloadAudio(VIDEO_ID, { dir: empty }), (err) => err.code === 'audio_download_failed')
  await assert.rejects(noFile.downloadAudio(VIDEO_ID, {}), /Arbeitsverzeichnis/)
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

const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa'

test('listUploads reads the Videos tab flat with approximate dates and maps it to feed entries', async () => {
  const listing = {
    entries: [
      { id: 'video000001', title: 'Neu', timestamp: 1791279540 },
      { id: 'video000002', title: 'Ohne Datum' },
      { id: 'zu-kurz', title: 'Kaputt', timestamp: 1 },
    ],
  }
  const { calls, execFileImpl } = fakeExec({ stdout: JSON.stringify(listing) })
  const client = createYtDlpClient({ timeoutMs: 600_000, listTimeoutMs: 60_000, execFileImpl })

  const entries = await client.listUploads(CHANNEL_ID)

  assert.deepEqual(entries, [
    { videoId: 'video000001', title: 'Neu', published: new Date(1791279540 * 1000).toISOString(), description: null, approximate: true },
    { videoId: 'video000002', title: 'Ohne Datum', published: null, description: null, approximate: true },
  ])
  const { args, options } = calls[0]
  assert.ok(args.includes('--flat-playlist') && args.includes('--dump-single-json'))
  assert.equal(args[args.indexOf('--playlist-end') + 1], '15')
  assert.equal(args[args.indexOf('--extractor-args') + 1], 'youtubetab:approximate_date')
  assert.equal(args.at(-1), `https://www.youtube.com/channel/${CHANNEL_ID}/videos`)
  assert.equal(options.timeout, 60_000, 'listing uses its own short timeout')

  await assert.rejects(client.listUploads('@handle'), /Ungültige YouTube-Channel-ID/)
  const broken = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec({ stdout: 'kein json' }).execFileImpl })
  await assert.rejects(broken.listUploads(CHANNEL_ID), (err) => err.code === 'youtube_fetch_failed')
})

test('fetchPublishTimes returns exact times and tolerates single unavailable videos', async () => {
  const stdout = 'video000001 1791279540\nvideo000002 NA\n'
  const { calls, execFileImpl } = fakeExec({ stdout })
  const client = createYtDlpClient({ timeoutMs: 1000, listTimeoutMs: 30_000, execFileImpl })

  assert.deepEqual(await client.fetchPublishTimes(['video000001', 'video000002']), {
    video000001: new Date(1791279540 * 1000).toISOString(),
  })
  const { args, options } = calls[0]
  assert.ok(args.includes('--skip-download') && args.includes('--ignore-errors'))
  assert.equal(args[args.indexOf('--print') + 1], '%(id)s %(timestamp)s')
  assert.deepEqual(args.slice(-2), ['https://www.youtube.com/watch?v=video000001', 'https://www.youtube.com/watch?v=video000002'])
  assert.equal(options.timeout, 30_000)

  // yt-dlp exits non-zero when one URL fails, but still printed the others.
  const partialError = Object.assign(new Error('Command failed'), { stdout: 'video000001 1791279540\n', stderr: 'ERROR: [youtube] video000002: Private video' })
  const partial = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec({ error: partialError }).execFileImpl })
  assert.deepEqual(Object.keys(await partial.fetchPublishTimes(['video000001', 'video000002'])), ['video000001'])

  // Nothing printed at all: a real failure (e.g. bot check) is reported.
  const blocked = Object.assign(new Error('Command failed'), { stdout: '', stderr: 'ERROR: HTTP Error 429: Too Many Requests' })
  const blockedClient = createYtDlpClient({ timeoutMs: 1000, execFileImpl: fakeExec({ error: blocked }).execFileImpl })
  await assert.rejects(blockedClient.fetchPublishTimes(['video000001']), (err) => err.code === 'youtube_blocked')

  assert.deepEqual(await client.fetchPublishTimes([]), {})
  await assert.rejects(client.fetchPublishTimes(['--exec=x']), /Ungültige YouTube-Video-ID/)
})
