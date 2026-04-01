/**
 * IPC handler registration for the main process.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 * Call registerIpcHandlers() once after app.whenReady().
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { promises as fs } from "fs";
import { dirname, join } from "path";

import {
  getJetBrainsMcpConfigPaths,
  macAppExists,
  getVscodeUserMcpPath,
  getCursorConfigPath,
  getClaudeCodeUserSettingsPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getClaudeDesktopConfigPath,
  getClaudeCoworkConfigPath,
} from "./mcpDiscovery";
import { injectAllHooks, removeAllHooks, getHookStatus, injectVsCodeWorkspaceHook, removeVsCodeWorkspaceHook } from "./hookInjection";
import { startHookHealthMonitor } from "./hookHealthMonitor";
import { startUpdateChecker as _startUpdateChecker } from "./updateChecker";
import { showFeedbackWindow } from "./feedbackWindow";
import { restoreAllQuarantinedServers } from "./mcpConfigActions";
import { runDebugQuarantine, handleQuarantineDisabled } from "./quarantineManager";
import { applyAppIntegrations } from "./mcpConfigWriter";
import { registerMcpSubmitHandlers } from "./ipcHandlersMcpSubmit";
import {
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
  getCredentialsForEnv,
} from "./setupConfig";
import { handleApproval, pendingApprovals } from "./approvalsHandler";

export interface IpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null;
  getDevAuthCallbackUrl: () => string | null;
  createTray: () => void;
  startEventSubscription: () => void;
  startQuarantineMonitorIfEnabled: () => Promise<void>;
  startQuarantinePolling: () => void;
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const { getMainWindow, getDevAuthCallbackUrl, createTray, startEventSubscription, startQuarantineMonitorIfEnabled, startQuarantinePolling } = deps;

  // Auth: open SAML/SSO URL in a separate BrowserWindow
  ipcMain.on("auth:open-saml", (_event, samlUrl: string) => {
    const mainWindow = getMainWindow();
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      modal: true,
      parent: mainWindow || undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWindow.loadURL(samlUrl);

    authWindow.webContents.on("did-finish-load", () => {
      const currentUrl = authWindow.webContents.getURL();
      if (currentUrl.includes("access_token=") || currentUrl.includes("code=")) {
        getMainWindow()?.webContents.send("auth:callback", currentUrl);
        authWindow.close();
      }
    });

    authWindow.webContents.on("will-navigate", (_event, url) => {
      if (url.startsWith("edison-watch://")) {
        getMainWindow()?.webContents.send("auth:callback", url);
        authWindow.close();
      }
    });

    authWindow.webContents.on("will-redirect", (_event, url) => {
      if (url.startsWith("edison-watch://")) {
        getMainWindow()?.webContents.send("auth:callback", url);
        authWindow.close();
      }
    });
  });

  // Auth: expose dev localhost callback URL (null in production)
  ipcMain.handle("auth:getDevCallbackUrl", () => getDevAuthCallbackUrl());

  // Config: active env name (for renderer to sync its localStorage/Supabase creds)
  ipcMain.handle("config:getActiveEnv", () => getActiveEnv());

  // Config: effective base URLs (respects debug env override)
  ipcMain.handle("config:getEffectiveBaseUrls", () => {
    const apiBaseUrl = getApiBaseUrl();
    const mcpBaseUrl = getMcpBaseUrl();
    if (!apiBaseUrl) console.warn("[config:getEffectiveBaseUrls] apiBaseUrl is null — renderer will have no API URL.");
    if (!mcpBaseUrl) console.warn("[config:getEffectiveBaseUrls] mcpBaseUrl is null — server health checks will fail.");
    return {
      mcpBaseUrl,
      apiBaseUrl,
      docsBaseUrl: ENV_DOCS_URL,
    };
  });

  // Setup: get persisted setup data
  ipcMain.handle("setup:getData", () => {
    return getSetupData();
  });

  // Setup lifecycle
  ipcMain.on("setup:reached-final", () => {
    createTray();
  });

  ipcMain.on("setup:complete", (_event, data: Partial<SetupData>) => {
    markSetupComplete(data);
    console.log("[setup:complete] Setup data saved");

    // Start background services
    startEventSubscription();
    startHookHealthMonitor();
    injectAllHooks().catch((err) =>
      console.error("[HookInjection] Failed to inject hooks:", err),
    );
    _startUpdateChecker();
    startQuarantineMonitorIfEnabled().catch((err) =>
      console.error("[Quarantine] Failed to start monitor after setup:", err),
    );
    startQuarantinePolling();

    const win = getMainWindow();
    if (win) {
      win.hide();
      // Re-show after a tick so the renderer can transition to MainMenu
      setTimeout(() => { if (!win.isDestroyed()) win.show(); }, 500);
    }
  });

  ipcMain.handle("setup:reset", () => {
    markSetupIncomplete();
    return { ok: true };
  });

  // Multi-account management
  ipcMain.handle("accounts:list", () => {
    return getSavedAccounts().map(({ userId, userEmail, savedAt }) => ({
      userId,
      userEmail,
      savedAt,
    }));
  });

  ipcMain.handle("accounts:switch", async (_event, userId: string) => {
    const current = getSetupData();
    if (current.userId === userId) return { ok: true };
    const data = switchToAccount(userId);
    if (!data) return { ok: false };
    // Clear stale approvals from the previous account
    pendingApprovals.clear();
    // Restart background services for the new account
    startEventSubscription();
    startHookHealthMonitor();
    _startUpdateChecker();
    startQuarantineMonitorIfEnabled().catch((err) =>
      console.error("[Quarantine] Failed to start monitor on account switch:", err),
    );
    startQuarantinePolling();

    // Re-apply MCP integrations so client configs point to the new account's URL.
    // Without this, configs would keep the previous account's server/API key.
    const newSetup = getSetupData();
    const mcpBaseUrl = getMcpBaseUrl();
    const creds = getCredentialsForEnv();
    if (mcpBaseUrl && creds?.apiKey) {
      try {
        await applyAppIntegrations({
          serverAddress: newSetup.serverAddress ?? "",
          mcpBaseUrl,
          apiKey: creds.apiKey,
          edisonSecretKey: creds.edisonSecretKey,
          apps: (newSetup.configuredApps?.length ? newSetup.configuredApps : ALL_SUPPORTED_APPS).filter(app => ALL_SUPPORTED_APPS.includes(app)),
        });
        console.log("[accounts:switch] MCP integrations updated for new account");
      } catch (err) {
        console.error("[accounts:switch] Failed to update MCP integrations:", err);
      }
    }

    return { ok: true };
  });

  ipcMain.handle("accounts:remove", (_event, userId: string) => {
    try {
      removeAccount(userId);
    } catch {
      // best-effort; non-critical feature
    }
    return { ok: true };
  });

  // Approval IPC from approval window
  ipcMain.handle("approval:approve", async (_event, approvalId: string) => {
    await handleApproval(approvalId, "approve");
  });

  ipcMain.handle("approval:deny", async (_event, approvalId: string) => {
    await handleApproval(approvalId, "deny");
  });

  // Server health check
  ipcMain.handle("menu:check-health", async () => {
    return getIsServerOnline();
  });

  // Shell operations
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    await shell.openExternal(url);
  });

  // Open feedback window from renderer
  ipcMain.handle("menu:openFeedback", () => {
    showFeedbackWindow();
  });

  // Resize the main window (used by post-setup menu to shrink to content size)
  ipcMain.handle("menu:resizeWindow", (_event, width: number, height: number) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMinimumSize(Math.min(width, 480), Math.min(height, 300));
      mainWindow.setSize(width, height, true);
      mainWindow.center();
    }
  });

  // Get app version
  ipcMain.handle("menu:getVersion", () => {
    return app.getVersion();
  });

  // Get MCP config as VSCode JSON
  ipcMain.handle("menu:getMcpConfig", () => {
    return getMcpConfig();
  });

  // Get raw MCP URL
  ipcMain.handle("menu:getMcpUrl", () => {
    return getMcpUrl();
  });

  // MCP: Discover installed clients
  ipcMain.handle("mcp:detectClients", async () => {
    const clients: Array<{ id: string; name: string; configPath: string }> = [];

    const checks: Array<{
      id: string;
      name: string;
      getPath: () => Promise<string>;
      // Override detection dir (defaults to dirname of configPath).
      detectDir?: (configPath: string) => string;
    }> = [
      {
        id: "vscode",
        name: "VS Code",
        getPath: () => Promise.resolve(getVscodeUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)), // ~/Library/Application Support/Code/
      },
      { id: "cursor", name: "Cursor", getPath: () => Promise.resolve(getCursorConfigPath()) },
      { id: "claude-code", name: "Claude Code", getPath: () => Promise.resolve(getClaudeCodeUserSettingsPath()) },
      { id: "windsurf", name: "Windsurf", getPath: () => Promise.resolve(getWindsurfConfigPath()) },
      { id: "zed", name: "Zed", getPath: () => Promise.resolve(getZedConfigPath()) },
      { id: "claude-desktop", name: "Claude Desktop", getPath: () => Promise.resolve(getClaudeDesktopConfigPath()) },
      {
        id: "claude-cowork",
        name: "Claude Cowork",
        getPath: () => Promise.resolve(getClaudeCoworkConfigPath()),
        // Cowork is detected by the presence of vm_bundles/ (downloaded on first Cowork launch)
        detectDir: (configPath) => join(dirname(configPath), 'vm_bundles'),
      },
    ];

    for (const check of checks) {
      try {
        const configPath = await check.getPath();
        const checkDir = check.detectDir ? check.detectDir(configPath) : dirname(configPath);
        await fs.access(checkDir);
        if (!(await macAppExists(check.id))) continue;
        clients.push({ id: check.id, name: check.name, configPath });
      } catch {
        // Client not installed
      }
    }

    // JetBrains IDEs: scan for installed instances
    try {
      const jbPaths = await getJetBrainsMcpConfigPaths();
      const nameMap: Record<string, string> = { intellij: "IntelliJ IDEA", pycharm: "PyCharm", webstorm: "WebStorm" };
      for (const { client, path } of jbPaths) {
        if (!(await macAppExists(client))) continue;
        clients.push({ id: client, name: nameMap[client] ?? client, configPath: path });
      }
    } catch {
      // JetBrains not installed
    }

    return clients;
  });

  // MCP discovery, submission, removal, and config management handlers
  registerMcpSubmitHandlers();

  ipcMain.handle("mcp:injectHooks", async () => {
    return await injectAllHooks();
  });

  ipcMain.handle("mcp:removeHooks", async () => {
    return await removeAllHooks();
  });

  ipcMain.handle("mcp:getHookStatus", async () => {
    const claudeCodeMcpStatus = await checkClaudeCodeMcpConnection();
    return await getHookStatus(getMcpUrl(), getIsServerOnline(), claudeCodeMcpStatus);
  });

  ipcMain.handle("mcp:injectVsCodeWorkspaceHook", async (_event, workspacePath: string) => {
    return await injectVsCodeWorkspaceHook(workspacePath);
  });

  ipcMain.handle("mcp:removeVsCodeWorkspaceHook", async (_event, workspacePath: string) => {
    return await removeVsCodeWorkspaceHook(workspacePath);
  });

  // Keychain: store/load the user's personal encryption key via OS keychain (safeStorage)
  const keychainFile = join(app.getPath("userData"), ".personal-key.enc");

  ipcMain.handle("keychain:save", async (_event, plaintext: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: "OS encryption not available" };
    }
    const encrypted = safeStorage.encryptString(plaintext);
    await fs.writeFile(keychainFile, encrypted);
    return { ok: true };
  });

  ipcMain.handle("keychain:load", async () => {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await fs.readFile(keychainFile);
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  });

  ipcMain.handle("keychain:delete", async () => {
    try {
      await fs.unlink(keychainFile);
    } catch {
      // Not present — ignore
    }
    return { ok: true };
  });

  // Debug window actions
  ipcMain.handle("debug:runQuarantine", async () => {
    return runDebugQuarantine();
  });

  ipcMain.handle("debug:resetQuarantine", async () => {
    try {
      handleQuarantineDisabled(); // stop monitor + update tray before restoring, to prevent re-quarantine
      const result = await restoreAllQuarantinedServers();
      return { success: true, restored: result.restored, errors: result.errors };
    } catch (err) {
      return { success: false, restored: 0, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
