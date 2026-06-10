/**
 * Auto-updater for the Edison Watch desktop client, built on electron-updater.
 *
 * Replaces the old notify-only updateChecker. Behaviour:
 *   - Feed is electron-updater's `generic` provider pointed at the active
 *     environment's release bucket (demo -> demo-releases, release -> releases),
 *     resolved at runtime via getReleasesBaseUrl(). The two channels are
 *     isolated by URL, so no electron-updater "channel" split is needed.
 *   - autoDownload / autoInstallOnAppQuit come from updateSettings (per-channel
 *     defaults, user-overridable). Release downloads silently; demo downloads
 *     on demand. Both install on quit once a build has been downloaded.
 *   - State is surfaced to the tray (via onStateChange) and to the renderer
 *     (via the 'update:status' channel) so the in-window banner + tray item can
 *     show "available" / progress / "restart to update".
 *
 * Local testing without publishing: set EW_UPDATE_TEST=1 and EW_UPDATE_FEED to
 * a local static server serving latest-mac.yml + the zip (see
 * scripts/test-autoupdate.sh). forceDevUpdateConfig lets checks run unpackaged.
 *
 * macOS note: the *apply* step (Squirrel) requires the running app to be
 * Developer-ID signed; checking + downloading work unsigned (UI testing only).
 */

import { app, BrowserWindow } from 'electron'
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { getReleasesBaseUrl } from './setupConfig'
import { getUpdateSettings, setUpdateSettings, type UpdateSettings } from './updateSettings'

// electron-updater is CJS; under electron-vite a named import resolves to
// undefined, so take the default export and destructure it.
const { autoUpdater } = electronUpdater

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** Version offered (available/downloaded), else null. */
  version: string | null
  /** Download progress 0-100 while downloading, else null. */
  percent: number | null
  /** Last error message (status 'error'), else null. */
  error: string | null
  /** Effective settings, echoed so the renderer can render toggles. */
  autoDownload: boolean
  autoInstallOnQuit: boolean
}

/** Check every 4 hours after the initial startup check. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** Delay before the first check (avoid slowing startup). */
const INITIAL_DELAY_MS = 8_000

let internal: Omit<UpdateState, 'autoDownload' | 'autoInstallOnQuit'> = {
  status: 'idle',
  version: null,
  percent: null,
  error: null
}

let onStateChange: (() => void) | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
let configured = false
let polling = false
let startupTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null

/** Auto-update only runs in a packaged app, or when explicitly testing locally. */
function isEnabled(): boolean {
  return app.isPackaged || Boolean(process.env.EW_UPDATE_TEST)
}

export function getUpdateState(): UpdateState {
  const s = getUpdateSettings()
  return { ...internal, autoDownload: s.autoDownload, autoInstallOnQuit: s.autoInstallOnQuit }
}

function emit(): void {
  onStateChange?.()
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', getUpdateState())
  }
}

function applyFeed(): void {
  const testFeed = process.env.EW_UPDATE_FEED
  if (process.env.EW_UPDATE_TEST && testFeed) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: testFeed, channel: 'latest' })
    console.log(`[update] using local test feed: ${testFeed}`)
    return
  }
  const base = getReleasesBaseUrl()
  if (!base) {
    console.log('[update] no release feed for active env; auto-update disabled')
    return
  }
  const url = `${base.replace(/\/$/, '')}/client/latest`
  autoUpdater.setFeedURL({ provider: 'generic', url, channel: 'latest' })
  console.log(`[update] feed: ${url}`)
}

function registerEventHandlers(): void {
  autoUpdater.on('checking-for-update', () => {
    internal = { ...internal, status: 'checking', error: null }
    emit()
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    // With autoDownload on, electron-updater starts fetching immediately and a
    // 'download-progress' event follows; with it off we stay 'available' until
    // the user triggers downloadUpdate().
    internal = { ...internal, status: 'available', version: info.version, error: null }
    emit()
  })
  autoUpdater.on('update-not-available', () => {
    internal = { status: 'idle', version: null, percent: null, error: null }
    emit()
  })
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    internal = { ...internal, status: 'downloading', percent: Math.round(p.percent) }
    emit()
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    internal = { status: 'downloaded', version: info.version, percent: 100, error: null }
    emit()
  })
  autoUpdater.on('error', (err: Error) => {
    const msg = err?.message ?? 'Update error'
    console.error('[update] error:', msg)
    if (internal.status === 'downloading') {
      // Download failed - revert to 'available' so the banner stays visible with
      // a Retry affordance and the reason is shown, rather than silently dying.
      internal = { ...internal, status: 'available', percent: null, error: msg }
      emit()
    } else if (internal.status === 'checking') {
      // A failed check (offline, no published version) stays quiet - no banner.
      internal = { ...internal, status: 'idle', error: msg }
      emit()
    }
  })
}

export function initUpdateManager(opts: {
  onStateChange: () => void
  getMainWindow: () => BrowserWindow | null
}): void {
  onStateChange = opts.onStateChange
  getMainWindow = opts.getMainWindow

  if (!configured) {
    configured = true
    const s = getUpdateSettings()
    autoUpdater.autoDownload = s.autoDownload
    autoUpdater.autoInstallOnAppQuit = s.autoInstallOnQuit
    autoUpdater.autoRunAppAfterInstall = true
    // Demo versions are semver prereleases (e.g. 0.4.0-demo.142). Feeds are
    // URL-isolated, so allowing prereleases only affects the demo feed; the
    // release feed only ever publishes clean versions.
    autoUpdater.allowPrerelease = true
    autoUpdater.logger = {
      info: (m) => console.log('[update]', m),
      warn: (m) => console.warn('[update]', m),
      error: (m) => console.error('[update]', m),
      debug: () => {}
    }
    registerEventHandlers()
  }

  applyFeed()
  startPolling()
}

function startPolling(): void {
  if (!isEnabled() || polling) return
  polling = true
  startupTimer = setTimeout(() => {
    checkForUpdates().catch((err) => console.error('[update] initial check failed:', err))
  }, INITIAL_DELAY_MS)
  intervalTimer = setInterval(() => {
    checkForUpdates().catch((err) => console.error('[update] periodic check failed:', err))
  }, CHECK_INTERVAL_MS)
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!isEnabled()) return getUpdateState()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[update] checkForUpdates failed:', err)
    internal = {
      ...internal,
      status: 'error',
      error: err instanceof Error ? err.message : String(err)
    }
    emit()
  }
  return getUpdateState()
}

export async function downloadUpdate(): Promise<void> {
  if (!isEnabled()) return
  internal = { ...internal, error: null }
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[update] downloadUpdate failed:', msg)
    // Keep status 'available' so the banner offers a Retry; surface the reason.
    internal = { ...internal, error: msg }
    emit()
  }
}

/** Quit and install a downloaded update now. No-op if nothing is downloaded. */
export function quitAndInstall(): void {
  if (internal.status !== 'downloaded') return
  try {
    // (isSilent=false, isForceRunAfter=true) so the app relaunches after install.
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    console.error('[update] quitAndInstall failed:', err)
  }
}

export function getSettings(): UpdateSettings {
  return getUpdateSettings()
}

export function updateSettings(patch: Partial<UpdateSettings>): UpdateSettings {
  const s = setUpdateSettings(patch)
  autoUpdater.autoDownload = s.autoDownload
  autoUpdater.autoInstallOnAppQuit = s.autoInstallOnQuit
  emit()
  return s
}

/** True when a newer version has been downloaded and is ready to install. */
export function isUpdateDownloaded(): boolean {
  return internal.status === 'downloaded'
}

/** Version of a pending update (available or downloaded), else null. */
export function getPendingUpdateVersion(): string | null {
  return internal.status === 'available' || internal.status === 'downloaded'
    ? internal.version
    : null
}

export function stopUpdateManager(): void {
  if (startupTimer) {
    clearTimeout(startupTimer)
    startupTimer = null
  }
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
  polling = false
}
