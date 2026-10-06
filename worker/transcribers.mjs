// Chooses the transcription path per episode: podcast episodes download their audio URL,
// YouTube videos go captions-first with a full-audio STT fallback. Audio of both is converted
// with ffmpeg to a small speech-grade MP3 and uploaded whole (split by time only when still
// too large). Website articles need no audio at all: their complete public text comes from the
// feed or the linked article page. All end in the same `transcribed` state, so newsletter
// generation and delivery stay source-agnostic.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadAudioToFile, transcribeAudioFile } from '../src/lib/transcription/audio-file.mjs'
import { isYouTubeVideoId } from '../src/lib/youtube/channel.mjs'
import {
  YOUTUBE_ERROR_CODES,
  YouTubePermanentError,
  transcribeYouTubeVideo,
} from '../src/lib/youtube/transcript.mjs'
import { resolveWebsiteContent } from '../src/lib/websites/content.mjs'

/**
 * Returns the worker's `transcribeEpisodeAudio(episode, onChunkTranscribed, onProgress)`.
 * `youtube` is the yt-dlp client (`fetchMetadata`, `downloadCaptions`, `downloadAudio`),
 * `ffmpeg` the runner from `createFfmpeg`. Every audio episode gets its own temp dir, removed
 * afterwards whatever the outcome. `lookup` (DNS) guards article fetches against internal hosts.
 */
export function createEpisodeTranscriber({ config, transcribeChunk, youtube, ffmpeg, fetchImpl = fetch, lookup = null, tmpRoot = tmpdir() }) {
  return async function transcribeEpisodeAudio(episode, onChunkTranscribed, onProgress = async () => {}) {
    if (episode.source_type === 'website') {
      return resolveWebsiteContent({ episode, fetchImpl, lookup })
    }

    if (episode.source_type === 'youtube' && !isYouTubeVideoId(episode.youtube_video_id)) {
      throw new YouTubePermanentError(YOUTUBE_ERROR_CODES.videoUnavailable, 'Episode hat keine gültige YouTube-Video-ID')
    }

    const workDir = await mkdtemp(path.join(tmpRoot, 'castletter-episode-'))
    try {
      const transcribeFile = (inputPath, callbacks) =>
        transcribeAudioFile({ inputPath, workDir, ffmpeg, transcribeChunk, ...callbacks })

      if (episode.source_type === 'youtube') {
        return await transcribeYouTubeVideo({
          videoId: episode.youtube_video_id,
          youtube: { ...youtube, downloadAudio: (videoId) => youtube.downloadAudio(videoId, { dir: workDir }) },
          captionLanguages: config.youtube.captionLanguages,
          transcribeAudio: ({ path: inputPath, onChunkTranscribed: onChunk, onProgress: onStep }) =>
            transcribeFile(inputPath, { onChunkTranscribed: onChunk, onProgress: onStep }),
          onChunkTranscribed,
          onProgress,
        })
      }

      const { path: inputPath } = await downloadAudioToFile({
        url: episode.audio_url,
        fetchImpl,
        path: path.join(workDir, 'source'),
        timeoutMs: config.downloadTimeoutMs,
      })
      await onProgress({ stage: 'download' })
      return await transcribeFile(inputPath, { onChunkTranscribed, onProgress })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}
