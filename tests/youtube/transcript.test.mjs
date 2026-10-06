import assert from 'node:assert/strict'
import test from 'node:test'
import {
  YOUTUBE_ERROR_CODES,
  YouTubePermanentError,
  YouTubeTemporaryError,
  assessCaptions,
  parseJson3Captions,
  selectCaptionTrack,
  transcribeYouTubeVideo,
} from '../../src/lib/youtube/transcript.mjs'
import { PermanentError } from '../../src/lib/transcription/audio-transcriber.mjs'

const VIDEO_ID = 'abcDEF12345'
const json3 = (formats = ['json3', 'vtt']) => formats.map((ext) => ({ ext, url: `https://yt.example/${ext}` }))

/** json3 caption document with one cue per `stepMs`, `words` words each, up to `endMs`. */
function captionsDoc({ endMs, stepMs = 5000, text = 'eins zwei drei vier fünf sechs sieben acht' }) {
  const events = [{ tStartMs: 0, dDurationMs: endMs }] // window event without segs
  for (let t = 0; t + stepMs <= endMs; t += stepMs) {
    events.push({ tStartMs: t, dDurationMs: stepMs, segs: [{ utf8: text.split(' ')[0] }, { utf8: ` ${text.split(' ').slice(1).join(' ')}` }] })
  }
  return { events }
}

test('selectCaptionTrack prefers manual captions in the original language, then de/en, then any', () => {
  const meta = (subtitles, extra = {}) => ({ language: 'fr', subtitles, automatic_captions: {}, ...extra })

  assert.deepEqual(selectCaptionTrack(meta({ en: json3(), 'fr-FR': json3() })), { language: 'fr-FR', automatic: false })
  assert.deepEqual(selectCaptionTrack(meta({ en: json3(), de: json3() }), ['de', 'en']), { language: 'de', automatic: false })
  assert.deepEqual(selectCaptionTrack(meta({ es: json3() })), { language: 'es', automatic: false })
  // live_chat replays and tracks without json3 are ignored.
  assert.equal(selectCaptionTrack(meta({ live_chat: json3(), en: json3(['vtt']) })), null)
})

test('selectCaptionTrack only uses automatic captions in the original spoken language, never machine translations', () => {
  const autos = { de: json3(), en: json3(), 'en-orig': json3(), fr: json3() }
  assert.deepEqual(selectCaptionTrack({ language: 'en', subtitles: {}, automatic_captions: autos }), { language: 'en-orig', automatic: true })
  assert.deepEqual(
    selectCaptionTrack({ language: 'de', subtitles: {}, automatic_captions: { de: json3(), en: json3() } }),
    { language: 'de', automatic: true }
  )
  // Unknown language and no -orig track: we cannot tell which track is the original.
  assert.equal(selectCaptionTrack({ language: null, subtitles: {}, automatic_captions: { de: json3(), en: json3() } }), null)
  assert.equal(selectCaptionTrack({}), null)
})

test('parseJson3Captions joins segments, drops window events and reports coverage', () => {
  const parsed = parseJson3Captions({
    events: [
      { tStartMs: 0, dDurationMs: 600000 },
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hallo ' }, { utf8: 'und' }] },
      { tStartMs: 2000, dDurationMs: 10, segs: [{ utf8: '\n' }] },
      { tStartMs: 2500, dDurationMs: 3000, segs: [{ utf8: 'willkommen &amp;\nzurück' }] },
    ],
  })
  assert.deepEqual(parsed, { text: 'Hallo und willkommen &amp; zurück', lastEndMs: 5500, cueCount: 2 })
  assert.deepEqual(parseJson3Captions({}), { text: '', lastEndMs: 0, cueCount: 0 })
  assert.deepEqual(parseJson3Captions(null), { text: '', lastEndMs: 0, cueCount: 0 })
})

test('assessCaptions accepts complete captions and explains why others are unusable', () => {
  const tenMin = 600
  const complete = parseJson3Captions(captionsDoc({ endMs: 590_000 }))
  assert.deepEqual(assessCaptions(complete, tenMin), { usable: true })
  // Unknown duration: coverage cannot be checked, content checks still apply.
  assert.deepEqual(assessCaptions(complete, null), { usable: true })

  const truncated = parseJson3Captions(captionsDoc({ endMs: 300_000 }))
  assert.deepEqual(assessCaptions(truncated, tenMin), { usable: false, reason: 'Untertitel decken nur 5 von 10 Minuten ab' })

  const noise = parseJson3Captions(captionsDoc({ endMs: 600_000, text: '[Musik] [Applaus]' }))
  assert.equal(assessCaptions(noise, tenMin).usable, false)
  assert.match(assessCaptions(noise, tenMin).reason, /leer oder nur Geräuschhinweise/)

  const sparse = parseJson3Captions(captionsDoc({ endMs: 3_600_000, stepMs: 600_000 }))
  assert.match(assessCaptions(sparse, 3600).reason, /zu wenig Text/)
})

function fakeYouTube({ metadata, captions, captionsError, audio = { audioBuffer: Buffer.from('mp3'), contentType: 'audio/mpeg', ext: 'mp3' }, audioError, metadataError }) {
  const calls = []
  return {
    calls,
    fetchMetadata: async (id) => { calls.push(['metadata', id]); if (metadataError) throw metadataError; return metadata },
    downloadCaptions: async (id, track) => { calls.push(['captions', id, track]); if (captionsError) throw captionsError; return captions },
    downloadAudio: async (id) => { calls.push(['audio', id]); if (audioError) throw audioError; return audio },
  }
}

const META = { id: VIDEO_ID, duration: 600, language: 'de', live_status: 'not_live', availability: 'public', subtitles: { de: json3() }, automatic_captions: {} }

test('captions first: complete captions are used and audio is never downloaded', async () => {
  const youtube = fakeYouTube({ metadata: META, captions: captionsDoc({ endMs: 595_000 }) })
  const transcribeAudio = async () => assert.fail('STT must not run when captions are usable')

  const result = await transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube, transcribeAudio })

  assert.equal(result.source, 'captions')
  assert.match(result.transcript, /^eins zwei drei/)
  assert.deepEqual(youtube.calls.map((c) => c[0]), ['metadata', 'captions'])
  assert.deepEqual(youtube.calls[1][2], { language: 'de', automatic: false })
})

test('fallback: missing, truncated or undownloadable captions lead to a full audio STT transcription', async () => {
  const scenarios = [
    { name: 'no captions', metadata: { ...META, subtitles: {} }, reason: /keine Untertitel vorhanden/ },
    { name: 'truncated', metadata: META, captions: captionsDoc({ endMs: 120_000 }), reason: /decken nur 2 von 10 Minuten/ },
    { name: 'download error', metadata: META, captionsError: new Error('HTTP 429'), reason: /Untertitel-Download fehlgeschlagen: HTTP 429/ },
  ]
  for (const scenario of scenarios) {
    const youtube = fakeYouTube(scenario)
    const sttCalls = []
    const progress = []
    const result = await transcribeYouTubeVideo({
      videoId: VIDEO_ID,
      youtube,
      transcribeAudio: async ({ audioBuffer, contentType, ext, onChunkTranscribed }) => {
        sttCalls.push({ size: audioBuffer.length, contentType, ext })
        await onChunkTranscribed({ index: 0, total: 1 })
        return 'vollständiges STT-Transkript'
      },
      onChunkTranscribed: async (info) => progress.push(info),
    })
    assert.deepEqual(
      { transcript: result.transcript, source: result.source },
      { transcript: 'vollständiges STT-Transkript', source: 'audio_stt' },
      scenario.name
    )
    assert.match(result.captionsReason, scenario.reason, scenario.name)
    assert.deepEqual(sttCalls, [{ size: 3, contentType: 'audio/mpeg', ext: 'mp3' }], scenario.name)
    assert.deepEqual(progress, [{ index: 0, total: 1 }], scenario.name)
  }
})

test('STT failure after unusable captions is persisted with both reasons and keeps its permanence', async () => {
  const youtube = fakeYouTube({ metadata: { ...META, subtitles: {} } })

  await assert.rejects(
    transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube, transcribeAudio: async () => { throw new Error('OpenRouter 503') } }),
    (err) =>
      err instanceof YouTubeTemporaryError &&
      err.code === YOUTUBE_ERROR_CODES.sttFailed &&
      /Keine verwendbaren YouTube-Untertitel \(keine Untertitel vorhanden\); Audio-Transkription fehlgeschlagen: OpenRouter 503/.test(err.message)
  )

  await assert.rejects(
    transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube, transcribeAudio: async () => { throw new PermanentError('Keine Sprache erkannt') } }),
    (err) => err instanceof PermanentError && err.code === YOUTUBE_ERROR_CODES.sttFailed && /Keine Sprache erkannt/.test(err.message)
  )
})

test('audio download failure after unusable captions keeps code and reasons', async () => {
  const youtube = fakeYouTube({
    metadata: { ...META, subtitles: {} },
    audioError: new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.audioDownloadFailed, 'yt-dlp nach 600s abgebrochen (Timeout)'),
  })
  await assert.rejects(
    transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube, transcribeAudio: async () => 'x' }),
    (err) => err instanceof YouTubeTemporaryError && err.code === 'audio_download_failed' && /keine Untertitel vorhanden.*Timeout/.test(err.message)
  )
})

test('a lease-loss thrown by the progress callback propagates unchanged (no wrapping, no success)', async () => {
  class LeaseLost extends Error {}
  const leaseLost = new LeaseLost('lease lost')
  const youtube = fakeYouTube({ metadata: { ...META, subtitles: {} } })

  await assert.rejects(
    transcribeYouTubeVideo({
      videoId: VIDEO_ID,
      youtube,
      transcribeAudio: async ({ onChunkTranscribed }) => { await onChunkTranscribed({ index: 0, total: 2 }); return 'never' },
      onChunkTranscribed: async () => { throw leaseLost },
    }),
    (err) => err === leaseLost
  )
})

test('a lease-loss thrown by onProgress inside the STT step propagates unchanged', async () => {
  const leaseLost = new Error('lease lost')
  const youtube = fakeYouTube({ metadata: { ...META, subtitles: {} } })
  await assert.rejects(
    transcribeYouTubeVideo({
      videoId: VIDEO_ID,
      youtube,
      transcribeAudio: async ({ onProgress }) => { await onProgress({ stage: 'transcode' }); return 'never' },
      onProgress: async ({ stage }) => { if (stage === 'transcode') throw leaseLost },
    }),
    (err) => err === leaseLost
  )
})

test('onProgress runs between download stages and a failure there aborts before the next stage', async () => {
  const stages = []
  const youtube = fakeYouTube({ metadata: { ...META, subtitles: {} } })
  await transcribeYouTubeVideo({
    videoId: VIDEO_ID,
    youtube,
    transcribeAudio: async () => 'ok',
    onProgress: async ({ stage }) => stages.push(stage),
  })
  assert.deepEqual(stages, ['metadata', 'captions', 'audio'])

  const leaseLost = new Error('lease lost')
  const aborted = fakeYouTube({ metadata: { ...META, subtitles: {} } })
  await assert.rejects(
    transcribeYouTubeVideo({
      videoId: VIDEO_ID,
      youtube: aborted,
      transcribeAudio: async () => assert.fail('must not transcribe'),
      onProgress: async ({ stage }) => { if (stage === 'captions') throw leaseLost },
    }),
    (err) => err === leaseLost
  )
  assert.deepEqual(aborted.calls.map((c) => c[0]), ['metadata'])
})

test('unavailable, private and not-yet-live videos fail with clear codes before any download', async () => {
  const cases = [
    [{ ...META, availability: 'private' }, YouTubePermanentError, 'video_unavailable'],
    [{ ...META, availability: 'subscriber_only' }, YouTubePermanentError, 'video_unavailable'],
    [{ ...META, live_status: 'is_upcoming' }, YouTubeTemporaryError, 'video_not_yet_available'],
    [{ ...META, live_status: 'is_live' }, YouTubeTemporaryError, 'video_not_yet_available'],
  ]
  for (const [metadata, ErrorClass, code] of cases) {
    const youtube = fakeYouTube({ metadata })
    await assert.rejects(
      transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube, transcribeAudio: async () => 'x' }),
      (err) => err instanceof ErrorClass && err.code === code
    )
    assert.deepEqual(youtube.calls.map((c) => c[0]), ['metadata'])
  }

  const removed = fakeYouTube({ metadataError: new YouTubePermanentError('video_unavailable', 'Video nicht verfügbar: Private video') })
  await assert.rejects(
    transcribeYouTubeVideo({ videoId: VIDEO_ID, youtube: removed, transcribeAudio: async () => 'x' }),
    (err) => err instanceof PermanentError && err.code === 'video_unavailable'
  )
})

test('YouTube permanent errors are PermanentErrors, temporary ones are not', () => {
  assert.ok(new YouTubePermanentError('video_unavailable', 'x') instanceof PermanentError)
  assert.ok(!(new YouTubeTemporaryError('youtube_blocked', 'x') instanceof PermanentError))
})
