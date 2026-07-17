// Tray context menu items. Extracted from index.ts so the main entry stays
// under the project's file-size CI cap. Mirrors menus/appMenu.ts (deps object).

import { app, clipboard, Notification, shell } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'

import { showDebugWindow } from '../dialogs/debugWindow'
import { showFeedbackWindow } from '../dialogs/feedbackWindow'
import { showServerRegistrationDialog } from '../dialogs/mcpServerActionDialog'
import { showUpdateKeysWindow } from '../dialogs/updateKeysWindow'
import { fetchUserRole } from '../discovery/mcpServerSubmit'
import {
  checkForUpdates,
  downloadUpdate,
  getPendingUpdateVersion,
  isUpdateDownloaded,
  quitAndInstall
} from '../infra/updateManager'
import {
  ALL_SUPPORTED_APPS,
  getApiBaseUrl,
  getCredentialsForEnv,
  getIsServerOnline,
  getMcpBaseUrl,
  getMcpConfig,
  getMcpUrl,
  getSetupData,
  markSetupComplete
} from '../infra/setupConfig'
import { isSseConnected, pendingApprovals, showPendingApprovalsDialog } from '../ipc/approvalsHandler'
import { applyAppIntegrations } from '../runtime/mcpConfigWriter'
import { buildStdiodMenuItems } from '../stdiod/trayMenu'
import { handleStdiodReset } from '../stdiod/trayReset'

// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from '../../../resources/icon_tray.png?asset'

// Baked at build time by electron.vite.config.ts. true = compact Linux tray.
declare const __TRAY_COMPACT__: boolean

export interface TrayMenuDeps {
  getMainWindow: () => BrowserWindow | null
  showMainWindow: () => void
  updateTrayMenu: () => void
  rerunWizard: () => void
  handleClearDataAndRestart: () => void
  handleLogoutAndRestart: () => void
}

export function buildTrayMenuItems(deps: TrayMenuDeps): MenuItemConstructorOptions[] {
  const setupData = getSetupData()
  const pendingCount = pendingApprovals.size
  const userDisplayName = setupData.userEmail || 'Not signed in'
  // Linux compact build trims the menu (native GTK rows are tall + uncollapsible).
  const compactTray = process.platform === 'linux' && __TRAY_COMPACT__

  const items: MenuItemConstructorOptions[] = [
    { label: 'Open Edison Watch', click: () => deps.showMainWindow() },
    // Linux compact: drop the "Enabled"/status block (shown in the main window).
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
        showServerRegistrationDialog(deps.getMainWindow() ?? undefined, isAdminOrOwner)
      }
    },
    // Linux compact: drop Open Dashboard + Copy MCP config/URL (in the main window).
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
                  new Notification({
                    title: 'Edison Watch',
                    body: 'MCP config copied - paste into VSCode, Cursor, or your MCP client',
                    ...(process.platform !== 'darwin' && { icon: trayIconPath })
                  }).show()
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
                  new Notification({
                    title: 'Edison Watch',
                    body: 'MCP URL copied to clipboard',
                    ...(process.platform !== 'darwin' && { icon: trayIconPath })
                  }).show()
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
          getMainWindow: deps.getMainWindow,
          updateTrayMenu: deps.updateTrayMenu,
          trayIconPath
        })
      },
      compactTray
    ),
    { type: 'separator' }
  ]

  const pendingVersion = getPendingUpdateVersion()
  if (isUpdateDownloaded() && pendingVersion) {
    items.push({ label: `Restart to update (v${pendingVersion})`, click: () => quitAndInstall() })
  } else if (pendingVersion) {
    items.push({
      label: `Download update (v${pendingVersion})`,
      click: () => {
        downloadUpdate().catch((err) => console.error('[update] download failed:', err))
        deps.updateTrayMenu()
      }
    })
  } else {
    items.push({
      label: 'Check for Updates',
      click: async () => {
        const state = await checkForUpdates()
        if (Notification.isSupported()) {
          const body =
            state.version && state.status !== 'idle' && state.status !== 'error'
              ? `Version ${state.version} is available.`
              : state.status === 'error'
                ? 'Update check failed. Please check your connection.'
                : "You're already on the latest version."
          new Notification({
            title: 'Edison Watch',
            body,
            ...(process.platform !== 'darwin' && { icon: trayIconPath })
          }).show()
        }
        deps.updateTrayMenu()
      }
    })
  }

  items.push(
    { type: 'separator' },
    { label: 'Debug Window', click: () => showDebugWindow(deps.getMainWindow() ?? undefined) },
    { type: 'separator' },
    { label: 'Re-run Setup Wizard', click: () => deps.rerunWizard() },
    { label: 'Clear App Data & Restart', click: () => deps.handleClearDataAndRestart() },
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
    // Linux compact: drop Send Feedback + Sign Out (both available in-app).
    ...(compactTray
      ? []
      : [
          { label: 'Send Feedback', click: () => showFeedbackWindow() },
          { label: 'Sign Out', click: () => deps.handleLogoutAndRestart() }
        ]),
    { label: 'Quit', click: () => app.quit() }
  )

  // Linux compact: strip every separator for a clean flat list (also collapses
  // any adjacent separators left by the omissions above).
  return compactTray ? items.filter((item) => item.type !== 'separator') : items
}
