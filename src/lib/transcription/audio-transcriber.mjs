// Full-episode transcription shared by the Vercel cron route and the Docker worker.
// Dependency-free on purpose: the OpenRouter client and fetch are injected, so the
// worker image needs no Next.js and the logic runs under node:test without network.

import {
  buildAudioChunkRanges,
  isTooLargeForSingleTranscriptionUpload,
  joinTranscriptChunks,
} from '../cron/transcribe-ack.mjs'

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 45_000

/** Failure that retrying will not fix (missing audio, no speech, unsupported server). */
export class PermanentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermanentError'
  }
}

/**
 * Downloads and transcribes a complete episode. Chunks are transcribed strictly in order
 * and only joined once every chunk succeeded — any failure rejects, so a partial transcript
 * is never returned.
 *
 * `onChunkTranscribed({ index, total })` runs after each multi-chunk upload; if it throws
 * (e.g. the worker lost its lease) no further chunk is transcribed.
 */
export async function transcribeAudioFromUrl({
  audioUrl,
  transcribeChunk,
  fetchImpl = fetch,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  onChunkTranscribed = async () => {},
}) {
  const response = await fetchImpl(audioUrl, {
    signal: AbortSignal.timeout(downloadTimeoutMs),
  })

  if (!response.ok) {
    throw new PermanentError(`Audio nicht erreichbar (HTTP ${response.status})`)
  }

  const contentLength = Number(response.headers.get('content-length') || 0)
  const contentType = response.headers.get('content-type') || 'audio/mpeg'
  const ext = getAudioExtension(audioUrl, contentType)
  const format = { contentType, ext }

  let transcript
  if (isTooLargeForSingleTranscriptionUpload(contentLength)) {
    // Only the range requests below are needed; release the full-file download.
    await response.body?.cancel?.().catch(() => {})
    transcript = await transcribeRanges({
      audioUrl, totalBytes: contentLength, format, transcribeChunk, fetchImpl, downloadTimeoutMs, onChunkTranscribed,
    })
  } else {
    const audioBuffer = Buffer.from(await response.arrayBuffer())
    transcript = await transcribeBuffer({ audioBuffer, format, transcribeChunk, onChunkTranscribed })
  }

  return assertSpeech(transcript)
}

/**
 * Transcribes an audio file that is already in memory (e.g. YouTube audio extracted to MP3),
 * with the same all-or-nothing chunking as `transcribeAudioFromUrl`.
 */
export async function transcribeAudioBuffer({
  audioBuffer,
  contentType = 'audio/mpeg',
  ext = 'mp3',
  transcribeChunk,
  onChunkTranscribed = async () => {},
}) {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new PermanentError('Audiodatei ist leer')
  }
  const transcript = await transcribeBuffer({ audioBuffer, format: { contentType, ext }, transcribeChunk, onChunkTranscribed })
  return assertSpeech(transcript)
}

function assertSpeech(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    throw new PermanentError('Keine Sprache erkannt – die Episode enthält möglicherweise nur Musik')
  }
  return transcript
}

async function transcribeBuffer({ audioBuffer, format, transcribeChunk, onChunkTranscribed }) {
  if (!isTooLargeForSingleTranscriptionUpload(audioBuffer.length)) {
    return transcribeChunk(audioBuffer, { ...format, basename: 'episode' })
  }

  const ranges = buildAudioChunkRanges(audioBuffer.length)
  const transcripts = []
  for (const range of ranges) {
    const chunk = audioBuffer.subarray(range.start, range.end + 1)
    transcripts.push(await transcribeChunk(chunk, { ...format, basename: chunkBasename(range) }))
    await onChunkTranscribed({ index: range.index, total: range.total })
  }
  return joinTranscriptChunks(transcripts)
}

async function transcribeRanges({
  audioUrl, totalBytes, format, transcribeChunk, fetchImpl, downloadTimeoutMs, onChunkTranscribed,
}) {
  const ranges = buildAudioChunkRanges(totalBytes)
  const transcripts = []

  for (const range of ranges) {
    const chunkResponse = await fetchImpl(audioUrl, {
      headers: { Range: `bytes=${range.start}-${range.end}` },
      signal: AbortSignal.timeout(downloadTimeoutMs),
    })

    if (chunkResponse.status !== 206) {
      throw new PermanentError(
        `Audio-Server unterstützt kein zuverlässiges Range-Chunking (HTTP ${chunkResponse.status}). Keine Teiltranskription gespeichert.`
      )
    }

    const chunkBuffer = Buffer.from(await chunkResponse.arrayBuffer())
    if (isTooLargeForSingleTranscriptionUpload(chunkBuffer.length)) {
      throw new PermanentError(
        `Transkriptions-Chunk ${range.index + 1}/${range.total} ist zu groß (${Math.round(chunkBuffer.length / 1024 / 1024)} MB). Keine Teiltranskription gespeichert.`
      )
    }

    transcripts.push(await transcribeChunk(chunkBuffer, { ...format, basename: chunkBasename(range) }))
    await onChunkTranscribed({ index: range.index, total: range.total })
  }

  return joinTranscriptChunks(transcripts)
}

function chunkBasename(range) {
  return `episode-part-${range.index + 1}-of-${range.total}`
}

/** Adapts an OpenAI-compatible client (OpenRouter) to the `transcribeChunk` contract. */
export function createOpenRouterChunkTranscriber(openrouter, model) {
  return async function transcribeChunk(audioBuffer, { contentType, ext, basename }) {
    const arrayBuffer = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength
    )
    const file = new File([arrayBuffer], `${basename}.${ext}`, { type: contentType })
    const transcription = await openrouter.audio.transcriptions.create({ file, model })
    return extractTranscriptText(transcription)
  }
}

export function extractTranscriptText(transcription) {
  if (typeof transcription === 'string') return transcription
  if (transcription && typeof transcription === 'object' && 'text' in transcription) {
    const text = transcription.text
    return typeof text === 'string' ? text : String(text ?? '')
  }
  return String(transcription ?? '')
}

const AUDIO_TYPE_EXTENSIONS = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
}

/** Determine audio file extension from URL or content-type */
export function getAudioExtension(url, contentType) {
  const urlExt = url.split('?')[0].split('.').pop()?.toLowerCase()
  if (urlExt && ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'webm', 'mp4'].includes(urlExt)) {
    return urlExt
  }

  if (contentType) {
    const baseType = contentType.split(';')[0].trim()
    if (AUDIO_TYPE_EXTENSIONS[baseType]) return AUDIO_TYPE_EXTENSIONS[baseType]
  }

  return 'mp3'
}
