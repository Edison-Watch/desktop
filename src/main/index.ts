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
  clipboard,
  dialog
} from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { appendFileSync, unlinkSync } from 'fs'
import { installMonitorTee } from './runtime/monitorLog'

installMonitorTee()

const LOG_FILE = '/tmp/ew-startup.log'
function slog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {}
  console.log(msg)
}
import { startDevAuthServer, getDevAuthCallbackUrl } from './runtime/devAuthServer'
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
  startUpdateChecker,
  stopUpdateChecker,
  getAvailableUpdate,
  openUpdateDownload,
  checkForUpdateNow
} from './infra/updateChecker'
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
import { refreshStdiodStatusCache, startStdiodStatusCacheRefresh } from './stdiod/trayCache'
import { buildStdiodMenuItems } from './stdiod/trayMenu'

// eslint-disable-next-line @typescript-eslint/no-require-imports
import appIconPath from '../../resources/icon.png?asset'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from '../../resources/icon_tray.png?asset'

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

  const items: MenuItemConstructorOptions[] = [
    { label: 'Enabled', type: 'checkbox', checked: true, click: () => {} },
    { label: getIsServerOnline() ? 'Backend: Connected' : 'Backend: Disconnected', enabled: false },
    {
      label: isSseConnected() ? 'Live updates: Connected' : 'Live updates: Disconnected',
      enabled: false
    },
    { label: userDisplayName, enabled: false },
    { type: 'separator' },
    {
      label: pendingCount > 0 ? `Pending Approvals (${pendingCount})` : 'No Pending Approvals',
      enabled: pendingCount > 0,
      click: pendingCount > 0 ? () => showPendingApprovalsDialog(mainWindow) : undefined
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
    {
      label: 'Open Dashboard',
      enabled: Boolean(getApiBaseUrl()),
      click: () => {
        const dashboardUrl = getApiBaseUrl()
        if (dashboardUrl) shell.openExternal(dashboardUrl)
      }
    },
    { type: 'separator' },
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
    },
    { type: 'separator' },
    ...buildStdiodMenuItems(trayIconPath),
    { type: 'separator' },
    { label: getHookStatusLabel(), enabled: false },
    {
      label: getAutoQuarantineEnabled()
        ? 'MCP Auto-Quarantine: Enabled'
        : 'MCP Auto-Quarantine: Disabled',
      enabled: false
    }
  ]

  const availableUpdate = getAvailableUpdate()
  if (availableUpdate) {
    items.push({
      label: `Update available: v${availableUpdate.version}`,
      click: () => openUpdateDownload()
    })
  } else {
    items.push({
      label: 'Check for Updates',
      click: async () => {
        try {
          const update = await checkForUpdateNow(trayIconPath)
          if (Notification.isSupported()) {
            if (update) {
              const notification = new Notification({
                title: 'Edison Watch',
                body: `Version ${update.version} is available. Click to download.`,
                ...(process.platform !== 'darwin' && { icon: trayIconPath })
              })
              notification.on('click', () => openUpdateDownload())
              notification.show()
            } else {
              new Notification({
                title: 'Edison Watch',
                body: "You're already on the latest version.",
                ...(process.platform !== 'darwin' && { icon: trayIconPath })
              }).show()
            }
          }
        } catch {
          if (Notification.isSupported()) {
            new Notification({
              title: 'Edison Watch',
              body: 'Update check failed. Please check your connection.',
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
    {
      label: 'Send Feedback',
      click: () => showFeedbackWindow()
    },
    {
      label: 'Sign Out',
      click: () => handleLogoutAndRestart()
    },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  )

  return items
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate(buildTrayMenuItems())
}

function createTray(): void {
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

  tray.on('click', showMenu)
  tray.on('right-click', showMenu)

  startServerStatusChecks(updateTrayMenu)
  startStdiodStatusCacheRefresh(10_000, updateTrayMenu)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (process.platform === 'darwin' && (app as any).dock?.setMenu) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(app as any).dock.setMenu(buildTrayMenu())
  }
}

function updateTrayMenu(): void {
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
  stopUpdateChecker()
  stopEventSubscription()
  stopHookHealthMonitor()
  stopQuarantineMonitor()
  stopQuarantinePolling()
  pendingApprovals.clear()
}

async function handleLogoutAndRestart(): Promise<void> {
  console.log('[Logout] Signing out...')
  stopAllServices()
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
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
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
      mainWindow?.webContents.send('auth:callback', navigationUrl)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Deep link protocol ──────────────────────────────────────────────

app.on('open-url', (_event, url) => {
  if (url.startsWith('edison-watch://')) {
    mainWindow?.webContents.send('auth:callback', url)
  }
})

app.on('second-instance', (_event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  const url = commandLine.find((arg) => arg.startsWith('edison-watch://'))
  if (url && mainWindow) {
    mainWindow.webContents.send('auth:callback', url)
  }
})

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('edison-watch', process.execPath, [process.argv[1]!])
  }
} else {
  app.setAsDefaultProtocolClient('edison-watch')
}

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
  slog('app.whenReady fired')
  electronApp.setAppUserModelId('com.edisonwatch.desktop')
  updateAppMenu()

  if (is.dev) {
    try {
      await Promise.race([
        startDevAuthServer(() => mainWindow),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('DevAuthServer listen timeout')), 5_000)
        )
      ])
    } catch (err) {
      console.error('[App] Failed to start dev auth server, falling back to protocol handler:', err)
    }
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  slog('calling registerIpcHandlers')
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getDevAuthCallbackUrl: () => getDevAuthCallbackUrl(),
    createTray,
    startEventSubscription,
    startQuarantineMonitorIfEnabled,
    startQuarantinePolling
  })
  slog('registerIpcHandlers ok')

  ipcMain.handle('app:clearDataAndRestart', () => handleClearDataAndRestart())

  if (isSetupComplete()) {
    slog('setup complete, creating tray')
    createTray()
    startEventSubscription()
    startHookHealthMonitor()
    // Await hook injection before quarantine monitor to avoid config file races
    await injectAllHooks().catch((err) => console.error('[HookInjection] Failed:', err))
    startUpdateChecker()

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
