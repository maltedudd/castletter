// Docker HEALTHCHECK: healthy while the worker loop (or a running chunk) has written its
// heartbeat recently. Exit 0 = healthy, 1 = unhealthy.

import { readFile } from 'node:fs/promises'
import { DEFAULTS } from './config.mjs'

const file = process.env.TRANSCRIPTION_HEARTBEAT_FILE || DEFAULTS.heartbeatFile
const maxAgeMs = Number(process.env.TRANSCRIPTION_HEALTHCHECK_MAX_AGE_SECONDS || 1800) * 1000

try {
  const last = Number(await readFile(file, 'utf8'))
  process.exit(Date.now() - last <= maxAgeMs ? 0 : 1)
} catch {
  process.exit(1)
}
