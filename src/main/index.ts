import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  Tray,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  clipboard,
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
import {
  startHookHealthMonitor,
  stopHookHealthMonitor,
  getHookStatusLabel
} from './runtime/hookHealthMonitor'
import {
  initUpdateManager,
  stopUpdateManager,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  isUpdateDownloaded,
  getPendingUpdateVersion
} from './infra/updateManager'
import { showDebugWindow } from './dialogs/debugWindow'
import { showFeedbackWindow } from './dialogs/feedbackWindow'
import { showServerRegistrationDialog } from './dialogs/mcpServerActionDialog'
import { showUpdateKeysWindow } from './dialogs/updateKeysWindow'
import { fetchUserRole } from './discovery/mcpServerSubmit'
import { warmOrgIdCacheOnStartup } from './infra/orgIdCache'
import {
  applyAppIntegrations,
  findAppsMissingClientTag,
  findAppsNeedingReRegistration
} from './runtime/mcpConfigWriter'
import {
  initQuarantineManager,
  getAutoQuarantineEnabled,
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
  getMcpUrl,
  getMcpConfig,
  ALL_SUPPORTED_APPS,
  getSetupData,
  isSetupComplete,
  markSetupComplete,
  getCredentialsForEnv,
  markSetupIncomplete,
  startServerStatusChecks,
  stopServerStatusChecks,
  getIsServerOnline,
  checkClaudeCodeMcpConnection
} from './infra/setupConfig'
import {
  pendingApprovals,
  startEventSubscription as _startEventSubscription,
  stopEventSubscription,
  showPendingApprovalsDialog,
  initApprovalsHandler,
  isSseConnected,
  setSseStatusCallback
} from './ipc/approvalsHandler'
import { registerIpcHandlers } from './ipc/ipcHandlers'
import { buildAppMenu as buildAppMenuFromDeps } from './menus/appMenu'
import { integrateDesktopEntry } from './runtime/desktopIntegration'
import { stageStdiodBinary } from './runtime/stdiodBinary'
import { refreshStdiodStatusCache, startStdiodStatusCacheRefresh } from './stdiod/trayCache'
import { buildStdiodMenuItems } from './stdiod/trayMenu'
import { uninstall as uninstallStdiod } from './stdiod/controller'
import { maybeRefreshStdiodInstall } from './stdiod/installRefresh'
import { handleStdiodReset } from './stdiod/trayReset'

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
  const setupData = getSetupData()
  const pendingCount = pendingApprovals.size
  const userDisplayName = setupData.userEmail || 'Not signed in'
  // Trim the tray menu only on Linux AND when built compact (__TRAY_COMPACT__
  // is baked at build time - see electron.vite.config.ts). The full-menu Linux
  // build sets this false so Linux shows the same menu as win/mac.
  const compactTray = process.platform === 'linux' && __TRAY_COMPACT__

  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Edison Watch', click: () => showMainWindow() },
    // "Enabled" + Backend/Live/account status are dropped on Linux (status is in
    // the main window). The leading separator lives inside the block so Linux
    // doesn't end up with two adjacent separators.
    ...(compactTray
      ? []
      : ([
          { type: 'separator' },
          { label: 'Enabled', type: 'checkbox', checked: true, click: () => {} },
          {
            label: getIsServerOnline() ? 'Backend: Connected' : 'Backend: Disconnected',
            enabled: false
          },
          {
            label: isSseConnected() ? 'Live updates: Connected' : 'Live updates: Disconnected',
            enabled: false
          },
          { label: userDisplayName, enabled: false }
        ] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    {
      label: pendingCount > 0 ? `Pending Approvals (${pendingCount})` : 'No Pending Approvals',
      enabled: pendingCount > 0,
      click: pendingCount > 0 ? () => showPendingApprovalsDialog() : undefined
    },
    {
      label: 'Register MCP Servers',
      enabled: Boolean(
        getCredentialsForEnv()?.apiKey && (setupData.apiBaseUrl || setupData.serverAddress)
      ),
      click: async () => {
        let isAdminOrOwner = false
        const apiBaseUrl = getApiBaseUrl()
        const envCreds = getCredentialsForEnv()
        if (apiBaseUrl && envCreds?.apiKey) {
          const role = await fetchUserRole(apiBaseUrl, envCreds.apiKey)
          isAdminOrOwner = role === 'admin' || role === 'owner'
        }
        showServerRegistrationDialog(mainWindow ?? undefined, isAdminOrOwner)
      }
    },
    // Open Dashboard dropped on Linux.
    ...(compactTray
      ? []
      : [
          {
            label: 'Open Dashboard',
            enabled: Boolean(getApiBaseUrl()),
            click: () => {
              const dashboardUrl = getApiBaseUrl()
              if (dashboardUrl) shell.openExternal(dashboardUrl)
            }
          }
        ]),
    // "Copy MCP config / URL" omitted on Linux (available in the main window).
    ...(compactTray
      ? []
      : [
          { type: 'separator' as const },
          {
            label: 'Copy EdisonWatch MCP config',
            enabled: Boolean(getMcpUrl()),
            click: () => {
              const mcpConfig = getMcpConfig()
              if (mcpConfig) {
                clipboard.writeText(mcpConfig)
                if (Notification.isSupported()) {
                  const n = new Notification({
                    title: 'Edison Watch',
                    body: 'MCP config copied - paste into VSCode, Cursor, or your MCP client',
                    ...(process.platform !== 'darwin' && { icon: trayIconPath })
                  })
                  n.show()
                }
              }
            }
          },
          {
            label: 'Copy MCP URL',
            enabled: Boolean(getMcpUrl()),
            click: () => {
              const url = getMcpUrl()
              if (url) {
                clipboard.writeText(url)
                if (Notification.isSupported()) {
                  const n = new Notification({
                    title: 'Edison Watch',
                    body: 'MCP URL copied to clipboard',
                    ...(process.platform !== 'darwin' && { icon: trayIconPath })
                  })
                  n.show()
                }
              }
            }
          }
        ]),
    { type: 'separator' },
    ...buildStdiodMenuItems(
      trayIconPath,
      () => {
        void handleStdiodReset({
          getMainWindow: () => mainWindow,
          updateTrayMenu,
          trayIconPath
        })
      },
      compactTray
    ),
    { type: 'separator' },
    // Hooks + MCP Auto-Quarantine status lines dropped on Linux.
    ...(compactTray
      ? []
      : [
          { label: getHookStatusLabel(), enabled: false },
          {
            label: getAutoQuarantineEnabled()
              ? 'MCP Auto-Quarantine: Enabled'
              : 'MCP Auto-Quarantine: Disabled',
            enabled: false
          }
        ])
  ]

  const pendingVersion = getPendingUpdateVersion()
  if (isUpdateDownloaded() && pendingVersion) {
    items.push({
      label: `Restart to update (v${pendingVersion})`,
      click: () => quitAndInstall()
    })
  } else if (pendingVersion) {
    // Available but not downloaded yet (demo default: download on demand).
    items.push({
      label: `Download update (v${pendingVersion})`,
      click: () => {
        downloadUpdate().catch((err) => console.error('[update] download failed:', err))
        updateTrayMenu()
      }
    })
  } else {
    items.push({
      label: 'Check for Updates',
      click: async () => {
        const state = await checkForUpdates()
        if (Notification.isSupported()) {
          if (state.version && state.status !== 'idle' && state.status !== 'error') {
            new Notification({
              title: 'Edison Watch',
              body: `Version ${state.version} is available.`,
              ...(process.platform !== 'darwin' && { icon: trayIconPath })
            }).show()
          } else if (state.status === 'error') {
            new Notification({
              title: 'Edison Watch',
              body: 'Update check failed. Please check your connection.',
              ...(process.platform !== 'darwin' && { icon: trayIconPath })
            }).show()
          } else {
            new Notification({
              title: 'Edison Watch',
              body: "You're already on the latest version.",
              ...(process.platform !== 'darwin' && { icon: trayIconPath })
            }).show()
          }
        }
        updateTrayMenu()
      }
    })
  }

  items.push(
    { type: 'separator' },
    {
      label: 'Debug Window',
      click: () => showDebugWindow(mainWindow ?? undefined)
    },
    { type: 'separator' },
    {
      label: 'Re-run Setup Wizard',
      click: () => rerunWizard()
    },
    {
      label: 'Clear App Data & Restart',
      click: () => handleClearDataAndRestart()
    },
    {
      label: 'Update Keys',
      click: () =>
        showUpdateKeysWindow(
          getSetupData,
          (key) => markSetupComplete({ edisonSecretKey: key }),
          async (compositeKey) => {
            const setup = getSetupData()
            const mcpBaseUrl = getMcpBaseUrl()
            const creds = getCredentialsForEnv()
            const serverAddress = setup.serverAddress ?? ''
            if (!mcpBaseUrl || !creds?.apiKey) return
            await applyAppIntegrations({
              serverAddress,
              mcpBaseUrl,
              apiKey: creds.apiKey,
              edisonSecretKey: compositeKey,
              apps: setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
            })
          }
        )
    },
    // Send Feedback + Sign Out omitted on Linux (both available in-app).
    ...(compactTray
      ? []
      : [
          {
            label: 'Send Feedback',
            click: () => showFeedbackWindow()
          },
          {
            label: 'Sign Out',
            click: () => handleLogoutAndRestart()
          }
        ]),
    {
      label: 'Quit',
      click: () => app.quit()
    }
  )

  // Linux: the menu is now short enough that the divider lines just add noise -
  // strip every separator for a clean flat list. (Also collapses any adjacent
  // separators left by the per-platform omissions above.)
  return compactTray ? items.filter((item) => item.type !== 'separator') : items
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate(buildTrayMenuItems())
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
    // the popUpContextMenu approach below never fires - the icon looks dead.
    // Bind the menu directly; clicking the indicator opens it. Kept current by
    // updateTrayMenu(). (No left-click-opens-window affordance on Linux; the
    // menu carries a "Show"/open item instead.)
    tray.setContextMenu(buildTrayMenu())
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
  // Linux binds the menu directly (no click event to rebuild it on demand), so
  // re-attach it whenever status changes so the indicator stays current.
  if (tray && process.platform === 'linux') {
    tray.setContextMenu(buildTrayMenu())
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

  mainWindow.on('ready-to-show', () => {
    slog('ready-to-show, showing window')
    mainWindow?.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    slog('did-finish-load')
    logEnvConfig('startup')
    // `ready-to-show` is unreliable on Linux - it sometimes never fires, which
    // leaves this `show: false` window hidden forever (no window, app only in
    // the tray, which GNOME may not surface either). did-finish-load is a robust
    // fallback: show() is idempotent, so where ready-to-show already fired this
    // is a no-op (and the earlier event still avoids the pre-paint white flash).
    mainWindow?.show()
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

  if (isSetupComplete()) {
    slog('setup complete, creating tray')
    createTray()
    startEventSubscription()
    startHookHealthMonitor()
    // Await hook injection before quarantine monitor to avoid config file races
    await injectAllHooks().catch((err) => console.error('[HookInjection] Failed:', err))

    await warmOrgIdCacheOnStartup()
    startQuarantineMonitorIfEnabled().catch((err) => console.error('[Quarantine] Failed:', err))
    startQuarantinePolling()

    // Self-heal: re-register edison-watch for any apps where the config was cleared externally
    const setup = getSetupData()
    const mcpBaseUrl = getMcpBaseUrl()
    const creds = getCredentialsForEnv()
    if (mcpBaseUrl && creds?.apiKey) {
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
