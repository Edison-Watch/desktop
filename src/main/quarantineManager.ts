import { Notification } from "electron";
import { McpConfigMonitor } from "./mcpConfigMonitor";
import { SeenServersStore } from "./seenServersStore";
import { fetchUserRole, submitServerRequest, approveServerRequest } from "./mcpConfigActions";
import { fetchAutoQuarantineEnabled } from "./domainConfig";
import { getApiBaseUrl, getSetupData } from "./setupConfig";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from "../../resources/icon_tray.png?asset";

const LOG_FILE = "/tmp/ew-startup.log";
import { appendFileSync } from "fs";
function slog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}

let configMonitor: McpConfigMonitor | null = null;
let autoQuarantineEnabled = false;
let isHandlingQuarantine = false;

let updateTrayMenuFn: (() => void) | null = null;

export function initQuarantineManager(updateTrayMenu: () => void): void {
  updateTrayMenuFn = updateTrayMenu;
}

export function getAutoQuarantineEnabled(): boolean {
  return autoQuarantineEnabled;
}

export async function startQuarantineMonitorIfEnabled(): Promise<void> {
  const apiBaseUrl = getApiBaseUrl();
  const setupData = getSetupData();
  slog(`[Quarantine] startQuarantineMonitorIfEnabled: apiBaseUrl=${apiBaseUrl}, hasApiKey=${!!setupData.apiKey}`);
  if (!apiBaseUrl || !setupData.apiKey) {
    slog("[Quarantine] Skipping — missing apiBaseUrl or apiKey");
    return;
  }

  const enabled = await fetchAutoQuarantineEnabled(apiBaseUrl, setupData.apiKey);
  slog(`[Quarantine] fetchAutoQuarantineEnabled returned: ${enabled}`);
  if (!enabled) return;
  await startQuarantineMonitor();
}

async function startQuarantineMonitor(): Promise<void> {
  slog("[Quarantine] startQuarantineMonitor called");
  if (configMonitor) { slog("[Quarantine] Already running, skipping"); return; }
  autoQuarantineEnabled = true;
  updateTrayMenuFn?.();

  configMonitor = new McpConfigMonitor(new SeenServersStore());

  configMonitor.on("serversQuarantined", async (quarantinedEvents) => {
    slog(`[Quarantine] serversQuarantined event: ${quarantinedEvents.length} servers — ${quarantinedEvents.map((e: { server: { name: string } }) => e.server.name).join(", ")}`);
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

    // Submit quarantined servers to the backend for registration/approval
    if (apiBaseUrl && setup.apiKey) {
      for (const evt of quarantinedEvents) {
        try {
          const result = await submitServerRequest(evt.server, apiBaseUrl, setup.apiKey, setup.userId);
          if (!result.alreadyPending && isAdminOrOwner) {
            try {
              await approveServerRequest(result.request_id, apiBaseUrl, setup.apiKey);
              slog(`[Quarantine] Auto-approved server: ${evt.server.name}`);
            } catch (approveErr) {
              slog(`[Quarantine] Auto-approval failed for "${evt.server.name}": ${approveErr}`);
            }
          }
        } catch (submitErr) {
          slog(`[Quarantine] Failed to submit "${evt.server.name}" to backend: ${submitErr}`);
        }
      }
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

  configMonitor.on("error", (err) => {
    slog(`[Quarantine] Monitor error: ${err}`);
    console.error("[McpConfigMonitor] Error:", err);
  });

  slog("[Quarantine] Calling configMonitor.start()...");
  await configMonitor.start();
  slog("[Quarantine] configMonitor.start() completed");
}

export async function handleQuarantineEnabled(): Promise<void> {
  if (configMonitor || isHandlingQuarantine) return;
  isHandlingQuarantine = true;
  try {
    autoQuarantineEnabled = true;
    updateTrayMenuFn?.();
    await startQuarantineMonitor();
  } finally {
    isHandlingQuarantine = false;
  }
}

export function handleQuarantineDisabled(): void {
  if (!configMonitor && !autoQuarantineEnabled) return;
  stopQuarantineMonitor();
  updateTrayMenuFn?.();
}

export function stopQuarantineMonitor(): void {
  configMonitor?.stop();
  configMonitor = null;
  autoQuarantineEnabled = false;
}

const QUARANTINE_POLL_INTERVAL_MS = 60_000;
let quarantinePollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchQuarantineFlag(): Promise<boolean | null> {
  const apiBaseUrl = getApiBaseUrl();
  const setupData = getSetupData();
  if (!apiBaseUrl || !setupData.apiKey) return null;
  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${setupData.apiKey}` },
    });
    if (!resp.ok) return null;
    const config = (await resp.json()) as { auto_quarantine_other_mcp_servers?: boolean };
    return Boolean(config.auto_quarantine_other_mcp_servers);
  } catch {
    return null;
  }
}

async function pollQuarantineConfig(): Promise<void> {
  const shouldBeEnabled = await fetchQuarantineFlag();
  if (shouldBeEnabled === null) return;
  if (shouldBeEnabled && !configMonitor) {
    await handleQuarantineEnabled();
  } else if (!shouldBeEnabled && (configMonitor || autoQuarantineEnabled)) {
    handleQuarantineDisabled();
  }
}

export function startQuarantinePolling(): void {
  if (quarantinePollTimer) return;
  quarantinePollTimer = setInterval(() => { pollQuarantineConfig().catch(() => {}); }, QUARANTINE_POLL_INTERVAL_MS);
}

export function stopQuarantinePolling(): void {
  if (!quarantinePollTimer) return;
  clearInterval(quarantinePollTimer);
  quarantinePollTimer = null;
}
