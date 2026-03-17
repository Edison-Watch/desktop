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
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join, resolve, sep, dirname } from "path";
import { homedir } from "os";
import { promises as fs, readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from "fs";

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
import { discoverMcpServers, getJetBrainsMcpConfigPaths } from "./mcpDiscovery";
import { injectAllHooks, removeAllHooks, getHookStatus, injectVsCodeWorkspaceHook, removeVsCodeWorkspaceHook } from "./hookInjection";
import { initSentry } from "./sentry";
import { startHookHealthMonitor, stopHookHealthMonitor, getHookStatusLabel } from "./hookHealthMonitor";
import { startUpdateChecker, stopUpdateChecker, getAvailableUpdate, openUpdateDownload, checkForUpdateNow } from "./updateChecker";
import { showDebugWindow } from "./debugWindow";
import { showFeedbackWindow } from "./feedbackWindow";
import { showServerRegistrationDialog } from "./mcpServerActionDialog";
import { showUpdateKeysWindow } from "./updateKeysWindow";
import { fetchUserRole, submitServerRequest, approveServerRequest } from "./mcpConfigActions";
import { filterOutEdisonWatchServers, McpConfigMonitor } from "./mcpConfigMonitor";
import { SeenServersStore } from "./seenServersStore";
import { applyAppIntegrations } from "./mcpConfigWriter";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import appIconPath from "../../resources/icon.png?asset";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from "../../resources/icon_tray.png?asset";

// ── Server deduplication ─────────────────────────────────────────────

import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "./mcpDiscovery";

/** Compare two McpServerConfig objects for structural equality (ignoring key order). */
function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}

/**
 * Deduplicate discovered servers that share the same name across clients.
 * - Identical configs → keep the first one (single submission).
 * - Different configs → rename both to `name_client` (e.g. sqlite_vscode, sqlite_cursor).
 */
function deduplicateServers(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
  // Group by server name
  const byName = new Map<string, DiscoveredMcpServer[]>();
  for (const s of servers) {
    const group = byName.get(s.name);
    if (group) group.push(s);
    else byName.set(s.name, [s]);
  }

  const result: DiscoveredMcpServer[] = [];
  for (const [, group] of byName) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Check if all configs in the group are identical
    const allSame = group.every((s) => configsEqual(s.config, group[0].config));
    if (allSame) {
      // Keep just the first one — they're all the same server
      result.push(group[0]);
    } else {
      // Configs differ — prefix each with its client name
      for (const s of group) {
        result.push({ ...s, name: `${s.name}_${s.client}` });
      }
    }
  }
  return result;
}

// ── Dry-run mode ────────────────────────────────────────────────────

/** When true, onboarding runs normally but config files are not written. */
const DRY_RUN = process.env.EDISON_DRY_RUN === "1";
if (DRY_RUN) console.log("[dry-run] Dry-run mode enabled — config files will not be modified");

// ── Debug environment switcher ───────────────────────────────────────

const DEBUG_ENV_NAMES = ["demo", "release", "dev"] as const;
type DebugEnvName = (typeof DEBUG_ENV_NAMES)[number];

/** The environment this binary was compiled for (from VITE_DEPLOY_ENV at build time). */
function getBuildDefaultEnv(): DebugEnvName | null {
  if (is.dev) return "dev";
  const v = import.meta.env.VITE_DEPLOY_ENV as string | undefined;
  if (v === "demo" || v === "release" || v === "dev") return v;
  return null;
}


// "dev" = localhost backend (make dev / make demo_server) + demo Supabase auth
const DEV_MCP_BASE_URL = "http://localhost:3000";
const DEV_API_BASE_URL = "http://localhost:3001";

// Per-env default API/MCP URLs for self-serve users (backend_base_url is null).
// Values are injected at build time from frontend-v2/.env.<mode> — do not hardcode here.
const ENV_API_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";
const ENV_MCP_URL: string = import.meta.env.VITE_MCP_BASE_URL ?? "";
const ENV_DOCS_URL: string = import.meta.env.VITE_DOCS_BASE_URL ?? "https://docs.edison.watch";

function getDebugEnvOverridePath(): string {
  return join(app.getPath("userData"), "edison_debug_env.json");
}

function getDebugEnvOverride(): DebugEnvName | null {
  try {
    const p = getDebugEnvOverridePath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as { env?: string };
    if (data.env === "demo" || data.env === "release" || data.env === "dev") return data.env;
    return null;
  } catch {
    return null;
  }
}

function setDebugEnvOverride(env: DebugEnvName | null): void {
  try {
    const p = getDebugEnvOverridePath();
    if (env === null) {
      if (existsSync(p)) unlinkSync(p);
      return;
    }
    writeFileSync(p, JSON.stringify({ env }), "utf-8");
  } catch {
    // best effort only
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let approvalWindow: BrowserWindow | null = null;

// ── Dev auth server (localhost OAuth callback for unpackaged dev builds) ─
let devAuthServer: ReturnType<typeof createServer> | null = null;
let devAuthCallbackUrl: string | null = null;

// ── SSE state ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eventSource: any = null;
const pendingApprovals: Map<string, PendingApproval> = new Map();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 1000;

interface PendingApproval {
  id: string;
  sessionId: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  reason?: string;
  timestamp: number;
}

interface TrifectaEventData {
  session_id: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  reason?: string;
  user_id?: string;
}

// ── Server status state ─────────────────────────────────────────────

let isServerOnline = false;
let serverStatusCheckInterval: ReturnType<typeof setInterval> | null = null;
let configMonitor: McpConfigMonitor | null = null;
let autoQuarantineEnabled = false;
let isHandlingQuarantine = false;

// ── Setup data persistence ──────────────────────────────────────────

interface SetupData {
  completed?: boolean;
  userEmail?: string;
  userId?: string;
  serverAddress?: string;
  mcpBaseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  edisonSecretKey?: string;
}

let setupCompleted: boolean | null = null;

function getSetupFlagPath(): string {
  return join(app.getPath("userData"), "setup.json");
}

function getSetupData(): SetupData {
  try {
    const raw = readFileSync(getSetupFlagPath(), "utf-8");
    return JSON.parse(raw) as SetupData;
  } catch {
    return { completed: false };
  }
}

function isSetupComplete(): boolean {
  if (setupCompleted !== null) return setupCompleted;
  const data = getSetupData();
  setupCompleted = data.completed === true;
  return setupCompleted;
}

function markSetupComplete(data?: Partial<SetupData>): void {
  const existing = getSetupData();
  const merged: SetupData = { ...existing, ...data, completed: true };
  writeFileSync(getSetupFlagPath(), JSON.stringify(merged, null, 2), "utf-8");
  setupCompleted = true;
  app.setLoginItemSettings({ openAtLogin: true });
}

function markSetupIncomplete(): void {
  writeFileSync(getSetupFlagPath(), JSON.stringify({ completed: false }), "utf-8");
  setupCompleted = false;
  app.setLoginItemSettings({ openAtLogin: false });
}

// ── URL helpers ─────────────────────────────────────────────────────

function getActiveEnv(): string {
  return getDebugEnvOverride() ?? getBuildDefaultEnv() ?? "demo";
}

function getApiBaseUrl(): string | null {
  const activeEnv = getActiveEnv();
  if (activeEnv === "dev" || is.dev) return DEV_API_BASE_URL;
  const setupData = getSetupData();
  if (setupData.apiBaseUrl) return setupData.apiBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  // Self-serve: look up default for the active env.
  const url = ENV_API_URL || null;
  if (!url) console.warn(`[getApiBaseUrl] No API URL for env "${activeEnv}".`);
  return url;
}

function getMcpBaseUrl(): string | null {
  const activeEnv = getActiveEnv();
  if (activeEnv === "dev" || is.dev) return DEV_MCP_BASE_URL;
  const setupData = getSetupData();
  if (setupData.mcpBaseUrl) return setupData.mcpBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  // Self-serve: look up default for the active env.
  const url = ENV_MCP_URL || null;
  if (!url) console.warn(`[getMcpBaseUrl] No MCP URL for env "${activeEnv}".`);
  return url;
}

function getEventsUrl(apiKey: string): string | null {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/events?api_key=${encodeURIComponent(apiKey)}`;
}

function getApprovalUrl(): string | null {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/approvals/action`;
}

function getMcpUrl(): string | null {
  const setupData = getSetupData();
  const mcpBaseUrl = getMcpBaseUrl();
  if (mcpBaseUrl && setupData.apiKey) {
    return `${mcpBaseUrl.replace(/\/$/, "")}/mcp/${setupData.apiKey}`;
  }
  return null;
}

function getMcpConfig(): string | null {
  const url = getMcpUrl();
  if (!url) return null;
  const setupData = getSetupData();
  const args = ["-y", "mcp-remote", url, "--transport", "http"];
  if (setupData.edisonSecretKey) {
    args.push("--header", `X-Edison-Secret-Key:${setupData.edisonSecretKey}`);
  }
  const config = {
    servers: {
      edisonwatch: {
        type: "stdio",
        command: "npx",
        args,
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

// ── Server status checks ────────────────────────────────────────────

async function checkServerStatus(): Promise<boolean> {
  try {
    const mcpUrl = getMcpBaseUrl();
    if (!mcpUrl) return false;

    const healthUrl = `${mcpUrl.replace(/\/$/, "")}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  } catch {
    return false;
  }
}

function startServerStatusChecks(): void {
  checkServerStatus().then((status) => {
    isServerOnline = status;
    updateTrayMenu();
  });

  if (serverStatusCheckInterval) clearInterval(serverStatusCheckInterval);
  serverStatusCheckInterval = setInterval(async () => {
    const status = await checkServerStatus();
    if (status !== isServerOnline) {
      isServerOnline = status;
      updateTrayMenu();
    }
  }, 30000);
}

function stopServerStatusChecks(): void {
  if (serverStatusCheckInterval) {
    clearInterval(serverStatusCheckInterval);
    serverStatusCheckInterval = null;
  }
}

// ── SSE event subscription ──────────────────────────────────────────

function startEventSubscription(): void {
  const setupData = getSetupData();
  const apiKey = setupData.apiKey;
  const userId = setupData.userId;

  if (!apiKey || !userId) {
    console.warn("Cannot start event subscription: missing apiKey or userId");
    return;
  }

  const eventsUrl = getEventsUrl(apiKey);
  if (!eventsUrl) {
    console.warn("Cannot start event subscription: cannot construct events URL");
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  console.log(`Connecting to SSE endpoint: ${eventsUrl.replace(/api_key=[^&]+/, "api_key=***")}`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventSource } = require("eventsource");
    eventSource = new EventSource(eventsUrl);

    eventSource.onmessage = (event: { data: string }) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "mcp_pre_block") {
          handleTrifectaEvent(data);
        } else if (data.type === "quarantine_enabled") {
          const userDomain = getSetupData().userEmail?.split("@")[1];
          if (!data.domain || data.domain === userDomain) {
            handleQuarantineEnabled();
          }
        }
      } catch (err) {
        console.error("Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = () => {
      handleReconnect();
    };

    eventSource.onopen = () => {
      console.log("SSE connection established");
      reconnectAttempts = 0;
    };
  } catch (err) {
    console.error("Failed to create EventSource:", err);
    handleReconnect();
  }
}

function stopEventSubscription(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempts = 0;
}

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

function handleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("Max reconnect attempts reached, stopping SSE subscription");
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(() => {
    startEventSubscription();
  }, delay);
}

function handleTrifectaEvent(data: TrifectaEventData): void {
  const { session_id, kind, name, reason } = data;
  const approvalId = `${session_id}::${kind}::${name}::${Date.now()}`;

  const pending: PendingApproval = {
    id: approvalId,
    sessionId: session_id,
    kind,
    name,
    reason,
    timestamp: Date.now(),
  };
  pendingApprovals.set(approvalId, pending);
  updateTrayMenu();

  // Notify approval window if open
  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.webContents.send("approval:added", {
      id: approvalId,
      sessionId: session_id,
      kind,
      name,
      reason,
      timestamp: pending.timestamp,
    });
  }

  // Show native notification
  try {
    if (!Notification.isSupported()) return;

    const toolName = name.replace(/^agent_/, "").replace(/_/g, " ");
    const readableName = toolName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title: "Edison Watch - Security Block",
      body: `${readableName} has been blocked.\nThis action requires your approval to proceed.`,
      urgency: "normal",
      ...(process.platform !== "darwin" && { icon: trayIconPath }),
    };

    if (process.platform === "darwin") {
      notificationOptions.actions = [
        { type: "button", text: "Approve" },
        { type: "button", text: "Auto-Approve" },
        { type: "button", text: "Deny" },
      ];
    }

    const notification = new Notification(notificationOptions);

    if (process.platform === "darwin") {
      notification.on("action", (_event, index) => {
        const commands: Array<"approve" | "approve_and_remember" | "deny"> = [
          "approve",
          "approve_and_remember",
          "deny",
        ];
        const command = commands[index];
        if (command) handleApproval(approvalId, command);
      });
    }

    notification.on("click", () => {
      showPendingApprovalsDialog();
    });

    notification.show();
    setTimeout(() => notification.close(), 30000);
  } catch (err) {
    console.error("Failed to show notification:", err);
  }
}

// ── Approval handling ───────────────────────────────────────────────

async function handleApproval(
  approvalId: string,
  command: "approve" | "deny" | "approve_and_remember",
): Promise<void> {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return;

  const setupData = getSetupData();
  const apiKey = setupData.apiKey;
  if (!apiKey) return;

  const approvalUrl = getApprovalUrl();
  if (!approvalUrl) return;

  try {
    const response = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        session_id: pending.sessionId,
        kind: pending.kind,
        name: pending.name,
        command,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Approval failed: ${response.status} ${errorText}`);
    }

    pendingApprovals.delete(approvalId);
    updateTrayMenu();

    // Show success notification
    if (Notification.isSupported()) {
      const actionLabel =
        command === "approve"
          ? "approved"
          : command === "approve_and_remember"
            ? "approved and remembered"
            : "denied";
      const n = new Notification({
        title: "Edison Watch",
        body: `Successfully ${actionLabel} ${pending.kind} '${pending.name}'`,
        ...(process.platform !== "darwin" && { icon: trayIconPath }),
      });
      n.show();
    }

    if (approvalWindow && !approvalWindow.isDestroyed()) {
      approvalWindow.webContents.send("approval:removed", approvalId);
      if (pendingApprovals.size === 0) {
        setTimeout(() => {
          if (approvalWindow && !approvalWindow.isDestroyed()) approvalWindow.close();
        }, 500);
      }
    }
  } catch (err) {
    console.error(`Failed to ${command} ${pending.kind} '${pending.name}':`, err);
  }
}

// ── Pending approvals dialog ────────────────────────────────────────

function showPendingApprovalsDialog(): void {
  const approvals = Array.from(pendingApprovals.values());
  if (approvals.length === 0) return;

  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.focus();
    return;
  }

  approvalWindow = new BrowserWindow({
    width: 500,
    height: Math.min(600, 200 + approvals.length * 80),
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const approvalsHtml = approvals
    .map((a) => {
      const toolName = a.name.replace(/^agent_/, "").replace(/_/g, " ");
      const readableName = toolName
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      return `
        <div class="approval-item" data-approval-id="${a.id}">
          <div class="approval-header">
            <strong>${readableName}</strong>
            <span class="approval-kind">${a.kind}</span>
          </div>
          <div class="approval-session">Session: ${a.sessionId.substring(0, 8)}...</div>
          <div class="approval-timestamp" data-timestamp="${a.timestamp}"></div>
          <div class="approval-actions">
            <button class="button button-approve" data-command="approve">Approve</button>
            <button class="button button-approve-remember" data-command="approve_and_remember">Auto-Approve</button>
            <button class="button button-deny" data-command="deny">Deny</button>
          </div>
        </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Pending Approvals</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0b0c10;--card:#111318;--border:#1f2430;--text:#e6e6e6;--muted:#a0a7b4}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
h1{font-size:20px}
.header-actions{display:flex;gap:8px}
.approval-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;overflow:hidden;transition:all .4s cubic-bezier(.4,0,.2,1)}
.approval-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.approval-header strong{font-size:16px}
.approval-kind{font-size:12px;color:var(--muted);text-transform:uppercase}
.approval-session{font-size:12px;color:var(--muted);margin-bottom:4px}
.approval-timestamp{font-size:11px;color:var(--muted);margin-bottom:12px}
.approval-actions{display:flex;gap:8px}
.button{border:1px solid var(--border);background:var(--card);color:var(--text);padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .2s}
.button:hover{filter:brightness(1.05)}
.button:disabled{opacity:.5;cursor:not-allowed}
.button-approve{background:#22c55e!important;color:#fff!important;border-color:#22c55e!important}
.button-approve-remember{background:#2563eb!important;color:#fff!important;border-color:#2563eb!important}
.button-deny{background:rgba(239,68,68,.1)!important;border-color:var(--border)!important}
.button-approve-all{background:#22c55e!important;color:#fff!important;border-color:#22c55e!important}
.button-deny-all{background:rgba(239,68,68,.1)!important;border-color:var(--border)!important}
</style></head>
<body>
<div class="header">
  <h1>Pending Approvals (${approvals.length})</h1>
  <div class="header-actions">
    <button class="button button-approve-all" id="approve-all">Approve All</button>
    <button class="button button-deny-all" id="deny-all">Deny All</button>
  </div>
</div>
<div id="approvals">${approvalsHtml}</div>
<script>
const{ipcRenderer}=require('electron');
function updateHeaderCount(){const r=document.querySelectorAll('.approval-item').length;const h=document.querySelector('h1');if(h)h.textContent='Pending Approvals ('+r+')'}
function formatTimestamp(ts){const d=new Date(ts),now=new Date(),diff=Math.floor((now-d)/1000);const ds=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});const ts2=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});let rel='';if(diff<60)rel=diff+' second'+(diff!==1?'s':'')+' ago';else if(diff<3600){const m=Math.floor(diff/60);rel=m+' minute'+(m!==1?'s':'')+' ago'}else if(diff<86400){const h=Math.floor(diff/3600);rel=h+' hour'+(h!==1?'s':'')+' ago'}else{const dy=Math.floor(diff/86400);rel=dy+' day'+(dy!==1?'s':'')+' ago'}return ds+', '+ts2+' ('+rel+')'}
function updateTimestamps(){document.querySelectorAll('.approval-timestamp').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(t)el.textContent=formatTimestamp(t)})}
setInterval(updateTimestamps,1000);updateTimestamps();
function removeApprovalItem(id){const item=document.querySelector('[data-approval-id="'+id+'"]');if(!item)return;item.style.transition='all .4s cubic-bezier(.4,0,.2,1)';item.style.transform='translateX(-100%)';item.style.opacity='0';item.style.maxHeight=item.offsetHeight+'px';setTimeout(()=>{item.style.maxHeight='0';item.style.marginBottom='0';item.style.paddingTop='0';item.style.paddingBottom='0';item.style.borderWidth='0'},100);setTimeout(()=>{item.remove();updateHeaderCount();if(document.querySelectorAll('.approval-item').length===0)setTimeout(()=>window.close(),300)},400)}
document.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn)return;const item=btn.closest('.approval-item');if(!item)return;const aId=item.dataset.approvalId,cmd=btn.dataset.command;if(aId&&cmd){item.querySelectorAll('button').forEach(b=>{b.disabled=true;b.style.opacity='0.5'});const ch=cmd==='approve_and_remember'?'approval:approve-remember':'approval:'+cmd;ipcRenderer.invoke(ch,aId).catch(err=>{alert('Failed: '+(err.message||String(err)));item.querySelectorAll('button').forEach(b=>{b.disabled=false;b.style.opacity='1'})})}});
function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function addApprovalItem(a){const c=document.getElementById('approvals');if(!c)return;const tn=(a.name||'').replace(/^agent_/,'').replace(/_/g,' ');const rn=tn.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');const item=document.createElement('div');item.className='approval-item';item.setAttribute('data-approval-id',a.id);item.style.opacity='0';item.style.transform='translateY(-20px)';item.innerHTML='<div class="approval-header"><strong>'+escapeHtml(rn)+'</strong><span class="approval-kind">'+escapeHtml(a.kind)+'</span></div><div class="approval-session">Session: '+escapeHtml((a.sessionId||'').substring(0,8))+'...</div><div class="approval-timestamp" data-timestamp="'+escapeHtml(a.timestamp)+'"></div><div class="approval-actions"><button class="button button-approve" data-command="approve">Approve</button><button class="button button-approve-remember" data-command="approve_and_remember">Auto-Approve</button><button class="button button-deny" data-command="deny">Deny</button></div>';c.appendChild(item);setTimeout(()=>{item.style.transition='all .3s cubic-bezier(.4,0,.2,1)';item.style.opacity='1';item.style.transform='translateY(0)'},10);const tel=item.querySelector('.approval-timestamp');if(tel)tel.textContent=formatTimestamp(a.timestamp);updateHeaderCount()}
ipcRenderer.on('approval:removed',(_e,id)=>removeApprovalItem(id));
ipcRenderer.on('approval:added',(_e,a)=>addApprovalItem(a));
document.getElementById('approve-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-approve');if(b&&!b.disabled)b.click()})});
document.getElementById('deny-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-deny');if(b&&!b.disabled)b.click()})});
</script></body></html>`;

  approvalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  approvalWindow.once("ready-to-show", () => approvalWindow?.show());
  approvalWindow.on("closed", () => { approvalWindow = null; });
}

// ── Tray ────────────────────────────────────────────────────────────

function buildTrayMenuItems(): MenuItemConstructorOptions[] {
  const setupData = getSetupData();
  const pendingCount = pendingApprovals.size;
  const userDisplayName = setupData.userEmail || "Not signed in";

  const items: MenuItemConstructorOptions[] = [
    { label: "Enabled", type: "checkbox", checked: true, click: () => {} },
    { label: isServerOnline ? "Connected" : "Disconnected", enabled: false },
    { label: userDisplayName, enabled: false },
    { type: "separator" },
    {
      label: pendingCount > 0 ? `Pending Approvals (${pendingCount})` : "No Pending Approvals",
      enabled: pendingCount > 0,
      click: pendingCount > 0 ? () => showPendingApprovalsDialog() : undefined,
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

  startServerStatusChecks();

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
  // Effective env: manual override first, then build default
  const currentEnv = getDebugEnvOverride() ?? getBuildDefaultEnv();

  const envSubmenu: MenuItemConstructorOptions[] = DEBUG_ENV_NAMES.map((name) => ({
    label: name === "dev" ? "dev (localhost)" : name,
    type: "radio" as const,
    checked: currentEnv === name,
    click: () => {
      setDebugEnvOverride(name);
      logEnvConfig(`switch→${name}`);
      updateAppMenu();
      // Tell renderer so it can update its Supabase credentials and reload.
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

  // On macOS: buried inside the app-named menu (Edison Watch → Developer → Switch Environment)
  // On other platforms: buried at the bottom of the Edit menu
  const developerItem: MenuItemConstructorOptions = {
    label: "Developer",
    submenu: [{ label: "Switch Environment", submenu: envSubmenu }],
  };

  const template: MenuItemConstructorOptions[] = [
    // macOS requires an app-named first menu for Quit / About to appear correctly
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
    // Actions menu mirrors the tray menu for discoverability from the menu bar
    {
      label: "Actions",
      submenu: buildTrayMenuItems(),
    },
    // Standard Edit menu so copy/paste works in text fields
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
        // Non-macOS: developer options live here
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

// Flag to suppress app.quit() in the window-all-closed handler when we're
// intentionally restarting (logout / re-run wizard). Without this, on Windows
// and Linux destroying all windows would trigger app.quit() before the new
// login window is created.
let isRestarting = false;

async function rerunWizard(): Promise<void> {
  markSetupIncomplete();
  isRestarting = true;
  BrowserWindow.getAllWindows().forEach((w) => w.destroy());
  // Clear persisted Supabase session (localStorage, cookies) so the new window
  // doesn't auto-login with the old session.
  await session.defaultSession.clearStorageData({ storages: ["localstorage", "cookies", "indexdb"] });
  isRestarting = false;
  createWindow();
  // The window-state keeper may have persisted the compact menu size (400×380).
  // Reset to the full wizard dimensions now that setup is incomplete.
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
  isServerOnline = false;
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

// ── IPC handlers ────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Auth: open SAML/SSO URL in a separate BrowserWindow
  ipcMain.on("auth:open-saml", (_event, samlUrl: string) => {
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
        mainWindow?.webContents.send("auth:callback", currentUrl);
        authWindow.close();
      }
    });

    authWindow.webContents.on("will-navigate", (_event, url) => {
      if (url.startsWith("edison-watch://")) {
        mainWindow?.webContents.send("auth:callback", url);
        authWindow.close();
      }
    });

    authWindow.webContents.on("will-redirect", (_event, url) => {
      if (url.startsWith("edison-watch://")) {
        mainWindow?.webContents.send("auth:callback", url);
        authWindow.close();
      }
    });
  });

  // Auth: expose dev localhost callback URL (null in production)
  ipcMain.handle("auth:getDevCallbackUrl", () => devAuthCallbackUrl);

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
    startUpdateChecker();

    mainWindow?.close();
  });

  ipcMain.handle("setup:reset", () => {
    markSetupIncomplete();
    return { ok: true };
  });

  // Approval IPC from approval window
  ipcMain.handle("approval:approve", async (_event, approvalId: string) => {
    await handleApproval(approvalId, "approve");
  });

  ipcMain.handle("approval:deny", async (_event, approvalId: string) => {
    await handleApproval(approvalId, "deny");
  });

  ipcMain.handle("approval:approve-remember", async (_event, approvalId: string) => {
    await handleApproval(approvalId, "approve_and_remember");
  });

  // Server health check
  ipcMain.handle("menu:check-health", async () => {
    return isServerOnline;
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
        getPath: () => import("./mcpDiscovery").then(m => m.getVscodeUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)), // ~/Library/Application Support/Code/
      },
      {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        getPath: () => import("./mcpDiscovery").then(m => m.getVscodeInsidersUserMcpPath()),
        detectDir: (configPath) => dirname(dirname(configPath)), // ~/Library/Application Support/Code - Insiders/
      },
      { id: "cursor", name: "Cursor", getPath: () => import("./mcpDiscovery").then(m => m.getCursorConfigPath()) },
      { id: "claude-code", name: "Claude Code", getPath: () => import("./mcpDiscovery").then(m => m.getClaudeCodeUserSettingsPath()) },
      { id: "windsurf", name: "Windsurf", getPath: () => import("./mcpDiscovery").then(m => m.getWindsurfConfigPath()) },
      { id: "zed", name: "Zed", getPath: () => import("./mcpDiscovery").then(m => m.getZedConfigPath()) },
      { id: "claude-desktop", name: "Claude Desktop", getPath: () => import("./mcpDiscovery").then(m => m.getClaudeDesktopConfigPath()) },
      { id: "antigravity", name: "Antigravity", getPath: () => import("./mcpDiscovery").then(m => m.getAntigravityConfigPath()) },
    ];

    for (const check of checks) {
      try {
        const configPath = await check.getPath();
        const checkDir = check.detectDir ? check.detectDir(configPath) : dirname(configPath);
        await fs.access(checkDir);
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
        if (!backupPath || !existsSync(backupPath)) {
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
        const { request_id } = await submitServerRequest(server, apiBaseUrl, apiKey, userId);
        submitted++;
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

    const { request_id } = await submitServerRequest(server, apiBaseUrl, apiKey, setup.userId);

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
    return await getHookStatus();
  });

  ipcMain.handle("mcp:injectVsCodeWorkspaceHook", async (_event, workspacePath: string) => {
    return await injectVsCodeWorkspaceHook(workspacePath);
  });

  ipcMain.handle("mcp:removeVsCodeWorkspaceHook", async (_event, workspacePath: string) => {
    return await removeVsCodeWorkspaceHook(workspacePath);
  });
}

// ── Dev auth server (localhost OAuth callback for unpackaged dev builds) ─

/**
 * Start a tiny localhost HTTP server that receives OAuth callbacks in dev mode.
 * The server listens on a random available port. When the OAuth provider
 * redirects to http://127.0.0.1:<port>/auth/callback, the server extracts the
 * query string / hash and forwards the full URL to the renderer via IPC, exactly
 * like the protocol handler does in production.
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

// Handle deep link callback on Windows/Linux (second instance)
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
  const msg = `[env:${context}] activeEnv=${getActiveEnv()} buildEnv=${getBuildDefaultEnv()} apiBaseUrl=${getApiBaseUrl()} mcpBaseUrl=${getMcpBaseUrl()} VITE_API_BASE_URL=${ENV_API_URL} VITE_MCP_BASE_URL=${ENV_MCP_URL}`;
  slog(msg);
  mainWindow?.webContents.executeJavaScript(`console.log(${JSON.stringify(msg)})`).catch(() => {});
}

slog("module loaded, waiting for app.whenReady");

app.whenReady().then(async () => {
  slog("app.whenReady fired");
  electronApp.setAppUserModelId("com.edisonwatch.desktop");
  updateAppMenu();

  // Start localhost auth callback server in dev mode (custom protocol is unreliable
  // for unpackaged apps, so we receive OAuth callbacks over HTTP instead).
  if (is.dev) {
    try {
      // Timeout guards against environments (e.g. Docker E2E) where the TCP
      // listen on 127.0.0.1:0 never completes, which would otherwise hang
      // the entire whenReady handler and prevent createWindow() from running.
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
  registerIpcHandlers();
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
