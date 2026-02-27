/**
 * Lightweight version checker for the Edison Watch desktop client.
 *
 * Periodically fetches the electron-builder manifest from releases.edison.watch,
 * compares the remote version against `app.getVersion()`, and exposes the result
 * so the tray menu / menu window can surface an "Update available" prompt.
 *
 * This is intentionally *not* an auto-updater -- it only checks and notifies.
 * The user downloads the new version themselves via the provided URL.
 */

import { app, shell, Notification } from 'electron'

const RELEASES_BASE_URL = 'https://releases.edison.watch'

/** Check every 4 hours after the initial startup check. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Delay before the first check (avoid slowing down startup). */
const INITIAL_DELAY_MS = 15_000

/** Maps `process.platform` to the electron-builder manifest filename. */
const PLATFORM_MANIFESTS: Record<string, string> = {
  darwin: 'latest-mac.yml',
  win32: 'latest.yml',
  linux: 'latest-linux.yml'
}

export interface UpdateInfo {
  /** The version string advertised in the manifest (e.g. "0.1.165"). */
  version: string
  /** Direct download URL for the installer binary. */
  downloadUrl: string
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let latestUpdateInfo: UpdateInfo | null = null
let checkInterval: NodeJS.Timeout | null = null
let startupTimeout: NodeJS.Timeout | null = null
let onUpdateAvailableCallback: (() => void) | null = null

// ---------------------------------------------------------------------------
// Version comparison helpers
// ---------------------------------------------------------------------------

/** Parse a dotted version string into an array of integers. */
function parseVersion(version: string): number[] {
  return version.split('.').map((p) => parseInt(p, 10) || 0)
}

/** Returns `true` when `remote` is strictly newer than `local`. */
function isNewerVersion(local: string, remote: string): boolean {
  const localParts = parseVersion(local)
  const remoteParts = parseVersion(remote)
  const len = Math.max(localParts.length, remoteParts.length)
  for (let i = 0; i < len; i++) {
    const l = localParts[i] ?? 0
    const r = remoteParts[i] ?? 0
    if (r > l) return true
    if (r < l) return false
  }
  return false
}

// ---------------------------------------------------------------------------
// Manifest fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the electron-builder manifest for the current platform and extract
 * the `version` and `path` fields.
 */
async function fetchLatestVersion(): Promise<UpdateInfo | null> {
  const manifestFile = PLATFORM_MANIFESTS[process.platform]
  if (!manifestFile) return null

  try {
    const res = await fetch(`${RELEASES_BASE_URL}/${manifestFile}`, {
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return null

    const text = await res.text()

    // electron-builder manifests are simple YAML; we only need two fields.
    const versionMatch = text.match(/^version:\s*(.+)$/m)
    const pathMatch = text.match(/^path:\s*(.+)$/m)

    if (!versionMatch?.[1]) return null

    const version = versionMatch[1].replace(/#.*$/, '').trim()
    const filename = pathMatch?.[1]?.replace(/#.*$/, '').trim()
    const downloadUrl = filename
      ? `${RELEASES_BASE_URL}/${filename}`
      : RELEASES_BASE_URL

    return { version, downloadUrl }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Check logic
// ---------------------------------------------------------------------------

/**
 * Run a single update check. Updates internal state and, when a *new*
 * version is first discovered, fires the callback and shows a native
 * notification.
 */
async function runCheck(trayIconPath?: string): Promise<void> {
  const remote = await fetchLatestVersion()
  if (!remote) return

  const currentVersion = app.getVersion()
  if (!isNewerVersion(currentVersion, remote.version)) {
    // We're up to date (or ahead, e.g. dev builds).
    latestUpdateInfo = null
    return
  }

  const previousVersion = latestUpdateInfo?.version ?? null
  latestUpdateInfo = remote

  // Only notify when we first discover this particular newer version.
  if (remote.version !== previousVersion) {
    console.log(
      `[Update] New version available: ${remote.version} (current: ${currentVersion})`
    )

    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Edison Watch Update Available',
        body: `Version ${remote.version} is available. Click to download.`,
        ...(process.platform !== 'darwin' && trayIconPath ? { icon: trayIconPath } : {})
      })
      notification.on('click', () => {
        shell.openExternal(remote.downloadUrl)
      })
      notification.show()
    }

    onUpdateAvailableCallback?.()
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start periodic update checks. Safe to call multiple times; subsequent
 * calls are no-ops.
 *
 * @param opts.trayIcon   - Path to the tray icon (used in notifications on non-macOS).
 * @param opts.onUpdateAvailable - Callback fired when a new update is first detected
 *                                 (e.g. to refresh the tray menu).
 */
export function startUpdateChecker(opts?: {
  trayIcon?: string
  onUpdateAvailable?: () => void
}): void {
  if (checkInterval) return // already running

  onUpdateAvailableCallback = opts?.onUpdateAvailable ?? null

  // First check after a short startup delay.
  startupTimeout = setTimeout(() => {
    runCheck(opts?.trayIcon).catch((err) =>
      console.error('[Update] Check failed:', err)
    )
  }, INITIAL_DELAY_MS)

  // Subsequent periodic checks.
  checkInterval = setInterval(() => {
    runCheck(opts?.trayIcon).catch((err) =>
      console.error('[Update] Check failed:', err)
    )
  }, CHECK_INTERVAL_MS)
}

/** Stop all periodic update checks and clean up timers. */
export function stopUpdateChecker(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout)
    startupTimeout = null
  }
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  onUpdateAvailableCallback = null
}

/**
 * Returns the available update info, or `null` if no newer version has
 * been detected (or checking hasn't completed yet).
 */
export function getAvailableUpdate(): UpdateInfo | null {
  return latestUpdateInfo
}

/** Open the download URL for the latest update in the default browser. */
export function openUpdateDownload(): void {
  const url = latestUpdateInfo?.downloadUrl ?? RELEASES_BASE_URL
  shell.openExternal(url)
}
