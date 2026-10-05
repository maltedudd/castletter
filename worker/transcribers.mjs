// Chooses the transcription path per episode: podcast episodes download their audio URL,
// YouTube videos go captions-first with a full-audio STT fallback. Both end in the same
// `transcribed` state, so newsletter generation, review and delivery stay source-agnostic.

import {
  transcribeAudioBuffer,
  transcribeAudioFromUrl,
} from '../src/lib/transcription/audio-transcriber.mjs'
import { isYouTubeVideoId } from '../src/lib/youtube/channel.mjs'
import {
  YOUTUBE_ERROR_CODES,
  YouTubePermanentError,
  transcribeYouTubeVideo,
} from '../src/lib/youtube/transcript.mjs'

/**
 * Returns the worker's `transcribeEpisodeAudio(episode, onChunkTranscribed, onProgress)`.
 * `youtube` is the yt-dlp client (`fetchMetadata`, `downloadCaptions`, `downloadAudio`).
 */
export function createEpisodeTranscriber({ config, transcribeChunk, youtube, fetchImpl = fetch }) {
  return async function transcribeEpisodeAudio(episode, onChunkTranscribed, onProgress = async () => {}) {
    if (episode.source_type !== 'youtube') {
      return transcribeAudioFromUrl({
        audioUrl: episode.audio_url,
        transcribeChunk,
        fetchImpl,
        downloadTimeoutMs: config.downloadTimeoutMs,
        onChunkTranscribed,
      })
    }

    if (!isYouTubeVideoId(episode.youtube_video_id)) {
      throw new YouTubePermanentError(YOUTUBE_ERROR_CODES.videoUnavailable, 'Episode hat keine gültige YouTube-Video-ID')
    }
    return transcribeYouTubeVideo({
      videoId: episode.youtube_video_id,
      youtube,
      captionLanguages: config.youtube.captionLanguages,
      transcribeAudio: ({ audioBuffer, contentType, ext, onChunkTranscribed: onChunk }) =>
        transcribeAudioBuffer({ audioBuffer, contentType, ext, transcribeChunk, onChunkTranscribed: onChunk }),
      onChunkTranscribed,
      onProgress,
    })
  }
}
