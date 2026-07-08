// Detector-daemon lifecycle from the app's side: ensure the LaunchAgent is
// installed (report-only) and hold a shared socket client. Mirrors how the app
// treats stdiod — the daemon is launchd-managed; we only orchestrate install +
// connect.

import { DetectordClient } from './socket'
import { getDetectordBinaryPath } from './binary'
import { detectordAvailable, installService } from './controller'

let client: DetectordClient | null = null
let installedThisSession = false

/** The shared client (lazily created; connects on first request). */
export function getDetectordClient(): DetectordClient {
  if (!client) client = new DetectordClient()
  return client
}

export type EnsureResult =
  | { ok: true; client: DetectordClient }
  | { ok: false; reason: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Ensure the daemon is installed (report-only by default) and the socket
 * connects. Returns a discriminated result so the caller can surface the actual
 * failure. The connect is retried — after `service install`, launchd needs a
 * moment to start the daemon and bind the socket.
 */
export async function ensureDetectord(
  slog: (m: string) => void = () => {},
  enforce = false
): Promise<EnsureResult> {
  const binary = getDetectordBinaryPath()
  if (!detectordAvailable()) {
    return {
      ok: false,
      reason: `daemon binary not found at ${binary} — run \`npm run build:detectord\` (or \`cargo build --release\` in detectord/).`
    }
  }
  // Install once per app session (the LaunchAgent bootstrap is a restart, so we
  // don't want to bounce it on every call — but we DO want it installed on every
  // client run, which the unconditional caller guarantees).
  if (!installedThisSession) {
    try {
      const r = await installService(enforce)
      slog(`[detectord] service install (enforce=${enforce}) exit=${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`)
      if (r.code !== 0) {
        return { ok: false, reason: `service install failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}` }
      }
      installedThisSession = true
    } catch (err) {
      return { ok: false, reason: `service install error: ${String(err)}` }
    }
  }

  const c = getDetectordClient()
  let lastErr = ''
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await c.connect()
      return { ok: true, client: c }
    } catch (err) {
      lastErr = String(err)
      await sleep(300)
    }
  }
  return { ok: false, reason: `socket connect failed after retries: ${lastErr}` }
}
