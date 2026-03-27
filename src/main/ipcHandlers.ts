/**
 * IPC handler registration for the main process.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 * Call registerIpcHandlers() once after app.whenReady().
 */

import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { promises as fs } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";

import {
  discoverMcpServers,
  getJetBrainsMcpConfigPaths,
  macAppExists,
  getVscodeUserMcpPath,
  getVscodeInsidersUserMcpPath,
  getCursorConfigPath,
  getClaudeCodeUserSettingsPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getClaudeDesktopConfigPath,
  getClaudeCoworkConfigPath,
  getAntigravityConfigPath,
} from "./mcpDiscovery";
import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "./mcpDiscovery";
import { injectAllHooks, removeAllHooks, getHookStatus, injectVsCodeWorkspaceHook, removeVsCodeWorkspaceHook } from "./hookInjection";
import { startHookHealthMonitor } from "./hookHealthMonitor";
import { startUpdateChecker as _startUpdateChecker } from "./updateChecker";
import { showFeedbackWindow } from "./feedbackWindow";
import { removeServerFromConfig, restoreAllQuarantinedServers } from "./mcpConfigActions";
import { fetchUserRole, submitServerRequest, submitServerWithOverrides, approveServerRequest } from "./mcpServerSubmit";
import { detectSecrets } from "./secretDetection";
import type { TemplatizedConfig } from "./secretDetection";
import { runDebugQuarantine, handleQuarantineDisabled } from "./quarantineManager";
import { filterOutEdisonWatchServers } from "./mcpConfigMonitor";
import { applyAppIntegrations } from "./mcpConfigWriter";
import { deduplicateServers } from "./serverDeduplication";
import {
  DRY_RUN,
  ENV_DOCS_URL,
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

  ipcMain.handle("accounts:switch", (_event, userId: string) => {
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
      // VS Code Insiders: check Code - Insiders/ app data dir, not User/ subdir,
      // since the User/ folder only exists after first launch.
      detectDir?: (configPath: string) => string;
    }> = [
      {
        id: "vscode",
        name: "VS Code",
        getPath: () => Promise.resolve(getVscodeUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)), // ~/Library/Application Support/Code/
      },
      {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        getPath: () => Promise.resolve(getVscodeInsidersUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)), // ~/Library/Application Support/Code - Insiders/
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
      { id: "antigravity", name: "Antigravity", getPath: () => Promise.resolve(getAntigravityConfigPath()) },
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

  ipcMain.handle("mcp:discover", async () => {
    const all = await discoverMcpServers();
    const servers = filterOutEdisonWatchServers(all);
    console.log("[mcp:discover] Found", servers.length, "servers (filtered out", all.length - servers.length, "EW servers)");
    return servers;
  });

  ipcMain.handle("mcp:readConfig", async (_event, configPath: string) => {
    try {
      return await fs.readFile(configPath, "utf-8");
    } catch {
      return null;
    }
  });

  ipcMain.handle("mcp:applyAppIntegrations", async (_event, args: {
    serverAddress: string;
    mcpBaseUrl: string;
    apiKey: string;
    edisonSecretKey?: string;
    apps: string[];
  }) => {
    console.log("[mcp:applyAppIntegrations]", args.apps, DRY_RUN ? "(dry-run)" : "");
    return await applyAppIntegrations({ ...args, dryRun: DRY_RUN });
  });

  // Revert app integrations: restore config files from setup backups
  ipcMain.handle("mcp:revertAppIntegrations", async (_event, args: {
    configs: Array<{ configPath: string; backupPath: string }>;
  }): Promise<{ reverted: number; errors: string[] }> => {
    const { configs } = args;
    let reverted = 0;
    const errors: string[] = [];
    const allowedDirs = [homedir(), app.getPath("userData")];
    const isAllowedPath = (p: string): boolean =>
      allowedDirs.some((dir) => resolve(p).startsWith(dir + sep));

    for (const { configPath, backupPath } of configs) {
      try {
        if (!isAllowedPath(configPath) || !isAllowedPath(backupPath)) {
          errors.push(`Path not allowed: ${configPath}`);
          continue;
        }
        if (!backupPath || !(await fs.access(backupPath).then(() => true).catch(() => false))) {
          errors.push(`No backup found for ${configPath}`);
          continue;
        }
        await fs.copyFile(backupPath, configPath);
        reverted++;
        console.log(`[MCP Revert] Restored ${configPath} from ${backupPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${configPath}: ${msg}`);
        console.warn("[MCP Revert] Failed to restore", configPath, err);
      }
    }
    return { reverted, errors };
  });

  // Analyze discovered servers for secrets (without submitting)
  ipcMain.handle("mcp:analyzeSecrets", async (): Promise<Array<{
    name: string;
    client: string;
    source: string;
    config: McpServerConfig;
    templatized: TemplatizedConfig;
  }>> => {
    const all = await discoverMcpServers();
    const filtered = filterOutEdisonWatchServers(all);
    const servers = deduplicateServers(filtered);
    return servers.map((server) => ({
      name: server.name,
      client: server.client,
      source: server.source,
      config: server.config,
      templatized: detectSecrets(server),
    }));
  });

  // Submit servers with user-defined template overrides
  ipcMain.handle("mcp:submitWithTemplates", async (_event, params: {
    apiKey?: string;
    apiBaseUrl?: string;
    userId?: string;
    templateOverrides: Record<string, Array<{
      entryId: string;
      varName: string;
      selectedText: string;
      start: number;
      end: number;
    }>>;
  }): Promise<{
    submitted: number;
    autoApproved: number;
    skipped: number;
    total: number;
    servers?: Array<{ name: string; client: string; source: string }>;
    error?: string;
    errors?: string[];
  }> => {
    const setup = getSetupData();
    const apiKey = params.apiKey || setup.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;
    const userId = params.userId || setup.userId;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const all = await discoverMcpServers();
    const filtered = filterOutEdisonWatchServers(all);
    const servers = deduplicateServers(filtered);

    const serverList = servers.map((s) => ({ name: s.name, client: s.client, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    const errors: string[] = [];

    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";

    for (const server of servers) {
      try {
        const overrides = params.templateOverrides[server.name];
        const submitResult = overrides
          ? await submitServerWithOverrides(server, overrides, apiBaseUrl, apiKey, userId)
          : await submitServerRequest(server, apiBaseUrl, apiKey, userId);

        if (submitResult.alreadyPending || submitResult.alreadyExists) continue;
        submitted++;

        if (canAutoApprove) {
          try {
            await approveServerRequest(submitResult.request_id, apiBaseUrl, apiKey);
            autoApproved++;
          } catch (approveErr) {
            const msg = approveErr instanceof Error ? approveErr.message : String(approveErr);
            errors.push(`${server.name}: auto-approval failed — ${msg}`);
          }
        }

        try { await removeServerFromConfig(server); } catch { /* non-fatal */ }
      } catch (e) {
        const msg = server.name + ": " + (e instanceof Error ? e.message : String(e));
        errors.push(msg);
      }
    }
    return {
      submitted, autoApproved,
      skipped: servers.length - submitted,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : undefined,
    };
  });

  // Submit all discovered MCP servers for approval
  ipcMain.handle("mcp:submitAllDiscovered", async (_event, params?: {
    apiKey?: string;
    apiBaseUrl?: string;
    userId?: string;
  }): Promise<{
    submitted: number;
    autoApproved: number;
    skipped: number;
    total: number;
    servers?: Array<{ name: string; client: string; source: string }>;
    error?: string;
    errors?: string[];
  }> => {
    const setup = getSetupData();
    const apiKey = params?.apiKey || setup.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params?.apiBaseUrl || setup.apiBaseUrl;
    const userId = params?.userId || setup.userId;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const all = await discoverMcpServers();
    const filtered = filterOutEdisonWatchServers(all);

    // Deduplicate servers with the same name across different clients.
    // If configs are identical → keep one. If configs differ → prefix both with client name.
    const servers = deduplicateServers(filtered);

    const serverList = servers.map((s) => ({ name: s.name, client: s.client, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    const errors: string[] = [];

    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";

    for (const server of servers) {
      try {
        const submitResult = await submitServerRequest(server, apiBaseUrl, apiKey, userId);
        if (submitResult.alreadyPending || submitResult.alreadyExists) {
          continue;
        }
        submitted++;
        const { request_id } = submitResult;
        if (canAutoApprove) {
          try {
            await approveServerRequest(request_id, apiBaseUrl, apiKey);
            autoApproved++;
          } catch (approveErr) {
            const msg = approveErr instanceof Error ? approveErr.message : String(approveErr);
            errors.push(`${server.name}: auto-approval failed — ${msg}`);
            console.error(`[mcp:submitAllDiscovered] Auto-approval failed for "${server.name}":`, approveErr);
          }
        }

        // Remove the server from the agent's config after successful submission
        try {
          await removeServerFromConfig(server);
        } catch (removeErr) {
          console.error(`[mcp:submitAllDiscovered] Failed to remove "${server.name}" from config:`, removeErr);
        }
      } catch (e) {
        const msg = server.name + ": " + (e instanceof Error ? e.message : String(e));
        errors.push(msg);
        console.error("[mcp:submitAllDiscovered]", msg);
      }
    }
    return {
      submitted,
      autoApproved,
      skipped: servers.length - submitted,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : undefined,
    };
  });

  // Handle individual server actions from the registration/quarantine dialogs
  ipcMain.handle("mcp:handleServerAction", async (_event, params: {
    fingerprint: string;
    serverName: string;
    sourceApp: string;
    action: string;
    config: Record<string, unknown>;
    configPath: string;
  }) => {
    // Only submit for registration/request actions — skip dismissed/skipped servers
    if (params.action !== "registered" && params.action !== "requested") {
      return { action: params.action };
    }

    const setup = getSetupData();
    const apiKey = setup.apiKey;
    const apiBaseUrl = getApiBaseUrl();

    if (!apiKey || !apiBaseUrl) {
      throw new Error("Not signed in or server URL not configured.");
    }

    const server: DiscoveredMcpServer = {
      name: params.serverName,
      client: params.sourceApp as McpClientId,
      source: "user",
      path: params.configPath,
      config: params.config as McpServerConfig,
    };

    const submitResult = await submitServerRequest(server, apiBaseUrl, apiKey, setup.userId);

    if (submitResult.alreadyPending) {
      return { action: params.action, alreadyPending: true };
    }
    if (submitResult.alreadyExists) {
      return { action: params.action, alreadyExists: true, errorMessage: submitResult.errorMessage };
    }

    const { request_id } = submitResult;

    // Auto-approve if user is admin/owner and action is "registered"
    let autoApproved = false;
    let approveError: string | undefined;
    if (params.action === "registered") {
      const role = await fetchUserRole(apiBaseUrl, apiKey);
      if (role === "admin" || role === "owner") {
        try {
          await approveServerRequest(request_id, apiBaseUrl, apiKey);
          autoApproved = true;
        } catch (err) {
          approveError = err instanceof Error ? err.message : String(err);
          console.error(`[mcp:handleServerAction] Auto-approval failed for "${params.serverName}":`, err);
        }
      }
    }

    return { request_id, action: params.action, autoApproved, approveError };
  });

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
