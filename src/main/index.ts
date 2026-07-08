import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  dialog
} from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendFileSync, unlinkSync } from 'fs'
import { installMonitorTee } from './runtime/monitorLog'

installMonitorTee()

// os.tmpdir() = %TEMP% on Windows, /tmp on Unix (a hardcoded '/tmp' silently no-ops on Windows).
const LOG_FILE = join(tmpdir(), 'ew-startup.log')
function slog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {}
  console.log(msg)
}
import { startAuthLoopbackServer, getAuthLoopbackUrl } from './runtime/authLoopbackServer'
import { initDeepLinkAuth, deliverAuthCallback, flushBufferedAuthCallback } from './runtime/deepLinkAuth'
// Inline replacements for @electron-toolkit/utils (removed due to Electron 40 compat issue:
// it evaluates electron.app.isPackaged at module load time, crashing before app.ready)
const is = {
  get dev() {
    return !app.isPackaged
  }
}
const electronApp = {
  setAppUserModelId: (id: string) => {
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? id : process.execPath)
  }
}
const optimizer = {
  watchWindowShortcuts: (_win: BrowserWindow) => {
    /* no-op: dev shortcuts removed */
  }
}
import windowStateKeeper from 'electron-window-state'
import { injectAllHooks, isCodexInstalled } from './runtime/hookInjection'
import { initSentry } from './infra/sentry'
import { startHookHealthMonitor, stopHookHealthMonitor } from './runtime/hookHealthMonitor'
import { initUpdateManager, stopUpdateManager } from './infra/updateManager'
import { warmOrgIdCacheOnStartup } from './infra/orgIdCache'
import {
  applyAppIntegrations,
  findAppsMissingClientTag,
  findAppsNeedingReRegistration
} from './runtime/mcpConfigWriter'
import {
  initQuarantineManager,
  startQuarantineMonitorIfEnabled,
  handleQuarantineEnabled,
  handleQuarantineDisabled,
  stopQuarantineMonitor,
  startQuarantinePolling,
  stopQuarantinePolling,
  pollQuarantineConfig
} from './quarantine/quarantineManager'
import {
  getBuildDefaultEnv,
  getActiveEnv,
  getApiBaseUrl,
  getMcpBaseUrl,
  ALL_SUPPORTED_APPS,
  getSetupData,
  isSetupComplete,
  markSetupComplete,
  getCredentialsForEnv,
  markSetupIncomplete,
  startServerStatusChecks,
  stopServerStatusChecks,
  checkClaudeCodeMcpConnection
} from './infra/setupConfig'
import {
  pendingApprovals,
  startEventSubscription as _startEventSubscription,
  stopEventSubscription,
  initApprovalsHandler,
  setSseStatusCallback
} from './ipc/approvalsHandler'
import { registerIpcHandlers } from './ipc/ipcHandlers'
import { bootstrapDetectord } from './detectord/bootstrap'
import { detectordPrimary } from './detectord/mode'
import { buildAppMenu as buildAppMenuFromDeps } from './menus/appMenu'
import { buildTrayMenuItems as buildTrayMenuItemsFromDeps } from './menus/trayMenu'
import { integrateDesktopEntry } from './runtime/desktopIntegration'
import { stageStdiodBinary } from './runtime/stdiodBinary'
import { refreshStdiodStatusCache, startStdiodStatusCacheRefresh } from './stdiod/trayCache'
import { uninstall as uninstallStdiod } from './stdiod/controller'
import { uninstallService as uninstallDetectord } from './detectord/controller'
import { maybeRefreshStdiodInstall } from './stdiod/installRefresh'

// eslint-disable-next-line @typescript-eslint/no-require-imports
import appIconPath from '../../resources/icon.png?asset'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from '../../resources/icon_tray.png?asset'
// Multi-resolution .ico for the Windows taskbar/window icon (PNG renders blurry
// at small sizes and isn't picked up unpackaged). macOS/Linux use the exe/.icns.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import winIconPath from '../../resources/icon.ico?asset'

// Baked at build time by electron.vite.config.ts (define). true = compact Linux
// tray menu; false = full menu. Default build is compact; EDISON_TRAY_COMPACT=0
// produces the full-menu variant.
declare const __TRAY_COMPACT__: boolean

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let approvalWindow: BrowserWindow | null = null
let isRestarting = false // suppress app.quit() during intentional restarts

function startEventSubscription(): void {
  _startEventSubscription(handleQuarantineEnabled, handleQuarantineDisabled, () => {
    pollQuarantineConfig().catch(() => {})
  })
}

function buildTrayMenuItems(): MenuItemConstructorOptions[] {
  return buildTrayMenuItemsFromDeps({
    getMainWindow: () => mainWindow,
    showMainWindow,
    updateTrayMenu,
    rerunWizard,
    handleClearDataAndRestart,
    handleLogoutAndRestart
  })
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate(buildTrayMenuItems())
}

// Linux: refresh the stdiod status cache, THEN (re)attach the tray menu. Linux
// tray backends have no menu-open event, so we refresh on every (re)build to
// keep the status rows fresh - the parity equivalent of the other platforms'
// on-open refresh in showMenu(). (refreshStdiodStatusCache never rejects.)
function refreshAndSetLinuxTrayMenu(): void {
  void refreshStdiodStatusCache().then(() => {
    if (tray) tray.setContextMenu(buildTrayMenu())
  })
}

function createTray(): void {
  // Guard against duplicate trays: sign-out re-runs the wizard, which fires
  // `setup:reached-final` and calls createTray() again. Without this check the
  // previous Tray stays alive, leaving two Edison icons in the menu bar / system tray.
  if (tray) {
    updateTrayMenu()
    return
  }
  // macOS/Linux: use the dedicated tray icon (transparent, works with light+dark menu bars)
  // Windows: resize the main app icon (transparent icons look bad on Windows system tray)
  let trayIconToUse: string | Electron.NativeImage = trayIconPath
  if (process.platform === 'win32') {
    const img = nativeImage.createFromPath(appIconPath)
    trayIconToUse = img.resize({ width: 16, height: 16 })
  }
  tray = new Tray(trayIconToUse)
  tray.setToolTip('Edison Watch')

  const showMenu = (): void => {
    if (!tray) return
    refreshStdiodStatusCache().catch(() => {})
    tray.popUpContextMenu(buildTrayMenu())
  }

  if (process.platform === 'linux') {
    // Linux tray backends (libappindicator / StatusNotifierItem) don't emit
    // 'click'/'right-click' events and only render an attached context menu, so
    // the popUpContextMenu approach below never fires. Bind the menu directly
    // (refreshed first, so the first menu isn't built from a stale/default
    // cache); kept current by updateTrayMenu().
    refreshAndSetLinuxTrayMenu()
  } else {
    // Windows: left-click opens the app, right-click shows the menu.
    // macOS menu-bar convention: any click shows the menu (the dock icon reopens the window).
    tray.on('click', process.platform === 'darwin' ? showMenu : showMainWindow)
    tray.on('right-click', showMenu)
  }

  startServerStatusChecks(updateTrayMenu)
  startStdiodStatusCacheRefresh(10_000, updateTrayMenu)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (process.platform === 'darwin' && (app as any).dock?.setMenu) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(app as any).dock.setMenu(buildTrayMenu())
  }
}

function updateTrayMenu(): void {
  // Linux binds the menu directly (no click event to refresh on open), so
  // refresh the status cache and re-attach on every rebuild to stay current.
  if (tray && process.platform === 'linux') {
    refreshAndSetLinuxTrayMenu()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (tray && process.platform === 'darwin' && (app as any).dock?.setMenu) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(app as any).dock.setMenu(buildTrayMenu())
  }
  updateAppMenu()
}

function buildAppMenu(): Electron.Menu {
  return buildAppMenuFromDeps({
    getMainWindow: () => mainWindow,
    updateAppMenu,
    updateTrayMenu,
    logEnvConfig,
    slog,
    handleClearDataAndRestart,
    buildTrayMenuItems
  })
}

function updateAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu())
}

async function rerunWizard(): Promise<void> {
  markSetupIncomplete()
  isRestarting = true
  BrowserWindow.getAllWindows().forEach((w) => w.destroy())
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'cookies', 'indexdb']
  })
  isRestarting = false
  createWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMinimumSize(400, 500)
    mainWindow.setSize(540, 760, true)
    mainWindow.center()
  }
}

function stopAllServices(): void {
  stopServerStatusChecks()
  stopUpdateManager()
  stopEventSubscription()
  stopHookHealthMonitor()
  stopQuarantineMonitor()
  stopQuarantinePolling()
  pendingApprovals.clear()
}

async function handleLogoutAndRestart(): Promise<void> {
  console.log('[Logout] Signing out...')
  stopAllServices()
  // Remove the stdiod LaunchAgent so the daemon doesn't keep running (and
  // relaunching via launchd) under a signed-out app. purge=false keeps
  // config.toml, mirroring how logout keeps accounts.json - the LaunchAgent
  // is only ever re-added by an explicit toggle-on or reset.
  await uninstallStdiod({ purge: false }).catch(() => {})
  markSetupIncomplete()
  updateTrayMenu()
  await rerunWizard()
}

const CLEAR_DATA_FILES = [
  'setup.json',
  'accounts.json',
  '.personal-key.enc',
  'edison_debug_env.json',
  'seen-servers.json'
]
async function handleClearDataAndRestart(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Clear & Restart'],
    defaultId: 0,
    cancelId: 0,
    title: 'Clear App Data',
    message: 'This will delete all local config files and restart the app. This cannot be undone.'
  })
  if (response !== 1) return
  const userDataPath = app.getPath('userData')
  slog(`[clear-data] Clearing app data at: ${userDataPath}`)
  stopAllServices()
  // A full wipe deletes accounts.json + storage, so tear the daemon down
  // completely too: purge removes the LaunchAgent, config.toml, state.json,
  // and logs. Otherwise launchd would keep the daemon alive (and restart it)
  // with credentials the app no longer has. Best-effort - never block the
  // wipe on it. Awaited so it finishes before app.exit().
  await uninstallStdiod({ purge: true }).catch(() => {})
  slog('[clear-data] Tore down stdiod daemon')
  // Same for the detector daemon: purge removes the LaunchAgent plus all data
  // (enrollment, seen-store, quarantine records, logs, socket).
  await uninstallDetectord({ purge: true }).catch(() => {})
  slog('[clear-data] Tore down detector daemon')
  for (const file of CLEAR_DATA_FILES) {
    try {
      unlinkSync(join(userDataPath, file))
      slog(`[clear-data] Removed ${file}`)
    } catch {
      /* may not exist */
    }
  }
  await session.defaultSession.clearStorageData()
  slog('[clear-data] Relaunching app...')
  app.relaunch()
  app.exit(0)
}

// ── Window creation ─────────────────────────────────────────────────

function createWindow(): void {
  slog('createWindow: start')
  // The renderer is dark-mode only; force the OS chrome to match so the Windows
  // title bar (and any native widgets) render dark instead of clashing white.
  nativeTheme.themeSource = 'dark'
  const mainWindowState = windowStateKeeper({
    defaultWidth: 461,
    defaultHeight: 605
  })

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 400,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    // Match the renderer's dark background to avoid a white flash before paint.
    backgroundColor: '#1C1C1C',
    ...(process.platform === 'win32' ? { icon: winIconPath } : {}),
    // Use the bundled asset (electron-vite ?asset), not build/icon.png - the
    // build/ dir is buildResources and isn't packed, so that path didn't exist
    // and the window fell back to GNOME's generic icon.
    ...(process.platform === 'linux' ? { icon: appIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindowState.manage(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Tracks whether the initial show has happened, so the Linux did-finish-load
  // fallback below fires at most once (a later reload's did-finish-load must not
  // re-show a window the user hid to the tray).
  let initialShowDone = false

  mainWindow.on('ready-to-show', () => {
    slog('ready-to-show, showing window')
    initialShowDone = true
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    slog('did-finish-load')
    logEnvConfig('startup')
    // Linux-only fallback: `ready-to-show` is unreliable there (may never fire),
    // which would leave this `show: false` window hidden forever. win/mac rely
    // on ready-to-show for anti-flash timing, so don't show here. First load
    // only - did-finish-load also fires on reload/navigation.
    if (process.platform === 'linux' && !initialShowDone) {
      initialShowDone = true
      mainWindow?.show()
    }
    // Push any callback buffered before the page loaded (left buffered so the
    // renderer mount-pull can also claim it; renderer de-dupes).
    flushBufferedAuthCallback()
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    slog(`did-fail-load code=${code} desc=${desc}`)
  )
  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    slog(`render-process-gone reason=${d.reason} code=${d.exitCode}`)
  )
  if (process.env.EDISON_DEBUG_RENDERER === 'true') {
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      slog(`[renderer:${level}] ${message}`)
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (navigationUrl.includes('/auth/callback') || navigationUrl.includes('code=')) {
      event.preventDefault()
      deliverAuthCallback(navigationUrl, 'will-navigate')
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Bring the GUI back to the foreground. Closing the window destroys it (mainWindow
// = null) but the app keeps running in the tray, so recreate it when it's gone -
// otherwise there is no way to reopen on Windows/Linux (macOS uses 'activate').
function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

// Single-instance lock + edison-watch:// deep-link callback wiring (see deepLinkAuth).
// Returns false for a doomed second instance - whenReady early-returns on it below.
const gotSingleInstanceLock = initDeepLinkAuth({
  getMainWindow: () => mainWindow,
  showMainWindow,
  log: slog
})

// ── App lifecycle ───────────────────────────────────────────────────

// Sentry must be initialized before the app 'ready' event fires
initSentry()

function logEnvConfig(context: string): void {
  const msg = `[env:${context}] activeEnv=${getActiveEnv()} buildEnv=${getBuildDefaultEnv()} apiBaseUrl=${getApiBaseUrl()} mcpBaseUrl=${getMcpBaseUrl()} VITE_API_BASE_URL=${import.meta.env.VITE_API_BASE_URL ?? ''} VITE_MCP_BASE_URL=${import.meta.env.VITE_MCP_BASE_URL ?? ''}`
  slog(msg)
  mainWindow?.webContents.executeJavaScript(`console.log(${JSON.stringify(msg)})`).catch(() => {})
}

slog('module loaded, waiting for app.whenReady')

// Wire up the quarantine manager so it can trigger tray menu updates
initQuarantineManager(updateTrayMenu, () => mainWindow)

// Wire up SSE connection status changes to refresh tray menu
setSseStatusCallback(updateTrayMenu)

// Wire up the approvals handler so it can access mainWindow/approvalWindow
initApprovalsHandler(
  () => mainWindow,
  () => approvalWindow,
  (w) => {
    approvalWindow = w
  },
  updateTrayMenu
)

app.whenReady().then(async () => {
  // Doomed second instance (lost the lock) - already forwarded its argv and
  // quitting; never build a window.
  if (!gotSingleInstanceLock) return
  slog('app.whenReady fired')
  electronApp.setAppUserModelId('com.edisonwatch.desktop')
  updateAppMenu()

  // Linux/AppImage: copy the daemon out of the ephemeral FUSE mount to a stable
  // path BEFORE anything invokes or installs it. The AppImage mounts at a fresh
  // /tmp/.mount_* dir each launch, so a systemd unit pointing ExecStart there
  // breaks the moment the app exits (status=203/EXEC -> crash-loop). No-op on
  // mac/win/dev. See runtime/stdiodBinary.ts.
  stageStdiodBinary()

  // Linux/AppImage: self-install a .desktop entry + icon so the dock/taskbar
  // shows the Edison icon and the app is pinnable. No-op on mac/win/dev and for
  // non-AppImage runs. See runtime/desktopIntegration.ts.
  integrateDesktopEntry(appIconPath)

  // Loopback auth-callback server - started in dev AND packaged builds. Chrome
  // silently blocks gesture-less redirects to custom protocols (edison-watch://),
  // but a plain http://127.0.0.1 navigation has no such gate, so we prefer the
  // loopback for the SSO/OAuth callback (getRedirectTo picks it up automatically).
  // edison-watch:// stays registered as a fallback if the server can't start.
  // See login_sso_chrome_issue.md.
  try {
    await Promise.race([
      startAuthLoopbackServer(() => mainWindow),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('auth loopback server listen timeout')), 5_000)
      )
    ])
    slog(`auth loopback server listening at ${getAuthLoopbackUrl() ?? '(unknown)'}`)
  } catch (err) {
    slog(`auth loopback server failed to start; falling back to edison-watch://: ${err}`)
    console.error('[App] Auth loopback server failed to start, falling back to protocol:', err)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  slog('calling registerIpcHandlers')
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getAuthLoopbackUrl: () => getAuthLoopbackUrl(),
    createTray,
    startEventSubscription,
    startQuarantineMonitorIfEnabled,
    startQuarantinePolling
  })
  slog('registerIpcHandlers ok')

  ipcMain.handle('app:clearDataAndRestart', () => handleClearDataAndRestart())

  // Auto-updater: start regardless of setup state (updates are independent of
  // auth). Polling only runs in packaged/test builds; see updateManager.
  initUpdateManager({ onStateChange: updateTrayMenu, getMainWindow: () => mainWindow })

  // The stdiod daemon survives app auto-updates as a stale launchd process;
  // restart it onto the freshly shipped binary when the bundle changed.
  maybeRefreshStdiodInstall().catch((err) => console.error('[Stdiod] install refresh failed:', err))

  // Install + launch the detector daemon on EVERY client run (not gated on
  // setup): the daemon owns detection/quarantine/install/hooks. Enrolls if
  // credentials exist yet; otherwise the setup:complete handler enrolls on login.
  bootstrapDetectord().catch((err) => console.error('[detectord] bootstrap failed:', err))

  if (isSetupComplete()) {
    slog('setup complete, creating tray')
    createTray()
    startEventSubscription()
    // The TS hooks/quarantine pipeline stands down when the daemon is primary
    // (it owns those). See detectord/mode.ts.
    if (!detectordPrimary()) {
      startHookHealthMonitor()
      // Await hook injection before quarantine monitor to avoid config file races
      await injectAllHooks().catch((err) => console.error('[HookInjection] Failed:', err))
    }

    await warmOrgIdCacheOnStartup()
    if (!detectordPrimary()) {
      startQuarantineMonitorIfEnabled().catch((err) => console.error('[Quarantine] Failed:', err))
      startQuarantinePolling()
    }

    // Self-heal: re-register edison-watch for any apps where the config was
    // cleared externally. Skipped when the daemon is primary — it owns install.
    const setup = getSetupData()
    const mcpBaseUrl = getMcpBaseUrl()
    const creds = getCredentialsForEnv()
    if (!detectordPrimary() && mcpBaseUrl && creds?.apiKey) {
      const rawApps = setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
      let configuredApps = rawApps.filter((app) => ALL_SUPPORTED_APPS.includes(app))

      // One-time backfill: add Codex for users who onboarded before it was in the detection list
      const migrations = setup.appliedMigrations ?? []
      if (
        !migrations.includes('codex-backfill') &&
        !configuredApps.includes('codex') &&
        isCodexInstalled()
      ) {
        slog('startup: backfilling codex into configuredApps')
        configuredApps = [...configuredApps, 'codex']
        markSetupComplete({ configuredApps, appliedMigrations: [...migrations, 'codex-backfill'] })
      } else if (!migrations.includes('codex-backfill')) {
        markSetupComplete({ appliedMigrations: [...migrations, 'codex-backfill'] })
      }

      // Claude Code: check via CLI (separate path since it uses `claude mcp get`)
      if (configuredApps.includes('claude-code')) {
        checkClaudeCodeMcpConnection()
          .then(async (status) => {
            if (status === 'connected') {
              slog('startup: Claude Code MCP already connected, skipping re-registration')
              return
            }
            slog(`startup: Claude Code MCP status is "${status}", re-registering`)
            await applyAppIntegrations({
              serverAddress: setup.serverAddress ?? '',
              mcpBaseUrl,
              apiKey: creds.apiKey,
              edisonSecretKey: creds.edisonSecretKey,
              apps: ['claude-code']
            })
            slog('startup: Claude Code MCP re-registration complete')
          })
          .catch((err) =>
            console.error('[Startup] Failed to check/re-register Claude Code MCP:', err)
          )
      }

      // All other apps: check config files for missing or stale edison-watch entry
      const expectedUrl = `${mcpBaseUrl.replace(/\/$/, '')}/mcp/${creds.apiKey}/`
      findAppsNeedingReRegistration(configuredApps, expectedUrl)
        .then(async (missingApps) => {
          if (missingApps.length === 0) {
            slog('startup: all configured apps have edison-watch registered')
            return
          }
          slog(`startup: edison-watch missing from ${missingApps.join(', ')}, re-registering`)
          await applyAppIntegrations({
            serverAddress: setup.serverAddress ?? '',
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: creds.edisonSecretKey,
            apps: missingApps
          })
          slog(`startup: re-registered edison-watch for ${missingApps.join(', ')}`)
        })
        .catch((err) =>
          console.error('[Startup] Failed to check/re-register app MCP configs:', err)
        )

      // One-time migration: add ?client= tag to URLs missing it (includes claude-code)
      findAppsMissingClientTag(configuredApps)
        .then(async (apps) => {
          if (apps.length === 0) return
          slog(`startup: adding client tag to ${apps.join(', ')}`)
          await applyAppIntegrations({
            serverAddress: setup.serverAddress ?? '',
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: creds.edisonSecretKey,
            apps
          })
          slog(`startup: client tag migration done for ${apps.join(', ')}`)
        })
        .catch((err) => console.error('[Startup] client tag migration failed:', err))
    }

    slog('tray/subscription/monitor ok')
  } else {
    slog('setup not complete')
  }

  slog('calling createWindow')
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isRestarting && !tray) {
    app.quit()
  }
})
