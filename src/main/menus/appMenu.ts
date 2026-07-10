// Native application menu (the OS menu bar on macOS, the window menu
// elsewhere). Extracted from index.ts so the main entry stays under the
// project's file-size CI cap.

import { app, BrowserWindow, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { applyAppIntegrations } from '../runtime/mcpConfigWriter'
import {
  ALL_SUPPORTED_APPS,
  DEBUG_ENV_NAMES,
  getBuildDefaultEnv,
  getCredentialsForEnv,
  getDebugEnvOverride,
  getMcpBaseUrl,
  getSetupData,
  setDebugEnvOverride,
  startServerStatusChecks
} from '../infra/setupConfig'

export interface AppMenuDeps {
  getMainWindow: () => BrowserWindow | null
  updateAppMenu: () => void
  updateTrayMenu: () => void
  logEnvConfig: (context: string) => void
  slog: (msg: string) => void
  handleClearDataAndRestart: () => void
  buildTrayMenuItems: () => MenuItemConstructorOptions[]
}

export function buildAppMenu(deps: AppMenuDeps): Menu {
  // Hide the Developer menu (which includes the env switcher) on release builds.
  const showDeveloperMenu = getBuildDefaultEnv() !== 'release'
  const currentEnv = getDebugEnvOverride() ?? getBuildDefaultEnv()
  const envSubmenu: MenuItemConstructorOptions[] = DEBUG_ENV_NAMES.map((name) => ({
    label:
      name === 'dev'
        ? 'dev (localhost)'
        : name === 'temp-local-stack'
          ? 'temp-local-stack (railway offline)'
          : name,
    type: 'radio' as const,
    checked: currentEnv === name,
    click: async () => {
      setDebugEnvOverride(name)
      deps.logEnvConfig(`switch→${name}`)
      deps.updateAppMenu()
      deps.getMainWindow()?.webContents.send('env:changed', name)

      // Re-apply MCP integrations so client configs point to the new env's URL.
      const setup = getSetupData()
      const mcpBaseUrl = getMcpBaseUrl()
      const creds = getCredentialsForEnv(name)
      if (mcpBaseUrl && creds?.apiKey) {
        try {
          await applyAppIntegrations({
            serverAddress: setup.serverAddress ?? '',
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: creds.edisonSecretKey,
            apps: setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
          })
          deps.slog(`[env:switch] MCP integrations updated for ${name}`)
        } catch (err) {
          deps.slog(`[env:switch] Failed to update MCP integrations: ${err}`)
        }
      } else if (mcpBaseUrl && !creds?.apiKey) {
        deps.slog(`[env:switch] No API key stored for env "${name}" - MCP integrations not updated`)
      }

      // Re-check server liveness against the new env URL.
      startServerStatusChecks(deps.updateTrayMenu)
    }
  }))

  const devSubmenu: MenuItemConstructorOptions[] = [
    { label: 'Switch Environment', submenu: envSubmenu },
    { type: 'separator' },
    { label: 'Clear App Data & Restart', click: () => deps.handleClearDataAndRestart() }
  ]
  const developerItem: MenuItemConstructorOptions = { label: 'Developer', submenu: devSubmenu }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              ...(showDeveloperMenu
                ? ([developerItem, { type: 'separator' }] as MenuItemConstructorOptions[])
                : []),
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    { label: 'Actions', submenu: deps.buildTrayMenuItems() },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(process.platform !== 'darwin' && showDeveloperMenu
          ? ([{ type: 'separator' }, developerItem] as MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ] as MenuItemConstructorOptions[]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[]))
      ] as MenuItemConstructorOptions[]
    }
  ]

  return Menu.buildFromTemplate(template)
}
