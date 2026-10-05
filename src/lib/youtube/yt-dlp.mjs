// yt-dlp adapter for the worker: video metadata, caption download and full audio extraction
// (MP3, mono, so the existing byte-range chunking stays valid). `execFileImpl` is injected so
// argument building and error classification are tested without the binary or network.
//
// Every call is bounded by `timeoutMs`; a timeout is an error, never a partial result.

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildYouTubeWatchUrl } from './channel.mjs'
import { YOUTUBE_ERROR_CODES, YouTubePermanentError, YouTubeTemporaryError } from './transcript.mjs'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const BASE_ARGS = ['--no-playlist', '--no-progress', '--no-warnings']
export const AUDIO_BITRATE = '64K'

const PERMANENT_PATTERNS = [
  /private video|video is private/i,
  /video (?:is )?unavailable/i,
  /has been removed/i,
  /account associated with this video has been terminated/i,
  /members[- ]only|join this channel/i,
  /confirm your age|age[- ]restricted/i,
  /not (?:made )?available in your country/i,
]
const NOT_YET_PATTERNS = [/live event will begin/i, /premieres? in/i, /is upcoming/i, /this live event/i]
const BLOCKED_PATTERNS = [/confirm you.?re not a bot/i, /HTTP Error 429/i, /too many requests/i]

export function createYtDlpClient({
  binary = 'yt-dlp',
  timeoutMs,
  execFileImpl = execFileAsync,
  tmpRoot = tmpdir(),
}) {
  async function run(args, operationCode) {
    try {
      const { stdout } = await execFileImpl(binary, [...BASE_ARGS, ...args], {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
      })
      return stdout
    } catch (err) {
      throw classifyYtDlpError(err, { operationCode, timeoutMs })
    }
  }

  async function withTempDir(fn) {
    const dir = await mkdtemp(path.join(tmpRoot, 'castletter-yt-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  return {
    async fetchMetadata(videoId) {
      const stdout = await run(['--dump-single-json', '--skip-download', buildYouTubeWatchUrl(videoId)], YOUTUBE_ERROR_CODES.youtubeFetchFailed)
      try {
        return JSON.parse(stdout)
      } catch {
        throw new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.youtubeFetchFailed, 'yt-dlp lieferte keine gültigen Video-Metadaten')
      }
    },

    async downloadCaptions(videoId, { language, automatic }) {
      return withTempDir(async (dir) => {
        await run([
          '--skip-download',
          automatic ? '--write-auto-subs' : '--write-subs',
          '--sub-langs', language,
          '--sub-format', 'json3',
          '-o', path.join(dir, 'captions.%(ext)s'),
          buildYouTubeWatchUrl(videoId),
        ], YOUTUBE_ERROR_CODES.youtubeFetchFailed)
        const file = (await readdir(dir)).find((name) => name.endsWith('.json3'))
        if (!file) throw new Error(`Untertiteldatei (${language}) wurde nicht erzeugt`)
        return JSON.parse(await readFile(path.join(dir, file), 'utf8'))
      })
    },

    async downloadAudio(videoId) {
      return withTempDir(async (dir) => {
        await run([
          '-f', 'bestaudio/best',
          '--extract-audio',
          '--audio-format', 'mp3',
          '--audio-quality', AUDIO_BITRATE,
          '--postprocessor-args', 'ExtractAudio:-ac 1',
          '-o', path.join(dir, 'audio.%(ext)s'),
          buildYouTubeWatchUrl(videoId),
        ], YOUTUBE_ERROR_CODES.audioDownloadFailed)
        const file = (await readdir(dir)).find((name) => name.endsWith('.mp3'))
        if (!file) {
          throw new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.audioDownloadFailed, 'yt-dlp hat keine MP3-Datei erzeugt (ffmpeg installiert?)')
        }
        return { audioBuffer: await readFile(path.join(dir, file)), contentType: 'audio/mpeg', ext: 'mp3' }
      })
    },
  }
}

/** Maps a failed yt-dlp run to a coded YouTube error (permanent only for unavailable videos). */
export function classifyYtDlpError(err, { operationCode, timeoutMs }) {
  if (err?.code === 'ENOENT') {
    return new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.youtubeToolMissing, 'yt-dlp ist nicht installiert oder YTDLP_PATH ist falsch')
  }
  if (err?.killed || err?.signal === 'SIGKILL') {
    return new YouTubeTemporaryError(
      operationCode,
      `yt-dlp nach ${Math.round(timeoutMs / 1000)}s abgebrochen (Timeout) – kein Teilergebnis verwendet`
    )
  }

  const detail = extractErrorLine(String(err?.stderr ?? '')) || (err instanceof Error ? err.message : String(err))
  if (PERMANENT_PATTERNS.some((p) => p.test(detail))) {
    return new YouTubePermanentError(YOUTUBE_ERROR_CODES.videoUnavailable, `Video nicht verfügbar: ${detail}`)
  }
  if (NOT_YET_PATTERNS.some((p) => p.test(detail))) {
    return new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.videoNotYetAvailable, `Video noch nicht abrufbar: ${detail}`)
  }
  if (BLOCKED_PATTERNS.some((p) => p.test(detail))) {
    return new YouTubeTemporaryError(YOUTUBE_ERROR_CODES.youtubeBlocked, `YouTube blockiert den Abruf vorübergehend: ${detail}`)
  }
  return new YouTubeTemporaryError(operationCode, `yt-dlp fehlgeschlagen: ${detail}`)
}

function extractErrorLine(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const errorLine = [...lines].reverse().find((l) => l.startsWith('ERROR:')) ?? lines.at(-1) ?? ''
  return errorLine.replace(/^ERROR:\s*/, '').slice(0, 300)
}
