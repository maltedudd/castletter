// Castletter worker: (if enabled) imports new episodes/videos/articles from the podcast feeds,
// YouTube channels and website feeds, polls Supabase for pending episodes and transcribes them
// completely (YouTube: captions first, full-audio STT fallback; websites: public full text
// without audio), then (if enabled)
// generates their newsletters and sends them — without the Vercel function time limit.

import { lookup } from 'node:dns/promises'
import { writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { Resend } from 'resend'
import Parser from 'rss-parser'
import { loadWorkerConfig } from './config.mjs'
import { runOnce, releaseClaim } from './worker-core.mjs'
import { runGenerationOnce, runSendSweep, createHourlyGate } from './newsletter-jobs.mjs'
import { runFeedCheck, createIntervalGate } from './feed-jobs.mjs'
import { generateEmailHTML, generateEmailPlainText } from '../src/lib/email/template.mjs'
import { createOpenRouterChunkTranscriber } from '../src/lib/transcription/audio-transcriber.mjs'
import { createFfmpeg } from '../src/lib/transcription/audio-file.mjs'
import { createYtDlpClient } from '../src/lib/youtube/yt-dlp.mjs'
import { createEpisodeTranscriber } from './transcribers.mjs'

function log(level, msg, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })
  if (level === 'error') console.error(line)
  else console.log(line)
}

async function writeHeartbeat(config) {
  await writeFile(config.heartbeatFile, String(Date.now())).catch((err) =>
    log('warn', 'heartbeat_file_failed', { error: err.message })
  )
}

async function pingHeartbeatUrl(config) {
  if (!config.heartbeatUrl) return
  try {
    await fetch(config.heartbeatUrl, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    log('warn', 'heartbeat_url_failed', { error: err.message })
  }
}

function createMailer({ resendApiKey, fromEmail, settingsUrl }) {
  const resend = new Resend(resendApiKey)
  return async function sendEmail({ to, subject, items, mode }) {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to,
      subject,
      html: generateEmailHTML(to, items, settingsUrl, 'de', mode),
      text: generateEmailPlainText(items, settingsUrl, 'de', mode),
    })
    if (error) throw new Error(`Resend error: ${error.message}`)
  }
}

async function main() {
  const config = loadWorkerConfig()
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const openrouter = new OpenAI(config.openrouter.client)
  const transcribeChunk = createOpenRouterChunkTranscriber(openrouter, config.openrouter.transcriptionModel)
  const ytDlp = createYtDlpClient({ binary: config.youtube.ytDlpPath, timeoutMs: config.youtube.downloadTimeoutMs })
  const transcribeEpisode = createEpisodeTranscriber({
    config,
    transcribeChunk,
    youtube: ytDlp,
    lookup,
    ffmpeg: createFfmpeg({ binary: config.ffmpegPath, timeoutMs: config.transcodeTimeoutMs }),
  })

  const deps = {
    supabase,
    config,
    now: () => new Date(),
    log,
    openrouter,
    // Reads the channel's Videos tab when YouTube's feed endpoint is down.
    youtubeFallback: ytDlp,
    parseXml: (() => {
      const parser = new Parser()
      return (xml) => parser.parseString(xml)
    })(),
    sendEmail: config.newsletters ? createMailer(config.newsletters) : null,
    transcribeEpisodeAudio: (episode, onChunkTranscribed, onProgress) =>
      transcribeEpisode(
        episode,
        async (info) => {
          await writeHeartbeat(config)
          await onChunkTranscribed(info)
        },
        async (info) => {
          await writeHeartbeat(config)
          await onProgress(info)
        }
      ),
  }

  const state = { active: null }
  let stopping = false
  let wakeUp = () => {}

  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    log('info', 'shutdown', { signal, activeEpisode: state.active?.id ?? null })
    if (state.active) {
      try {
        const released = await releaseClaim(deps, state.active)
        log('info', 'claim_released', { episodeId: state.active.id, released })
      } catch (err) {
        log('error', 'claim_release_failed', { error: err.message })
      }
      process.exit(0)
    }
    wakeUp()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  log('info', 'worker_started', {
    model: config.openrouter.transcriptionModel,
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    maxEpisodeAgeDays: config.maxEpisodeAgeDays,
    maxAttempts: config.maxAttempts,
    feedCheckIntervalMinutes: config.feedCheckIntervalMs ? config.feedCheckIntervalMs / 60_000 : null,
    newsletters: Boolean(config.newsletters),
    newsletterModel: config.newsletters ? config.openrouter.newsletterModel : undefined,
    downloadTimeoutSeconds: config.downloadTimeoutMs / 1000,
    transcodeTimeoutSeconds: config.transcodeTimeoutMs / 1000,
    youtubeDownloadTimeoutSeconds: config.youtube.downloadTimeoutMs / 1000,
    youtubeCaptionLanguages: config.youtube.captionLanguages,
  })

  const sendSweep = createHourlyGate()
  const feedCheck = config.feedCheckIntervalMs ? createIntervalGate(config.feedCheckIntervalMs) : null

  // One pass of the pipeline; each stage is isolated so a failure in one does not block
  // the others. Returns whether any stage did work (then the loop continues immediately).
  async function runPipeline() {
    let worked = false
    const stage = async (name, fn) => {
      try {
        return await fn()
      } catch (err) {
        log('error', 'iteration_failed', { stage: name, error: err instanceof Error ? err.message : String(err) })
        return null
      }
    }

    const feedCheckAt = deps.now()
    if (feedCheck?.isDue(feedCheckAt)) {
      const summary = await stage('feeds', () => runFeedCheck(deps))
      if (summary) {
        feedCheck.markDone(feedCheckAt)
        worked = summary.newEpisodes > 0 || worked
      }
    }
    if (stopping) return worked

    worked = (await stage('transcription', () => runOnce(deps, state)))?.worked || worked
    if (stopping || !config.newsletters) return worked

    worked = (await stage('generation', () => runGenerationOnce(deps)))?.worked || worked
    const sweepAt = deps.now()
    if (!stopping && sendSweep.isDue(sweepAt) && (await stage('send', () => runSendSweep(deps)))) {
      sendSweep.markDone(sweepAt)
    }
    return worked
  }

  while (!stopping) {
    await writeHeartbeat(config)
    await pingHeartbeatUrl(config)

    const worked = await runPipeline()

    if (worked || stopping) continue
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs)
      wakeUp = () => { clearTimeout(timer); resolve() }
    })
  }

  log('info', 'worker_stopped')
}

main().catch((err) => {
  log('error', 'worker_crashed', { error: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
