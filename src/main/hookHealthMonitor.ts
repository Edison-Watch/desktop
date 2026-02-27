/**
 * Hook Health Monitor
 *
 * - Periodic hook status checks (every 5 minutes); reports to Sentry when hooks disappear
 * - Watches ~/.edison-watch/errors/ for hook script failure files and reports to Sentry
 */

import { watch } from 'chokidar'
import { promises as fs, existsSync } from 'fs'
import { getHookStatus, getPendingErrorsDir } from './hookInjection'
import type { McpClientId } from './mcpDiscovery'
import { captureError } from './sentry'

const CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export type HookStatusEntry = { client: McpClientId; installed: boolean; hasHook: boolean }

let statusCheckTimer: ReturnType<typeof setInterval> | null = null
let errorsWatcher: ReturnType<typeof watch> | null = null
let lastKnownStatus: HookStatusEntry[] = []
let onHooksMissing: ((entries: HookStatusEntry[]) => void) | null = null

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
  const withHooks = s.filter((e) => e.hasHook).length
  const total = s.length
  if (withHooks === total) return 'Hooks: installed and healthy'
  if (withHooks === 0) return 'Hooks: not installed'
  return `Hooks: ${withHooks}/${total} installed`
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
  const current = await getHookStatus()
  const prevMap = new Map(current.map((e) => [e.client, e]))
  const missing: HookStatusEntry[] = []

  for (const last of lastKnownStatus) {
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
  getHookStatus().then((s) => {
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

  startErrorsDirWatcher()
  console.log('[HookHealthMonitor] Started (interval %d ms)', CHECK_INTERVAL_MS)
}

/**
 * Stop periodic checks and the errors-dir watcher.
 */
export async function stopHookHealthMonitor(): Promise<void> {
  if (statusCheckTimer) {
    clearInterval(statusCheckTimer)
    statusCheckTimer = null
  }
  if (errorsWatcher) {
    await errorsWatcher.close()
    errorsWatcher = null
  }
  onHooksMissing = null
  console.log('[HookHealthMonitor] Stopped')
}
