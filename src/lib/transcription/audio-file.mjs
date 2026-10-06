// Worker-side audio preparation: download the complete file, convert it with ffmpeg to a
// small speech-grade MP3 (mono, 16 kHz, 32 kbit/s – Whisper resamples to 16 kHz mono anyway)
// and upload it in one piece. Only audio that is still above the upload limit is split, by
// time and with ffmpeg, into standalone MP3 files – never blindly by bytes, which cuts MP3
// frames and makes providers reject the piece.
//
// Uses node:child_process/fs, so it is for the Docker worker only (the Vercel route keeps the
// byte-range path in audio-transcriber.mjs). The ffmpeg runner is injectable for tests.

import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import {
  OPENAI_TRANSCRIPTION_MAX_SIZE,
  TRANSCRIPTION_CHUNK_TARGET_SIZE,
  joinTranscriptChunks,
} from '../cron/transcribe-ack.mjs'
import { PermanentError, assertSpeech } from './audio-transcriber.mjs'

const execFileAsync = promisify(execFile)

export const TRANSCODE_SAMPLE_RATE = 16_000
export const TRANSCODE_BITRATE_KBPS = 32
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
// Segments are sized from the constant bitrate with headroom for container overhead.
const SEGMENT_SIZE_SAFETY = 0.9

/** Runs ffmpeg with a hard timeout; maps failures to temporary vs. permanent errors. */
export function createFfmpeg({ binary = 'ffmpeg', timeoutMs, execFileImpl = execFileAsync }) {
  return {
    async run(args) {
      try {
        await execFileImpl(binary, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024 * 1024,
        })
      } catch (err) {
        if (err?.code === 'ENOENT') throw new Error('ffmpeg ist nicht installiert oder FFMPEG_PATH ist falsch')
        if (err?.killed || err?.signal === 'SIGKILL') {
          throw new Error(`ffmpeg nach ${Math.round(timeoutMs / 1000)}s abgebrochen (Timeout) – kein Teilergebnis verwendet`)
        }
        const detail = String(err?.stderr ?? '').trim().split('\n').filter(Boolean).at(-1) ?? (err instanceof Error ? err.message : String(err))
        throw new PermanentError(`Audio konnte nicht umgewandelt werden: ${detail.slice(0, 300)}`)
      }
    },
  }
}

/**
 * Streams the audio at `url` into `path`. HTTP errors are permanent (as before); a download
 * that ends early or times out is temporary. Returns `{ path, bytes, contentType }`.
 */
export async function downloadAudioToFile({ url, fetchImpl = fetch, path: target, timeoutMs, maxBytes = MAX_DOWNLOAD_BYTES }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {})
    throw new PermanentError(`Audio nicht erreichbar (HTTP ${response.status})`)
  }

  const expected = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length') || 0)
  if (expected > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw new PermanentError(`Audiodatei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB`)
  }

  let bytes = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        callback(new PermanentError(`Audiodatei ist größer als ${Math.round(maxBytes / 1024 / 1024)} MB`))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    if (!response.body) throw new Error('Antwort ohne Inhalt')
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(target))
  } catch (err) {
    await rm(target, { force: true })
    if (err instanceof PermanentError) throw err
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`Audio-Download nach ${Math.round(timeoutMs / 1000)}s abgebrochen (Timeout) – kein Teilergebnis verwendet`)
    }
    throw new Error(`Audio-Download fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (bytes === 0) {
    await rm(target, { force: true })
    throw new PermanentError('Audiodatei ist leer')
  }
  if (expected > 0 && bytes !== expected) {
    await rm(target, { force: true })
    throw new Error(`Audio-Download unvollständig (${bytes} von ${expected} Bytes)`)
  }
  return { path: target, bytes, contentType: response.headers.get('content-type') }
}

/**
 * Converts `inputPath` (any format ffmpeg reads) into upload-ready MP3 files in `workDir`:
 * one file if it fits `maxUploadBytes`, otherwise ordered time segments ≤ `segmentTargetBytes`.
 */
export async function prepareAudioForTranscription({
  inputPath,
  workDir,
  ffmpeg,
  maxUploadBytes = OPENAI_TRANSCRIPTION_MAX_SIZE,
  segmentTargetBytes = TRANSCRIPTION_CHUNK_TARGET_SIZE,
}) {
  const transcoded = path.join(workDir, 'transcoded.mp3')
  await ffmpeg.run([
    '-i', inputPath,
    '-vn', '-map_metadata', '-1',
    '-ac', '1', '-ar', String(TRANSCODE_SAMPLE_RATE),
    '-c:a', 'libmp3lame', '-b:a', `${TRANSCODE_BITRATE_KBPS}k`,
    transcoded,
  ])
  const size = (await stat(transcoded).catch(() => null))?.size ?? 0
  if (size === 0) throw new PermanentError('Audio konnte nicht umgewandelt werden: keine Tonspur gefunden')
  if (size <= maxUploadBytes) return [transcoded]

  const bytesPerSecond = (TRANSCODE_BITRATE_KBPS * 1000) / 8
  const segmentSeconds = Math.max(1, (segmentTargetBytes / bytesPerSecond) * SEGMENT_SIZE_SAFETY)
  await ffmpeg.run([
    '-i', transcoded,
    '-map', '0:a', '-c', 'copy',
    '-f', 'segment', '-segment_time', segmentSeconds.toFixed(2), '-segment_format', 'mp3', '-reset_timestamps', '1',
    path.join(workDir, 'segment-%04d.mp3'),
  ])
  await rm(transcoded, { force: true })

  const segments = (await readdir(workDir))
    .filter((name) => /^segment-\d{4}\.mp3$/.test(name))
    .sort()
    .map((name) => path.join(workDir, name))
  if (segments.length === 0) throw new PermanentError('Audio konnte nicht in Segmente geteilt werden')
  for (const segment of segments) {
    if ((await stat(segment)).size > maxUploadBytes) {
      throw new PermanentError(`Audio-Segment ${path.basename(segment)} ist größer als das Upload-Limit`)
    }
  }
  return segments
}

/**
 * Converts and transcribes an audio file completely. Segments are transcribed strictly in
 * order and joined only after every one succeeded; any failure rejects, so a partial
 * transcript is never returned. `onProgress({ stage })` runs after the conversion and
 * `onChunkTranscribed({ index, total })` after each segment of a multi-part upload; both may
 * throw (e.g. lost worker lease) to stop before the next upload.
 */
export async function transcribeAudioFile({
  inputPath,
  workDir,
  ffmpeg,
  transcribeChunk,
  onChunkTranscribed = async () => {},
  onProgress = async () => {},
  maxUploadBytes,
  segmentTargetBytes,
}) {
  const segments = await prepareAudioForTranscription({ inputPath, workDir, ffmpeg, maxUploadBytes, segmentTargetBytes })
  await onProgress({ stage: 'transcode' })

  const format = { contentType: 'audio/mpeg', ext: 'mp3' }
  if (segments.length === 1) {
    return assertSpeech(await transcribeChunk(await readFile(segments[0]), { ...format, basename: 'episode' }))
  }

  const transcripts = []
  for (const [index, segment] of segments.entries()) {
    const basename = `episode-part-${index + 1}-of-${segments.length}`
    transcripts.push(await transcribeChunk(await readFile(segment), { ...format, basename }))
    await onChunkTranscribed({ index, total: segments.length })
  }
  return assertSpeech(joinTranscriptChunks(transcripts))
}
