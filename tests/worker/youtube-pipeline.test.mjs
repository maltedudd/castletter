// Mocked end-to-end run of the worker stages for a YouTube channel source: official channel
// feed → idempotent ingestion → captions-first / STT-fallback transcription → newsletter
// generation, ending in the same review-ready `newsletter_ready` state as podcast episodes.

import assert from 'node:assert/strict'
import test from 'node:test'
import { runFeedCheck } from '../../worker/feed-jobs.mjs'
import { runOnce } from '../../worker/worker-core.mjs'
import { runGenerationOnce } from '../../worker/newsletter-jobs.mjs'
import { createEpisodeTranscriber } from '../../worker/transcribers.mjs'
import { buildYouTubeFeedUrl } from '../../src/lib/youtube/channel.mjs'
import { YouTubePermanentError } from '../../src/lib/youtube/transcript.mjs'
import { makeFakeSupabase } from '../helpers/fake-supabase.mjs'

const NOW = new Date('2026-10-04T10:00:00.000Z')
const CHANNEL_ID = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const FEED_URL = buildYouTubeFeedUrl(CHANNEL_ID)
const CAPTIONED = 'captioned01'
const NO_CAPTIONS = 'nocaption01'
const GONE = 'removed0001'
const MODEL_OUTPUT = '## Zusammenfassung\nKurz.\n\n## Hauptthemen\n- Thema\n\n## Wichtige Aussagen und Erkenntnisse\n- Aussage'

const FEED_XML = `<feed><yt:channelId>${CHANNEL_ID}</yt:channelId><title>Kanal</title>
  ${[[CAPTIONED, '2026-10-03T08:00:00+00:00'], [NO_CAPTIONS, '2026-10-03T09:00:00+00:00'], [GONE, '2026-10-03T10:00:00+00:00']]
    .map(([id, published]) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Video ${id}</title><published>${published}</published></entry>`)
    .join('')}
</feed>`

function captionsDoc(endMs) {
  const events = []
  for (let t = 0; t < endMs; t += 5000) {
    events.push({ tStartMs: t, dDurationMs: 5000, segs: [{ utf8: 'Heute sprechen wir über Kanäle, Feeds und vollständige Transkripte.' }] })
  }
  return { events }
}

function fakeYouTube() {
  const calls = []
  const base = { duration: 600, language: 'de', live_status: 'not_live', availability: 'public', automatic_captions: {} }
  return {
    calls,
    async fetchMetadata(videoId) {
      calls.push(['metadata', videoId])
      if (videoId === GONE) throw new YouTubePermanentError('video_unavailable', 'Video nicht verfügbar: Private video')
      return { ...base, id: videoId, subtitles: videoId === CAPTIONED ? { de: [{ ext: 'json3' }] } : {} }
    },
    async downloadCaptions(videoId, track) {
      calls.push(['captions', videoId, track.language])
      return captionsDoc(600_000)
    },
    async downloadAudio(videoId) {
      calls.push(['audio', videoId])
      return { audioBuffer: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg', ext: 'mp3' }
    },
  }
}

/**
 * The fake has neither column defaults nor joins: apply the episodes defaults from the
 * migrations and expose the source on episode rows like PostgREST's embed would.
 */
function withDefaultsAndSubscriptionJoin(db) {
  const originalFrom = db.from.bind(db)
  db.from = (table) => {
    if (table === 'episodes') {
      for (const row of db.data.episodes) {
        row.transcription_attempts ??= 0
        row.error_message ??= null
        row.transcript ??= null
        const source = db.data.podcast_subscriptions.find((s) => s.id === row.subscription_id)
        if (source) row.podcast_subscriptions = { title: source.title, user_id: source.user_id }
      }
    }
    return originalFrom(table)
  }
}

test('YouTube channel source runs through the common pipeline to newsletter_ready without sending', async () => {
  const db = makeFakeSupabase({
    podcast_subscriptions: [{
      id: 'yt-1',
      user_id: 'user-1',
      source_type: 'youtube',
      youtube_channel_id: CHANNEL_ID,
      feed_url: FEED_URL,
      title: 'Kanal',
      enabled: true,
      delivery_mode: 'daily',
      created_at: '2026-09-01T00:00:00.000Z',
    }],
    episodes: [],
    feed_check_logs: [],
    episode_newsletters: [],
    user_settings: [{ user_id: 'user-1', newsletter_email: 'malte@example.com', newsletter_delivery_hour: 7 }],
  })
  withDefaultsAndSubscriptionJoin(db)

  const youtube = fakeYouTube()
  const sttUploads = []
  const transcribeChunk = async (buffer, meta) => {
    sttUploads.push({ size: buffer.length, ext: meta.ext })
    return 'Vollständiges STT-Transkript des Videos ohne Untertitel.'
  }
  const logs = []
  const mails = []
  const deps = {
    supabase: db,
    config: {
      maxEpisodeAgeDays: 7,
      maxAttempts: 3,
      downloadTimeoutMs: 1000,
      youtube: { captionLanguages: ['de', 'en'] },
      openrouter: { newsletterModel: 'test/model' },
    },
    now: () => NOW,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    fetchImpl: async (url) => {
      assert.equal(url, FEED_URL)
      return { ok: true, status: 200, text: async () => FEED_XML }
    },
    parseXml: async () => assert.fail('RSS parser is only for podcasts'),
    openrouter: { chat: { completions: { create: async () => ({ choices: [{ message: { content: MODEL_OUTPUT } }] }) } } },
    sendEmail: async (mail) => { mails.push(mail) },
  }
  deps.transcribeEpisodeAudio = createEpisodeTranscriber({
    config: deps.config,
    transcribeChunk,
    youtube,
    fetchImpl: async () => assert.fail('YouTube episodes never download audio_url directly'),
  })

  // 1. Feed check, twice: every upload is ingested exactly once.
  assert.equal((await runFeedCheck(deps)).newEpisodes, 3)
  assert.equal((await runFeedCheck(deps)).newEpisodes, 0)
  assert.equal(db.data.episodes.length, 3)

  // 2. Transcription loop until idle (oldest first).
  const outcomes = []
  for (let i = 0; i < 10; i++) {
    const result = await runOnce(deps)
    if (!result.worked) break
    outcomes.push(result.outcome)
  }
  assert.deepEqual(outcomes, ['transcribed', 'transcribed', 'failed'])

  // 3. Newsletter generation until idle.
  for (let i = 0; i < 10 && (await runGenerationOnce(deps)).worked; i++) { /* drain */ }

  const byVideo = Object.fromEntries(db.data.episodes.map((e) => [e.youtube_video_id, e]))

  assert.equal(byVideo[CAPTIONED].status, 'newsletter_ready')
  assert.equal(byVideo[CAPTIONED].transcript_source, 'captions')
  assert.match(byVideo[CAPTIONED].transcript, /^Heute sprechen wir/)
  assert.equal(byVideo[CAPTIONED].error_code, null)

  assert.equal(byVideo[NO_CAPTIONS].status, 'newsletter_ready')
  assert.equal(byVideo[NO_CAPTIONS].transcript_source, 'audio_stt')
  assert.equal(byVideo[NO_CAPTIONS].transcript, 'Vollständiges STT-Transkript des Videos ohne Untertitel.')
  assert.deepEqual(sttUploads, [{ size: 9, ext: 'mp3' }], 'only the uncaptioned video went through STT')

  assert.equal(byVideo[GONE].status, 'failed')
  assert.equal(byVideo[GONE].error_code, 'video_unavailable')
  assert.match(byVideo[GONE].error_message, /Private video/)

  assert.equal(db.data.episode_newsletters.length, 2)
  // Daily source outside its delivery hour: nothing is mailed by generation.
  assert.equal(mails.length, 0)
  assert.deepEqual(youtube.calls.filter((c) => c[0] === 'audio').map((c) => c[1]), [NO_CAPTIONS])
  assert.equal(db.data.podcast_subscriptions[0].last_check_status, 'success')
  // Why captions were skipped is visible in the worker log of the fallback transcription.
  const sttLog = logs.find((l) => l.msg === 'episode_transcribed' && l.source === 'audio_stt')
  assert.equal(sttLog.captionsReason, 'keine Untertitel vorhanden')
})

test('a temporary STT failure keeps a persisted reason and is retried until it succeeds', async () => {
  const db = makeFakeSupabase({
    episodes: [{
      id: 'ep-1',
      subscription_id: 'yt-1',
      source_type: 'youtube',
      youtube_video_id: NO_CAPTIONS,
      audio_url: `https://www.youtube.com/watch?v=${NO_CAPTIONS}`,
      title: 'Video',
      status: 'pending_transcription',
      published_at: '2026-10-03T09:00:00.000Z',
      transcription_attempts: 0,
      error_message: null,
      transcript: null,
    }],
  })
  let fail = true
  const deps = {
    supabase: db,
    config: { maxEpisodeAgeDays: 7, maxAttempts: 3, downloadTimeoutMs: 1000, youtube: { captionLanguages: ['de'] } },
    now: () => NOW,
    log: () => {},
  }
  deps.transcribeEpisodeAudio = createEpisodeTranscriber({
    config: deps.config,
    youtube: fakeYouTube(),
    transcribeChunk: async () => {
      if (fail) throw new Error('OpenRouter 503 Service Unavailable')
      return 'Komplettes Transkript.'
    },
  })

  assert.equal((await runOnce(deps)).outcome, 'retry_later')
  const episode = db.data.episodes[0]
  assert.equal(episode.status, 'pending_transcription')
  assert.equal(episode.error_code, 'stt_failed')
  assert.match(episode.error_message, /Versuch 1\/3.*keine Untertitel vorhanden.*OpenRouter 503/)
  assert.equal(episode.transcript, null, 'no partial transcript stored')

  fail = false
  assert.equal((await runOnce(deps)).outcome, 'transcribed')
  assert.equal(episode.status, 'transcribed')
  assert.equal(episode.error_code, null)
  assert.equal(episode.transcript_source, 'audio_stt')
})
