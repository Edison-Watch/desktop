import {
  app,
  BrowserWindow,
  shell,
  session,
  Tray,
  Menu,
  Notification,
  nativeImage,
  clipboard,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "path";
import { appendFileSync } from "fs";

const LOG_FILE = "/tmp/ew-startup.log";
function slog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
// Inline replacements for @electron-toolkit/utils (removed due to Electron 40 compat issue:
// it evaluates electron.app.isPackaged at module load time, crashing before app.ready)
const is = { get dev() { return !app.isPackaged; } };
const electronApp = { setAppUserModelId: (id: string) => { if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? id : process.execPath); } };
const optimizer = { watchWindowShortcuts: (_win: BrowserWindow) => { /* no-op: dev shortcuts removed */ } };
import windowStateKeeper from "electron-window-state";
import { injectAllHooks } from "./hookInjection";
import { initSentry } from "./sentry";
import { startHookHealthMonitor, stopHookHealthMonitor, getHookStatusLabel } from "./hookHealthMonitor";
import { startUpdateChecker, stopUpdateChecker, getAvailableUpdate, openUpdateDownload, checkForUpdateNow } from "./updateChecker";
import { showDebugWindow } from "./debugWindow";
import { showFeedbackWindow } from "./feedbackWindow";
import { showServerRegistrationDialog } from "./mcpServerActionDialog";
import { showUpdateKeysWindow } from "./updateKeysWindow";
import { fetchUserRole } from "./mcpConfigActions";
import { McpConfigMonitor } from "./mcpConfigMonitor";
import { SeenServersStore } from "./seenServersStore";
import { applyAppIntegrations } from "./mcpConfigWriter";
import {
  DEBUG_ENV_NAMES,
  getBuildDefaultEnv,
  getDebugEnvOverride,
  setDebugEnvOverride,
  getActiveEnv,
  getApiBaseUrl,
  getMcpBaseUrl,
  getMcpUrl,
  getMcpConfig,
  getSetupData,
  isSetupComplete,
  markSetupComplete,
  markSetupIncomplete,
  startServerStatusChecks,
  stopServerStatusChecks,
  getIsServerOnline,
} from "./setupConfig";
import {
  pendingApprovals,
  startEventSubscription as _startEventSubscription,
  stopEventSubscription,
  showPendingApprovalsDialog,
  initApprovalsHandler,
} from "./approvalsHandler";
import { registerIpcHandlers } from "./ipcHandlers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import appIconPath from "../../resources/icon.png?asset";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from "../../resources/icon_tray.png?asset";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let approvalWindow: BrowserWindow | null = null;

// ── Dev auth server (localhost OAuth callback for unpackaged dev builds) ─
let devAuthServer: ReturnType<typeof createServer> | null = null;
let devAuthCallbackUrl: string | null = null;

// ── Server status state ─────────────────────────────────────────────

let configMonitor: McpConfigMonitor | null = null;
let autoQuarantineEnabled = false;
let isHandlingQuarantine = false;

// ── Flag to suppress app.quit() during intentional restarts ─────────

let isRestarting = false;

// ── Quarantine monitor ───────────────────────────────────────────────

async function startQuarantineMonitorIfEnabled(): Promise<void> {
  const apiBaseUrl = getApiBaseUrl();
  const setupData = getSetupData();
  if (!apiBaseUrl || !setupData.apiKey) return;

  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${setupData.apiKey}` },
    });
    if (!resp.ok) return;
    const config = (await resp.json()) as { auto_quarantine_other_mcp_servers?: boolean };
    if (!config.auto_quarantine_other_mcp_servers) return;
  } catch {
    return;
  }

  await startQuarantineMonitor();
}

async function startQuarantineMonitor(): Promise<void> {
  if (configMonitor) return; // already running
  autoQuarantineEnabled = true;
  updateTrayMenu();

  await injectAllHooks();

  configMonitor = new McpConfigMonitor(new SeenServersStore());

  configMonitor.on("serversQuarantined", async (quarantinedEvents) => {
    if (quarantinedEvents.length === 0) return;

    const apiBaseUrl = getApiBaseUrl();
    const setup = getSetupData();
    let isAdminOrOwner = false;
    if (apiBaseUrl && setup.apiKey) {
      try {
        const role = await fetchUserRole(apiBaseUrl, setup.apiKey);
        isAdminOrOwner = role === "admin" || role === "owner";
      } catch { /* treat as regular user on error */ }
    }

    if (isAdminOrOwner && Notification.isSupported()) {
      const names = quarantinedEvents.map((e) => e.server.name).join(", ");
      const n = new Notification({
        title: "Edison Watch — MCP Server Quarantined",
        body: `New server(s) quarantined: ${names}. Review in dashboard.`,
        ...(process.platform !== "darwin" && { icon: trayIconPath }),
      });
      n.show();
    }
    // Regular users: quarantine is silent
  });

  await configMonitor.start();
}

async function handleQuarantineEnabled(): Promise<void> {
  if (configMonitor || isHandlingQuarantine) return;
  isHandlingQuarantine = true;
  try {
    autoQuarantineEnabled = true;
    updateTrayMenu();
    await startQuarantineMonitor();
  } finally {
    isHandlingQuarantine = false;
  }
}

function stopQuarantineMonitor(): void {
  configMonitor?.stop();
  configMonitor = null;
  autoQuarantineEnabled = false;
}

function startEventSubscription(): void {
  _startEventSubscription(handleQuarantineEnabled);
}

// ── Tray ────────────────────────────────────────────────────────────

function buildTrayMenuItems(): MenuItemConstructorOptions[] {
  const setupData = getSetupData();
  const pendingCount = pendingApprovals.size;
  const userDisplayName = setupData.userEmail || "Not signed in";

  const items: MenuItemConstructorOptions[] = [
    { label: "Enabled", type: "checkbox", checked: true, click: () => {} },
    { label: getIsServerOnline() ? "Connected" : "Disconnected", enabled: false },
    { label: userDisplayName, enabled: false },
    { type: "separator" },
    {
      label: pendingCount > 0 ? `Pending Approvals (${pendingCount})` : "No Pending Approvals",
      enabled: pendingCount > 0,
      click: pendingCount > 0 ? () => showPendingApprovalsDialog(mainWindow) : undefined,
    },
    {
      label: "Register MCP Servers",
      enabled: Boolean(setupData.apiKey && (setupData.apiBaseUrl || setupData.serverAddress)),
      click: async () => {
        let isAdminOrOwner = false;
        const apiBaseUrl = getApiBaseUrl();
        if (apiBaseUrl && setupData.apiKey) {
          const role = await fetchUserRole(apiBaseUrl, setupData.apiKey);
          isAdminOrOwner = role === "admin" || role === "owner";
        }
        showServerRegistrationDialog(mainWindow ?? undefined, isAdminOrOwner);
      },
    },
    {
      label: "Open Dashboard",
      enabled: Boolean(getApiBaseUrl()),
      click: () => {
        const dashboardUrl = getApiBaseUrl();
        if (dashboardUrl) shell.openExternal(dashboardUrl);
      },
    },
    { type: "separator" },
    {
      label: "Copy EdisonWatch MCP config",
      enabled: Boolean(getMcpUrl()),
      click: () => {
        const mcpConfig = getMcpConfig();
        if (mcpConfig) {
          clipboard.writeText(mcpConfig);
          if (Notification.isSupported()) {
            const n = new Notification({
              title: "Edison Watch",
              body: "MCP config copied — paste into VSCode, Cursor, or your MCP client",
              ...(process.platform !== "darwin" && { icon: trayIconPath }),
            });
            n.show();
          }
        }
      },
    },
    { type: "separator" },
    { label: getHookStatusLabel(), enabled: false },
    {
      label: autoQuarantineEnabled
        ? "MCP Auto-Quarantine: Enabled"
        : "MCP Auto-Quarantine: Disabled",
      enabled: false,
    },
  ];

  const availableUpdate = getAvailableUpdate();
  if (availableUpdate) {
    items.push({
      label: `Update available: v${availableUpdate.version}`,
      click: () => openUpdateDownload(),
    });
  } else {
    items.push({
      label: "Check for Updates",
      click: async () => {
        try {
          const update = await checkForUpdateNow(trayIconPath);
          if (Notification.isSupported()) {
            if (update) {
              const notification = new Notification({
                title: "Edison Watch",
                body: `Version ${update.version} is available. Click to download.`,
                ...(process.platform !== "darwin" && { icon: trayIconPath }),
              });
              notification.on("click", () => openUpdateDownload());
              notification.show();
            } else {
              new Notification({
                title: "Edison Watch",
                body: "You're already on the latest version.",
                ...(process.platform !== "darwin" && { icon: trayIconPath }),
              }).show();
            }
          }
        } catch {
          if (Notification.isSupported()) {
            new Notification({
              title: "Edison Watch",
              body: "Update check failed. Please check your connection.",
              ...(process.platform !== "darwin" && { icon: trayIconPath }),
            }).show();
          }
        }
        updateTrayMenu();
      },
    });
  }

  items.push(
    { type: "separator" },
    {
      label: "Debug Window",
      click: () => showDebugWindow(mainWindow ?? undefined),
    },
    { type: "separator" },
    {
      label: "Re-run Setup Wizard",
      click: () => rerunWizard(),
    },
    {
      label: "Update Keys",
      click: () =>
        showUpdateKeysWindow(
          getSetupData,
          (key) => markSetupComplete({ edisonSecretKey: key }),
          async (compositeKey) => {
            const setup = getSetupData();
            const mcpBaseUrl = getMcpBaseUrl();
            const apiKey = setup.apiKey;
            const serverAddress = setup.serverAddress ?? "";
            if (!mcpBaseUrl || !apiKey) return;
            const allApps = [
              "vscode", "vscode-insiders", "cursor", "claude-desktop",
              "claude-code", "windsurf", "zed", "antigravity",
              "intellij", "pycharm", "webstorm",
            ];
            await applyAppIntegrations({
              serverAddress,
              mcpBaseUrl,
              apiKey,
              edisonSecretKey: compositeKey,
              apps: allApps,
            });
          },
        ),
    },
    {
      label: "Send Feedback",
      click: () => showFeedbackWindow(),
    },
    {
      label: "Sign Out",
      click: () => handleLogoutAndRestart(),
    },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  );

  return items;
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate(buildTrayMenuItems());
}

function createTray(): void {
  // macOS/Linux: use the dedicated tray icon (transparent, works with light+dark menu bars)
  // Windows: resize the main app icon (transparent icons look bad on Windows system tray)
  let trayIconToUse: string | Electron.NativeImage = trayIconPath;
  if (process.platform === "win32") {
    const img = nativeImage.createFromPath(appIconPath);
    trayIconToUse = img.resize({ width: 16, height: 16 });
  }
  tray = new Tray(trayIconToUse);
  tray.setToolTip("Edison Watch");

  const showMenu = (): void => {
    if (!tray) return;
    tray.popUpContextMenu(buildTrayMenu());
  };

  tray.on("click", showMenu);
  tray.on("right-click", showMenu);

  startServerStatusChecks(updateTrayMenu);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (process.platform === "darwin" && (app as any).dock?.setMenu) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).dock.setMenu(buildTrayMenu());
  }
}

function updateTrayMenu(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (tray && process.platform === "darwin" && (app as any).dock?.setMenu) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any).dock.setMenu(buildTrayMenu());
  }
  updateAppMenu();
}

// ── Application menu (always visible in native menu bar) ─────────────

function buildAppMenu(): Electron.Menu {
  const currentEnv = getDebugEnvOverride() ?? getBuildDefaultEnv();

  const envSubmenu: MenuItemConstructorOptions[] = DEBUG_ENV_NAMES.map((name) => ({
    label: name === "dev" ? "dev (localhost)" : name,
    type: "radio" as const,
    checked: currentEnv === name,
    click: () => {
      setDebugEnvOverride(name);
      logEnvConfig(`switch→${name}`);
      updateAppMenu();
      mainWindow?.webContents.send("env:changed", name);
      if (Notification.isSupported()) {
        new Notification({
          title: "Edison Watch",
          body: `Environment set to ${name === "dev" ? "dev (localhost backend, demo auth)" : name}.`,
          ...(process.platform !== "darwin" && { icon: trayIconPath }),
        }).show();
      }
    },
  }));

  const developerItem: MenuItemConstructorOptions = {
    label: "Developer",
    submenu: [{ label: "Switch Environment", submenu: envSubmenu }],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              developerItem,
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    { label: "Actions", submenu: buildTrayMenuItems() },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        ...(process.platform !== "darwin"
          ? ([{ type: "separator" }, developerItem] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ] as MenuItemConstructorOptions[],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? ([{ type: "separator" }, { role: "front" }] as MenuItemConstructorOptions[])
          : ([{ role: "close" }] as MenuItemConstructorOptions[])),
      ] as MenuItemConstructorOptions[],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function updateAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}

// ── Logout / re-run wizard ──────────────────────────────────────────

async function rerunWizard(): Promise<void> {
  markSetupIncomplete();
  isRestarting = true;
  BrowserWindow.getAllWindows().forEach((w) => w.destroy());
  await session.defaultSession.clearStorageData({ storages: ["localstorage", "cookies", "indexdb"] });
  isRestarting = false;
  createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMinimumSize(480, 600);
    mainWindow.setSize(540, 760, true);
    mainWindow.center();
  }
}

async function handleLogoutAndRestart(): Promise<void> {
  console.log("[Logout] Signing out...");
  stopServerStatusChecks();
  stopUpdateChecker();
  stopEventSubscription();
  stopHookHealthMonitor();
  stopQuarantineMonitor();
  pendingApprovals.clear();
  markSetupIncomplete();
  updateTrayMenu();
  await rerunWizard();
}

// ── Window creation ─────────────────────────────────────────────────

function createWindow(): void {
  slog("createWindow: start");
  const mainWindowState = windowStateKeeper({
    defaultWidth: 540,
    defaultHeight: 760,
  });

  mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 480,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux"
      ? { icon: join(__dirname, "../../build/icon.png") }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindowState.manage(mainWindow);

  mainWindow.on("ready-to-show", () => {
    slog("ready-to-show, showing window");
    mainWindow?.show();
  });

  mainWindow.webContents.on("did-finish-load", () => { slog("did-finish-load"); logEnvConfig("startup"); });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc) => slog(`did-fail-load code=${code} desc=${desc}`));
  mainWindow.webContents.on("render-process-gone", (_e, d) => slog(`render-process-gone reason=${d.reason} code=${d.exitCode}`));

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (
      navigationUrl.includes("/auth/callback") ||
      navigationUrl.includes("code=")
    ) {
      event.preventDefault();
      mainWindow?.webContents.send("auth:callback", navigationUrl);
    }
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ── Dev auth server (localhost OAuth callback for unpackaged dev builds) ─

/**
 * Start a tiny localhost HTTP server that receives OAuth callbacks in dev mode.
 */
function startDevAuthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      const reqUrl = req.url ?? "/";
      if (!reqUrl.startsWith("/auth/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const port = (devAuthServer!.address() as AddressInfo).port;
      const fullUrl = `http://127.0.0.1:${port}${reqUrl}`;
      console.log("[DevAuthServer] Received OAuth callback:", fullUrl);

      const parsedUrl = new URL(fullUrl);
      const hasCode = parsedUrl.searchParams.has("code");
      const hasToken = parsedUrl.searchParams.has("access_token");

      if ((hasCode || hasToken) && mainWindow) {
        mainWindow.webContents.send("auth:callback", fullUrl);
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1C1C1C;color:#C3FFFD">
  <div style="text-align:center">
    <h2>Authentication successful</h2>
    <p>You can close this tab and return to Edison Watch.</p>
  </div>
  <script>
    if (window.location.hash && window.location.hash.length > 1) {
      fetch('/auth/callback?from_hash=1&' + window.location.hash.substring(1))
    }
    window.close();
  </script>
</body>
</html>`);
    };

    devAuthServer = createServer(handler);
    devAuthServer.listen(0, "127.0.0.1", () => {
      const port = (devAuthServer!.address() as AddressInfo).port;
      devAuthCallbackUrl = `http://127.0.0.1:${port}/auth/callback`;
      console.log(`[DevAuthServer] Listening at ${devAuthCallbackUrl}`);
      resolve();
    });
    devAuthServer.on("error", (err) => {
      console.error("[DevAuthServer] Failed to start:", err);
      reject(err);
    });
  });
}

// ── Deep link protocol ──────────────────────────────────────────────

app.on("open-url", (_event, url) => {
  if (url.startsWith("edison-watch://")) {
    mainWindow?.webContents.send("auth:callback", url);
  }
});

app.on("second-instance", (_event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const url = commandLine.find((arg) => arg.startsWith("edison-watch://"));
  if (url && mainWindow) {
    mainWindow.webContents.send("auth:callback", url);
  }
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("edison-watch", process.execPath, [
      process.argv[1],
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("edison-watch");
}

// ── App lifecycle ───────────────────────────────────────────────────

// Sentry must be initialized before the app 'ready' event fires
initSentry();

function logEnvConfig(context: string): void {
  const msg = `[env:${context}] activeEnv=${getActiveEnv()} buildEnv=${getBuildDefaultEnv()} apiBaseUrl=${getApiBaseUrl()} mcpBaseUrl=${getMcpBaseUrl()} VITE_API_BASE_URL=${import.meta.env.VITE_API_BASE_URL ?? ""} VITE_MCP_BASE_URL=${import.meta.env.VITE_MCP_BASE_URL ?? ""}`;
  slog(msg);
  mainWindow?.webContents.executeJavaScript(`console.log(${JSON.stringify(msg)})`).catch(() => {});
}

slog("module loaded, waiting for app.whenReady");

// Wire up the approvals handler so it can access mainWindow/approvalWindow
initApprovalsHandler(
  () => mainWindow,
  () => approvalWindow,
  (w) => { approvalWindow = w; },
  updateTrayMenu,
);

app.whenReady().then(async () => {
  slog("app.whenReady fired");
  electronApp.setAppUserModelId("com.edisonwatch.desktop");
  updateAppMenu();

  if (is.dev) {
    try {
      await Promise.race([
        startDevAuthServer(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("DevAuthServer listen timeout")), 5_000),
        ),
      ]);
    } catch (err) {
      console.error("[App] Failed to start dev auth server, falling back to protocol handler:", err);
    }
  }

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  slog("calling registerIpcHandlers");
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getDevAuthCallbackUrl: () => devAuthCallbackUrl,
    createTray,
    startEventSubscription,
  });
  slog("registerIpcHandlers ok");

  if (isSetupComplete()) {
    slog("setup complete, creating tray");
    createTray();
    startEventSubscription();
    startHookHealthMonitor();
    startUpdateChecker();
    startQuarantineMonitorIfEnabled().catch((err) =>
      console.error("[Quarantine] Failed to start monitor:", err),
    );
    slog("tray/subscription/monitor ok");
  } else {
    slog("setup not complete");
  }

  slog("calling createWindow");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});


app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isRestarting) {
    app.quit();
  }
});
