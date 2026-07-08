/**
 * IPC handler registration for the main process.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 * Call registerIpcHandlers() once after app.whenReady().
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

import {
  getJetBrainsMcpConfigPaths,
  macAppExists,
  getVscodeUserMcpPath,
  getCursorConfigPath,
  getClaudeCodeUserSettingsPath,
  getClaudeDesktopConfigPath,
  getClaudeCoworkConfigPath,
  getWindsurfConfigPath,
  getZedConfigPath
} from '../discovery/mcpDiscovery'
import {
  injectAllHooks,
  removeAllHooks,
  getHookStatus,
  injectVsCodeWorkspaceHook,
  removeVsCodeWorkspaceHook,
  getCodexConfigPath
} from '../runtime/hookInjection'
import { bootstrapDetectord, setDetectordSecret } from '../detectord/bootstrap'
import { uninstallService as uninstallDetectord } from '../detectord/controller'
import { detectordPrimary } from '../detectord/mode'
import { startHookHealthMonitor } from '../runtime/hookHealthMonitor'
import {
  getUpdateState,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getSettings as getUpdateSettings,
  updateSettings as setUpdateSettings
} from '../infra/updateManager'
import { showFeedbackWindow } from '../dialogs/feedbackWindow'
import { restoreAllQuarantinedServers } from '../runtime/mcpConfigActions'
import { runDebugQuarantine, handleQuarantineDisabled } from '../quarantine/quarantineManager'
import { applyAppIntegrations } from '../runtime/mcpConfigWriter'
import { registerMcpSubmitHandlers } from './ipcHandlersMcpSubmit'
import { registerStdiodHandlers } from './ipcHandlersStdiod'
import {
  DRY_RUN,
  ENV_DOCS_URL,
  ALL_SUPPORTED_APPS,
  type SetupData,
  getActiveEnv,
  getApiBaseUrl,
  getMcpBaseUrl,
  getMcpConfig,
  getMcpUrl,
  getSetupData,
  getIsServerOnline,
  checkClaudeCodeMcpConnection,
  markSetupComplete,
  markSetupIncomplete,
  getSavedAccounts,
  switchToAccount,
  removeAccount,
  getCredentialsForEnv
} from '../infra/setupConfig'
import { handleApproval, pendingApprovals, resizeApprovalWindow } from './approvalsHandler'

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  getAuthLoopbackUrl: () => string | null
  createTray: () => void
  startEventSubscription: () => void
  startQuarantineMonitorIfEnabled: () => Promise<void>
  startQuarantinePolling: () => void
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const {
    getMainWindow,
    getAuthLoopbackUrl,
    createTray,
    startEventSubscription,
    startQuarantineMonitorIfEnabled,
    startQuarantinePolling
  } = deps

  // Auth: open SAML/SSO URL in a separate BrowserWindow
  ipcMain.on('auth:open-saml', (_event, samlUrl: string) => {
    const mainWindow = getMainWindow()
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      modal: true,
      parent: mainWindow || undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    authWindow.loadURL(samlUrl)

    authWindow.webContents.on('did-finish-load', () => {
      const currentUrl = authWindow.webContents.getURL()
      if (currentUrl.includes('access_token=') || currentUrl.includes('code=')) {
        getMainWindow()?.webContents.send('auth:callback', currentUrl)
        authWindow.close()
      }
    })

    authWindow.webContents.on('will-navigate', (_event, url) => {
      if (url.startsWith('edison-watch://')) {
        getMainWindow()?.webContents.send('auth:callback', url)
        authWindow.close()
      }
    })

    authWindow.webContents.on('will-redirect', (_event, url) => {
      if (url.startsWith('edison-watch://')) {
        getMainWindow()?.webContents.send('auth:callback', url)
        authWindow.close()
      }
    })
  })

  // Auth: expose dev localhost callback URL (null in production)
  ipcMain.handle('auth:getLoopbackUrl', () => getAuthLoopbackUrl())

  // Config: active env name (for renderer to sync its localStorage/Supabase creds)
  ipcMain.handle('config:getActiveEnv', () => getActiveEnv())

  // Config: effective base URLs (respects debug env override)
  ipcMain.handle('config:getEffectiveBaseUrls', () => {
    const apiBaseUrl = getApiBaseUrl()
    const mcpBaseUrl = getMcpBaseUrl()
    if (!apiBaseUrl)
      console.warn(
        '[config:getEffectiveBaseUrls] apiBaseUrl is null - renderer will have no API URL.'
      )
    if (!mcpBaseUrl)
      console.warn(
        '[config:getEffectiveBaseUrls] mcpBaseUrl is null - server health checks will fail.'
      )
    return {
      mcpBaseUrl,
      apiBaseUrl,
      docsBaseUrl: ENV_DOCS_URL
    }
  })

  // Setup: get persisted setup data
  ipcMain.handle('setup:getData', () => {
    return getSetupData()
  })

  // Setup lifecycle
  ipcMain.on('setup:reached-final', () => {
    createTray()
  })

  ipcMain.on('setup:complete', (_event, data: Partial<SetupData>) => {
    markSetupComplete(data)
    console.log('[setup:complete] Setup data saved')

    // Start background services
    startEventSubscription()
    // The TS install/hooks/quarantine pipeline stands down when the daemon is
    // primary (it owns those). See detectord/mode.ts.
    if (!detectordPrimary()) {
      startHookHealthMonitor()
      injectAllHooks().catch((err) => console.error('[HookInjection] Failed to inject hooks:', err))
      startQuarantineMonitorIfEnabled().catch((err) =>
        console.error('[Quarantine] Failed to start monitor after setup:', err)
      )
      startQuarantinePolling()
    }
    // Install + enroll the detector daemon and mirror its work into the client logs.
    bootstrapDetectord().catch((err) => console.error('[detectord] bootstrap failed:', err))

    const win = getMainWindow()
    if (win) {
      win.hide()
      // Re-show after a tick so the renderer can transition to MainMenu
      setTimeout(() => {
        if (!win.isDestroyed()) win.show()
      }, 500)
    }
  })

  ipcMain.handle('setup:reset', () => {
    markSetupIncomplete()
    return { ok: true }
  })

  // Persist-only setup update. Unlike 'setup:complete' (the onboarding finish
  // event), this does NOT restart background services, inject hooks, or
  // hide/re-show the window. Used post-onboarding (e.g. saving an org key from
  // the Config tab) where those lifecycle side effects would be wrong.
  ipcMain.handle('setup:update', (_event, data: Partial<SetupData>) => {
    markSetupComplete(data)
    return { ok: true }
  })

  // Renderer pushes credentials right after sign-in so the daemon can enroll on
  // login. A returning login keeps its API key only in the renderer's auth
  // state (never persisted to the setup file), so app-ready's bootstrap can't
  // read it — mirror stdiod.login and let the renderer hand them over.
  ipcMain.handle(
    'detectord:enroll',
    async (
      _event,
      input: { apiUrl?: string; mcpUrl?: string; apiKey?: string; edisonSecretKey?: string }
    ) => {
      await bootstrapDetectord(input).catch((err) =>
        console.error('[detectord] enroll (push) failed:', err)
      )
      return { ok: true }
    }
  )

  // Register/adopt the org secret key when the user enters or changes it
  // (OrgKeyCard). Explicit "enroll key" state change — separate from login.
  ipcMain.handle('detectord:setSecret', async (_event, key: string) =>
    setDetectordSecret(key)
  )

  // Stop + remove the detector daemon. purge=true also deletes all its data
  // (enrollment, seen-store, quarantine records, logs, socket).
  ipcMain.handle('detectord:uninstall', async (_event, opts?: { purge?: boolean }) => {
    const r = await uninstallDetectord(opts ?? {})
    return { ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }
  })

  // Verify a composite secret key against the ACTIVE-environment backend.
  // Runs in main so it always uses getCredentialsForEnv()/getApiBaseUrl() -
  // a renderer doing this could authenticate to the active env with a stale
  // top-level API key after an environment switch.
  ipcMain.handle(
    'secretKey:verify',
    async (
      _event,
      args: { key: string }
    ): Promise<{ ok: boolean; valid?: boolean; domainValid?: boolean | null }> => {
      const apiBaseUrl = getApiBaseUrl()
      const creds = getCredentialsForEnv()
      if (!apiBaseUrl || !creds?.apiKey) return { ok: false }
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/v1/user/secret-key/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
          body: JSON.stringify({ key: args.key })
        })
        if (!res.ok) return { ok: false }
        const data = (await res.json()) as { valid?: boolean; domain_valid?: boolean | null }
        return { ok: true, valid: data.valid, domainValid: data.domain_valid }
      } catch {
        return { ok: false }
      }
    }
  )

  // Re-apply MCP client integrations after a secret-key change (e.g. org key
  // added from the Config tab). Resolves URL/creds/apps in main so the renderer
  // doesn't assemble them. Mirrors the "Update Keys" tray flow: a missing or
  // empty configuredApps falls back to ALL_SUPPORTED_APPS, otherwise older
  // setups would rewrite no client configs and the new key wouldn't take effect.
  ipcMain.handle('mcp:applyForSecretKey', async (_event, args: { edisonSecretKey: string }) => {
    const mcpBaseUrl = getMcpBaseUrl()
    const creds = getCredentialsForEnv()
    if (!mcpBaseUrl || !creds?.apiKey) {
      return { success: false, modifiedConfigs: [] }
    }
    const setup = getSetupData()
    const apps = setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
    console.log('[mcp:applyForSecretKey]', apps, DRY_RUN ? '(dry-run)' : '')
    return await applyAppIntegrations({
      serverAddress: setup.serverAddress ?? '',
      mcpBaseUrl,
      apiKey: creds.apiKey,
      edisonSecretKey: args.edisonSecretKey,
      apps,
      dryRun: DRY_RUN
    })
  })

  // Multi-account management
  ipcMain.handle('accounts:list', () => {
    return getSavedAccounts().map(({ userId, userEmail, savedAt }) => ({
      userId,
      userEmail,
      savedAt
    }))
  })

  ipcMain.handle('accounts:switch', async (_event, userId: string) => {
    const current = getSetupData()
    if (current.userId === userId) return { ok: true }
    const data = switchToAccount(userId)
    if (!data) return { ok: false }
    // Clear stale approvals from the previous account
    pendingApprovals.clear()
    // Restart background services for the new account
    startEventSubscription()
    startHookHealthMonitor()
    startQuarantineMonitorIfEnabled().catch((err) =>
      console.error('[Quarantine] Failed to start monitor on account switch:', err)
    )
    startQuarantinePolling()

    // Re-apply MCP integrations so client configs point to the new account's URL.
    // Without this, configs would keep the previous account's server/API key.
    const newSetup = getSetupData()
    const mcpBaseUrl = getMcpBaseUrl()
    const creds = getCredentialsForEnv()
    if (mcpBaseUrl && creds?.apiKey) {
      try {
        await applyAppIntegrations({
          serverAddress: newSetup.serverAddress ?? '',
          mcpBaseUrl,
          apiKey: creds.apiKey,
          edisonSecretKey: creds.edisonSecretKey,
          apps: (newSetup.configuredApps?.length
            ? newSetup.configuredApps
            : ALL_SUPPORTED_APPS
          ).filter((app) => ALL_SUPPORTED_APPS.includes(app))
        })
        console.log('[accounts:switch] MCP integrations updated for new account')
      } catch (err) {
        console.error('[accounts:switch] Failed to update MCP integrations:', err)
      }
    }

    return { ok: true }
  })

  ipcMain.handle('accounts:remove', (_event, userId: string) => {
    try {
      removeAccount(userId)
    } catch {
      // best-effort; non-critical feature
    }
    return { ok: true }
  })

  // Approval IPC from approval window
  ipcMain.handle('approval:approve', async (_event, approvalId: string) => {
    await handleApproval(approvalId, 'approve')
  })

  ipcMain.handle('approval:deny', async (_event, approvalId: string) => {
    await handleApproval(approvalId, 'deny')
  })

  // Renderer reports its content height so the window can fit the approval list.
  ipcMain.on('approval:resize', (_event, contentHeight: number) => {
    resizeApprovalWindow(contentHeight)
  })

  // Server health check
  ipcMain.handle('menu:check-health', async () => {
    return getIsServerOnline()
  })

  // Shell operations
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Open feedback window from renderer
  ipcMain.handle('menu:openFeedback', () => {
    showFeedbackWindow()
  })

  // Resize the main window (used by post-setup menu to shrink to content size)
  ipcMain.handle('menu:resizeWindow', (_event, width: number, height: number) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMinimumSize(Math.min(width, 480), Math.min(height, 300))
      mainWindow.setSize(width, height, true)
      mainWindow.center()
    }
  })

  // Get app version
  ipcMain.handle('menu:getVersion', () => {
    return app.getVersion()
  })

  // Auto-update: state, manual check/download/install, and settings.
  ipcMain.handle('update:getState', () => getUpdateState())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => quitAndInstall())
  ipcMain.handle('update:getSettings', () => getUpdateSettings())
  ipcMain.handle(
    'update:setSettings',
    (_event, patch: { autoDownload?: boolean; autoInstallOnQuit?: boolean }) =>
      setUpdateSettings(patch)
  )

  // Get MCP config as VSCode JSON
  ipcMain.handle('menu:getMcpConfig', () => {
    return getMcpConfig()
  })

  // Get raw MCP URL
  ipcMain.handle('menu:getMcpUrl', () => {
    return getMcpUrl()
  })

  // MCP: Discover installed clients
  ipcMain.handle('mcp:detectClients', async () => {
    const clients: Array<{ id: string; name: string; configPath: string }> = []

    const checks: Array<{
      id: string
      name: string
      getPath: () => Promise<string>
      // Override detection dir (defaults to dirname of configPath).
      detectDir?: (configPath: string) => string
    }> = [
      {
        id: 'vscode',
        name: 'VS Code',
        getPath: () => Promise.resolve(getVscodeUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)) // ~/Library/Application Support/Code/
      },
      { id: 'cursor', name: 'Cursor', getPath: () => Promise.resolve(getCursorConfigPath()) },
      {
        id: 'claude-code',
        name: 'Claude Code',
        getPath: () => Promise.resolve(getClaudeCodeUserSettingsPath())
      },
      {
        id: 'claude-desktop',
        name: 'Claude Desktop',
        getPath: () => Promise.resolve(getClaudeDesktopConfigPath())
        // detectDir defaults to dirname(configPath) which is what we want:
        // ~/Library/Application Support/Claude/ exists iff Claude Desktop
        // has been launched at least once.
      },
      {
        id: 'claude-cowork',
        name: 'Claude Cowork',
        getPath: () => Promise.resolve(getClaudeCoworkConfigPath()),
        // Cowork shares the .app bundle and config file with Claude Desktop.
        // The discriminator is `vm_bundles/`, written on first Cowork launch.
        // Pointing detectDir at it makes fs.access fail (and Cowork drop
        // out of the list) when only Desktop has been used.
        detectDir: (configPath) => join(dirname(configPath), 'vm_bundles')
      },
      { id: 'windsurf', name: 'Windsurf', getPath: () => Promise.resolve(getWindsurfConfigPath()) },
      { id: 'zed', name: 'Zed', getPath: () => Promise.resolve(getZedConfigPath()) },
      {
        id: 'codex',
        name: 'Codex',
        getPath: () => Promise.resolve(getCodexConfigPath())
        // Codex is a CLI tool - detected by ~/.codex/ dir (macAppExists returns true for CLI-only clients)
      }
    ]

    for (const check of checks) {
      try {
        const configPath = await check.getPath()
        const checkDir = check.detectDir ? check.detectDir(configPath) : dirname(configPath)
        await fs.access(checkDir)
        if (!(await macAppExists(check.id))) continue
        clients.push({ id: check.id, name: check.name, configPath })
      } catch {
        // Client not installed
      }
    }

    // JetBrains IDEs: scan for installed instances
    try {
      const jbPaths = await getJetBrainsMcpConfigPaths()
      const nameMap: Record<string, string> = {
        intellij: 'IntelliJ IDEA',
        pycharm: 'PyCharm',
        webstorm: 'WebStorm'
      }
      for (const { client, path } of jbPaths) {
        if (!(await macAppExists(client))) continue
        clients.push({ id: client, name: nameMap[client] ?? client, configPath: path })
      }
    } catch {
      // JetBrains not installed
    }

    return clients
  })

  // MCP discovery, submission, removal, and config management handlers
  registerMcpSubmitHandlers()

  // edison-stdiod daemon control (install / login / uninstall / status).
  registerStdiodHandlers()

  ipcMain.handle('mcp:injectHooks', async () => {
    return await injectAllHooks()
  })

  ipcMain.handle('mcp:removeHooks', async () => {
    return await removeAllHooks()
  })

  ipcMain.handle('mcp:getHookStatus', async () => {
    const claudeCodeMcpStatus = await checkClaudeCodeMcpConnection()
    return await getHookStatus(getMcpUrl(), getIsServerOnline(), claudeCodeMcpStatus)
  })

  ipcMain.handle('mcp:injectVsCodeWorkspaceHook', async (_event, workspacePath: string) => {
    return await injectVsCodeWorkspaceHook(workspacePath)
  })

  ipcMain.handle('mcp:removeVsCodeWorkspaceHook', async (_event, workspacePath: string) => {
    return await removeVsCodeWorkspaceHook(workspacePath)
  })

  // Keychain: store/load the user's personal encryption key via OS keychain (safeStorage)
  const keychainFile = join(app.getPath('userData'), '.personal-key.enc')

  ipcMain.handle('keychain:save', async (_event, plaintext: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS encryption not available' }
    }
    const encrypted = safeStorage.encryptString(plaintext)
    await fs.writeFile(keychainFile, encrypted)
    return { ok: true }
  })

  ipcMain.handle('keychain:load', async () => {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = await fs.readFile(keychainFile)
      return safeStorage.decryptString(encrypted)
    } catch {
      return null
    }
  })

  ipcMain.handle('keychain:delete', async () => {
    try {
      await fs.unlink(keychainFile)
    } catch {
      // Not present - ignore
    }
    return { ok: true }
  })

  // Debug window actions
  ipcMain.handle('debug:runQuarantine', async () => {
    return runDebugQuarantine()
  })

  ipcMain.handle('debug:resetQuarantine', async () => {
    try {
      handleQuarantineDisabled() // stop monitor + update tray before restoring, to prevent re-quarantine
      const result = await restoreAllQuarantinedServers()
      return { success: true, restored: result.restored, errors: result.errors }
    } catch (err) {
      return {
        success: false,
        restored: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
