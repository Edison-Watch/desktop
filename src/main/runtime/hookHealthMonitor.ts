/**
 * Hook Health Monitor
 *
 * - Periodic hook status checks (every 5 minutes); reports to Sentry when hooks disappear
 * - Watches ~/.edison-watch/errors/ for hook script failure files and reports to Sentry
 */

import { watch } from 'chokidar'
import { promises as fs, existsSync } from 'fs'
import { basename, join } from 'path'
import {
  getEdisonWatchDir,
  getHookStatus,
  getPendingErrorsDir,
  getPendingRegistrationsDir
} from './hookInjection'
import type { HookStatusEntry } from './hookInjection'
import { captureError } from '../infra/sentry'
import { getMcpUrl, getIsServerOnline } from '../infra/setupConfig'

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/** Pending files are fire-and-forget events; anything this old was never picked up. */
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export type { HookStatusEntry }

let statusCheckTimer: ReturnType<typeof setInterval> | null = null
let errorsWatcher: ReturnType<typeof watch> | null = null
let pendingWatcher: ReturnType<typeof watch> | null = null
let lastKnownStatus: HookStatusEntry[] = []
let onHooksMissing: ((entries: HookStatusEntry[]) => void) | null = null
let monitorActive = false

/**
 * Register a callback when hooks are detected as missing (e.g. to show a notification).
 */
export function setOnHooksMissingCallback(cb: (entries: HookStatusEntry[]) => void): void {
  onHooksMissing = cb
}

/**
 * Return a short label for the tray menu reflecting current hook status.
 * Uses last-known status from periodic checks; call from buildTrayMenu for a non-clickable line.
 */
export function getHookStatusLabel(): string {
  const s = lastKnownStatus
  if (s.length === 0) return 'Hooks: -'
  const installed = s.filter((e) => e.installed)
  if (installed.length === 0) return '0 MCP clients have Edison installed'
  // Hook-based clients: hooks present. Hookless clients: MCP entry configured.
  // Uses mcpConfigured (not mcpConnected) because the label reflects "installed" state
  // (config on disk), not live connection - matching hasHook semantics for hook clients.
  const withEdison = installed.filter((e) =>
    e.hooksApplicable ? e.hasHook : e.mcpConfigured
  ).length
  const total = installed.length
  if (withEdison === total) return 'All MCP clients have Edison installed'
  if (withEdison === 0) return '0 MCP clients have Edison installed'
  return `${withEdison}/${total} MCP clients have Edison installed`
}

/**
 * Process a single session-end file from the pending directory.
 */
async function processSessionEndFile(filePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { event?: string; conversation_id?: string; reason?: string }
    if (parsed.event === 'session_end' && parsed.conversation_id) {
      console.log(
        '[HookHealthMonitor] Session ended: %s (reason: %s)',
        parsed.conversation_id,
        parsed.reason ?? 'unknown'
      )
    } else {
      console.warn(
        '[HookHealthMonitor] session-end file has unexpected shape, discarding:',
        filePath,
        parsed
      )
    }
  } catch {
    // Likely a race condition where chokidar fired before the file was fully written.
    console.warn('[HookHealthMonitor] Could not parse session-end file, discarding:', filePath)
  } finally {
    try {
      await fs.unlink(filePath)
    } catch {
      // ignore
    }
  }
}

/**
 * Discard a processed pending-queue file. Registration files
 * ({ts}-{rand}-{client}.json, written by edison-hook.sh on session start)
 * currently carry no consumer-side action - they exist so the queue has a
 * single lifecycle: every event file is consumed and removed once seen.
 */
async function discardPendingFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore - already consumed by a concurrent sweep or another instance
  }
}

/**
 * Delete pending-queue files older than PENDING_MAX_AGE_MS.
 * Safety net for files that accumulate while the app is not running and
 * for any the watcher fails to report; runs before the watcher starts so
 * a large backlog does not all flow through chokidar's initial scan.
 */
async function sweepStalePendingFiles(): Promise<void> {
  const pendingDir = getPendingRegistrationsDir()
  if (!existsSync(pendingDir)) return

  let swept = 0
  const now = Date.now()
  const entries = await fs.readdir(pendingDir)
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('.')) continue
    const filePath = join(pendingDir, entry)
    try {
      const stat = await fs.stat(filePath)
      if (now - stat.mtimeMs > PENDING_MAX_AGE_MS) {
        await fs.unlink(filePath)
        swept++
      }
    } catch {
      // ignore - file vanished or unreadable; the watcher will handle it
    }
  }
  if (swept > 0) {
    console.log('[HookHealthMonitor] Swept %d stale pending file(s)', swept)
  }
}

/**
 * Delete PID-scoped active_session_<pid>.json files whose process is gone.
 * The SessionEnd hook normally removes them, but sessions that crash or are
 * killed never fire it, so the files leak.
 */
async function sweepOrphanedActiveSessionFiles(): Promise<void> {
  const edisonDir = getEdisonWatchDir()
  if (!existsSync(edisonDir)) return

  let swept = 0
  const entries = await fs.readdir(edisonDir)
  for (const entry of entries) {
    const match = /^active_session_(\d+)\.json$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0) // throws ESRCH if the process is gone
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        await fs.unlink(join(edisonDir, entry)).catch(() => {})
        swept++
      }
      // EPERM means the PID is alive but owned by someone else - keep the file
    }
  }
  if (swept > 0) {
    console.log('[HookHealthMonitor] Swept %d orphaned active-session file(s)', swept)
  }
}

/**
 * Start watching the pending directory and consume every event file.
 * Session-end files get parsed and logged; everything else is discarded.
 * ignoreInitial: false means the existing backlog drains on startup.
 */
function startPendingDirWatcher(): void {
  const pendingDir = getPendingRegistrationsDir()
  if (pendingWatcher) return

  if (!existsSync(pendingDir)) {
    fs.mkdir(pendingDir, { recursive: true }).catch(() => {})
  }

  pendingWatcher = watch(pendingDir, {
    persistent: true,
    ignoreInitial: false,
    depth: 0
  })

  pendingWatcher.on('add', (path) => {
    const name = basename(path)
    // Dot-prefixed files are in-flight temp writes (hook scripts write
    // .<name>.tmp then rename); never touch them.
    if (!name.endsWith('.json') || name.startsWith('.')) return
    if (name.endsWith('-session-end.json')) {
      processSessionEndFile(path).catch(() => {})
    } else {
      discardPendingFile(path).catch(() => {})
    }
  })

  pendingWatcher.on('error', (err: unknown) => {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      context: 'hookHealthMonitor_pendingWatcher'
    })
  })

  console.log('[HookHealthMonitor] Pending dir watcher started:', pendingDir)
}

/**
 * Process a single error file from the errors directory and report to Sentry.
 */
async function processErrorFile(filePath: string): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { error?: string; client?: string; timestamp?: string }
    captureError(new Error(parsed.error ?? 'Hook script reported failure'), {
      source: 'hook_script_error_file',
      client: parsed.client,
      timestamp: parsed.timestamp,
      filePath
    })
  } catch {
    captureError(new Error('Hook script reported failure (unparseable error file)'), {
      source: 'hook_script_error_file',
      filePath
    })
  } finally {
    try {
      await fs.unlink(filePath)
    } catch {
      // ignore
    }
  }
}

/**
 * Start watching the errors directory for new files and report to Sentry.
 */
function startErrorsDirWatcher(): void {
  const errorsDir = getPendingErrorsDir()
  if (errorsWatcher) return

  if (!existsSync(errorsDir)) {
    fs.mkdir(errorsDir, { recursive: true }).catch(() => {})
  }

  errorsWatcher = watch(errorsDir, {
    persistent: true,
    ignoreInitial: false,
    depth: 0
  })

  errorsWatcher.on('add', (path) => {
    if (!path.endsWith('.json')) return
    processErrorFile(path).catch(() => {})
  })

  errorsWatcher.on('error', (err: unknown) => {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      context: 'hookHealthMonitor_errorsWatcher'
    })
  })

  console.log('[HookHealthMonitor] Errors dir watcher started:', errorsDir)
}

/**
 * Run one hook status check: detect if any previously-installed hook is now missing.
 */
async function runStatusCheck(): Promise<void> {
  const current = await getHookStatus(getMcpUrl(), getIsServerOnline())
  const prevMap = new Map(current.map((e) => [e.client, e]))
  const missing: HookStatusEntry[] = []

  for (const last of lastKnownStatus) {
    if (!last.hooksApplicable) continue
    if (!last.installed || !last.hasHook) continue
    const cur = prevMap.get(last.client)
    if (cur?.installed && !cur.hasHook) {
      missing.push(cur)
    }
  }

  lastKnownStatus = current

  if (missing.length > 0) {
    captureError(
      new Error(`Edison Watch hooks were removed from: ${missing.map((m) => m.client).join(', ')}`),
      { missingClients: missing.map((m) => m.client) }
    )
    onHooksMissing?.(missing)
  }
}

/**
 * Start periodic hook status checks and the errors-dir watcher.
 */
export function startHookHealthMonitor(): void {
  getHookStatus(getMcpUrl(), getIsServerOnline()).then((s) => {
    lastKnownStatus = s
  })

  if (statusCheckTimer) return
  statusCheckTimer = setInterval(() => {
    runStatusCheck().catch((err: unknown) => {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        context: 'hookHealthMonitor_runStatusCheck'
      })
    })
  }, CHECK_INTERVAL_MS)

  monitorActive = true
  const sweepError = (context: string) => (err: unknown) => {
    captureError(err instanceof Error ? err : new Error(String(err)), { context })
  }
  // Sweep before watching so the backlog does not all flow through chokidar
  sweepStalePendingFiles()
    .catch(sweepError('hookHealthMonitor_sweepStalePendingFiles'))
    .finally(() => {
      if (!monitorActive) return // stopped while the sweep was in flight
      startErrorsDirWatcher()
      startPendingDirWatcher()
    })
  sweepOrphanedActiveSessionFiles().catch(
    sweepError('hookHealthMonitor_sweepOrphanedActiveSessionFiles')
  )
  console.log('[HookHealthMonitor] Started (interval %d ms)', CHECK_INTERVAL_MS)
}

/**
 * Stop periodic checks and the errors-dir watcher.
 */
export async function stopHookHealthMonitor(): Promise<void> {
  monitorActive = false
  if (statusCheckTimer) {
    clearInterval(statusCheckTimer)
    statusCheckTimer = null
  }
  if (errorsWatcher) {
    await errorsWatcher.close()
    errorsWatcher = null
  }
  if (pendingWatcher) {
    await pendingWatcher.close()
    pendingWatcher = null
  }
  onHooksMissing = null
  console.log('[HookHealthMonitor] Stopped')
}
