// Castletter transcription worker: polls Supabase for pending episodes and transcribes
// them completely, without the Vercel function time limit.

import { writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { loadWorkerConfig } from './config.mjs'
import { runOnce, releaseClaim } from './worker-core.mjs'
import {
  createOpenRouterChunkTranscriber,
  transcribeAudioFromUrl,
} from '../src/lib/transcription/audio-transcriber.mjs'

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

async function main() {
  const config = loadWorkerConfig()
  const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const openrouter = new OpenAI(config.openrouter.client)
  const transcribeChunk = createOpenRouterChunkTranscriber(openrouter, config.openrouter.transcriptionModel)

  const deps = {
    supabase,
    config,
    now: () => new Date(),
    log,
    transcribeEpisodeAudio: (episode, onChunkTranscribed) =>
      transcribeAudioFromUrl({
        audioUrl: episode.audio_url,
        transcribeChunk,
        downloadTimeoutMs: config.downloadTimeoutMs,
        onChunkTranscribed: async (info) => {
          await writeHeartbeat(config)
          await onChunkTranscribed(info)
        },
      }),
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
  })

  while (!stopping) {
    await writeHeartbeat(config)
    await pingHeartbeatUrl(config)

    let worked = false
    try {
      worked = (await runOnce(deps, state)).worked
    } catch (err) {
      log('error', 'iteration_failed', { error: err instanceof Error ? err.message : String(err) })
    }

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
