import { BrowserWindow } from "electron";
import { McpConfigMonitor } from "./mcpConfigMonitor";
import { SeenServersStore } from "./seenServersStore";
import { showQuarantinedServersDialog } from "./mcpServerActionDialog";
import { fetchUserRole } from "./mcpServerSubmit";
import { fetchAutoQuarantineEnabled } from "./domainConfig";
import { getApiBaseUrl, getCredentialsForEnv } from "./setupConfig";

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
let getMainWindowFn: (() => BrowserWindow | null) | null = null;

export function initQuarantineManager(
  updateTrayMenu: () => void,
  getMainWindow: () => BrowserWindow | null,
): void {
  updateTrayMenuFn = updateTrayMenu;
  getMainWindowFn = getMainWindow;
}

export function getAutoQuarantineEnabled(): boolean {
  return autoQuarantineEnabled;
}

export async function startQuarantineMonitorIfEnabled(): Promise<void> {
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  slog(`[Quarantine] startQuarantineMonitorIfEnabled: apiBaseUrl=${apiBaseUrl}, hasApiKey=${!!creds?.apiKey}`);
  if (!apiBaseUrl || !creds?.apiKey) {
    slog("[Quarantine] Skipping — missing apiBaseUrl or apiKey");
    return;
  }

  const enabled = await fetchAutoQuarantineEnabled(apiBaseUrl, creds.apiKey);
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
    const creds = getCredentialsForEnv();
    let isAdminOrOwner = false;
    if (apiBaseUrl && creds?.apiKey) {
      try {
        const role = await fetchUserRole(apiBaseUrl, creds.apiKey);
        isAdminOrOwner = role === "admin" || role === "owner";
      } catch { /* treat as regular user on error */ }
    }

    const parentWindow = getMainWindowFn?.() ?? undefined;
    showQuarantinedServersDialog(quarantinedEvents, parentWindow ?? undefined, isAdminOrOwner).catch((err) => {
      slog(`[Quarantine] Failed to show quarantine dialog: ${err}`);
      console.error("[McpConfigMonitor] Failed to show quarantine dialog:", err);
    });
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

const QUARANTINE_POLL_INTERVAL_MS = 5 * 60_000; // 5 min — safety-net only; SSE push is primary
let quarantinePollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchQuarantineFlag(): Promise<boolean | null> {
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  if (!apiBaseUrl || !creds?.apiKey) return null;
  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    if (!resp.ok) return null;
    const config = (await resp.json()) as { auto_quarantine_other_mcp_servers?: boolean };
    return Boolean(config.auto_quarantine_other_mcp_servers);
  } catch {
    return null;
  }
}

export async function pollQuarantineConfig(): Promise<void> {
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

/**
 * Run the quarantine workflow on demand (used by the debug window).
 * Uses the existing monitor if running; otherwise creates a temporary one.
 * Shows the quarantine dialog for any newly-quarantined servers.
 */
export async function runDebugQuarantine(): Promise<{ success: boolean; error?: string }> {
  try {
    async function handleQuarantineEvents(events: unknown[]): Promise<void> {
      if (events.length === 0) return;
      const apiBaseUrl = getApiBaseUrl();
      const creds = getCredentialsForEnv();
      let isAdminOrOwner = false;
      if (apiBaseUrl && creds?.apiKey) {
        try {
          const role = await fetchUserRole(apiBaseUrl, creds.apiKey);
          isAdminOrOwner = role === "admin" || role === "owner";
        } catch { /* treat as regular user */ }
      }
      const parentWindow = getMainWindowFn?.() ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await showQuarantinedServersDialog(events as any, parentWindow, isAdminOrOwner);
    }

    if (configMonitor) {
      // Monitor already running — its persistent "serversQuarantined" listener
      // (from startQuarantineMonitor) already shows the dialog, so just trigger
      // the workflow directly without adding a second listener.
      await configMonitor.runQuarantineWorkflow();
    } else {
      // No monitor running — spin up a temporary one for this single run
      const tempMonitor = new McpConfigMonitor(new SeenServersStore());
      tempMonitor.on("error", (err) => {
        slog(`[Quarantine] tempMonitor error (debug run): ${err}`);
        console.error("[runDebugQuarantine] Monitor error:", err);
      });
      tempMonitor.once("serversQuarantined", (events) => {
        handleQuarantineEvents(events).catch((err) => {
          slog(`[Quarantine] Failed to show quarantine dialog (debug run): ${err}`);
          console.error("[runDebugQuarantine] Failed to show quarantine dialog:", err);
        });
      });
      await tempMonitor.runQuarantineWorkflow();
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
