import { BrowserWindow } from "electron";
import { McpConfigMonitor, type PendingQuarantineEvent } from "../runtime/mcpConfigMonitor";
import { getSharedSeenStore } from "../discovery/seenServersStore";
import { syncRegisteredServersFromBackend } from "../discovery/seenServersBackendSync";
import { showQuarantinedServersDialog } from "../dialogs/mcpServerActionDialog";
import { quarantineServer } from "../runtime/mcpConfigActions";
import { fetchUserRole } from "../discovery/mcpServerSubmit";
import { fetchAutoQuarantineEnabled } from "../infra/domainConfig";
import { getApiBaseUrl, getCredentialsForEnv } from "../infra/setupConfig";
import { getCachedOrgId, refreshOrgIdFromBackend } from "../infra/orgIdCache";

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
    slog("[Quarantine] Skipping - missing apiBaseUrl or apiKey");
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

  const seenStore = getSharedSeenStore();
  configMonitor = new McpConfigMonitor(seenStore);

  configMonitor.on("serversPendingQuarantine", async (pendingEvents: PendingQuarantineEvent[]) => {
    slog(`[Quarantine] serversPendingQuarantine event: ${pendingEvents.length} servers - ${pendingEvents.map((e) => e.server.name).join(", ")}`);
    if (pendingEvents.length === 0) return;

    // Refresh the local seen-store from the backend BEFORE deciding what to
    // silently re-quarantine. This keeps the "registered" classification coherent
    // with the org's actual server list (admin/owner approvals from the dashboard,
    // registrations from other clients, etc.) instead of trusting whatever this
    // particular client happened to write to disk in the past. Silently falls
    // back to the existing local state on network/HTTP error.
    await syncRegisteredServersFromBackend();

    // Separate already-known servers (previously submitted/registered) from truly new ones.
    // Known servers are silently quarantined without a prompt - handles re-installs like Cursor plugins.
    //
    // Silent quarantine requires BOTH (a) the seen entry is scoped to the current
    // org (so a 'requested' entry from a previous login can't silently quarantine
    // here) AND (b) the action is registered/requested. When the org_id cache
    // isn't warm yet we try to refresh it inline before falling back to prompting.
    let currentOrgId = getCachedOrgId();
    if (!currentOrgId) {
      const apiBaseUrl = getApiBaseUrl();
      const creds = getCredentialsForEnv();
      if (apiBaseUrl && creds?.apiKey) {
        currentOrgId = await refreshOrgIdFromBackend(apiBaseUrl, creds.apiKey);
      }
    }
    const newEvents: PendingQuarantineEvent[] = [];
    for (const event of pendingEvents) {
      const seen = currentOrgId
        ? await getSharedSeenStore().get(currentOrgId, event.fingerprint)
        : null;
      slog(
        `[Quarantine] decision for ${event.server.name} fp=${event.fingerprint}: ` +
          `orgId=${currentOrgId ?? 'null'}, seen=${seen ? `{org=${seen.org_id}, action=${seen.action}}` : 'null'}`,
      );
      if (
        currentOrgId &&
        seen &&
        seen.org_id === currentOrgId &&
        (seen.action === "registered" || seen.action === "requested")
      ) {
        slog(`[Quarantine] → silently quarantining known server: ${event.server.name} (action=${seen.action})`);
        try {
          await quarantineServer(event.server);
        } catch (err) {
          slog(`[Quarantine] Failed to silently quarantine "${event.server.name}": ${err}`);
        }
      } else {
        if (!currentOrgId) {
          slog(`[Quarantine] → prompting (no cached org_id): "${event.server.name}"`);
        } else if (!seen) {
          slog(`[Quarantine] → prompting (no seen-store entry for this org+fp): "${event.server.name}"`);
        } else {
          slog(`[Quarantine] → prompting (seen action=${seen.action} isn't registered/requested): "${event.server.name}"`);
        }
        newEvents.push(event);
      }
    }

    if (newEvents.length === 0) {
      slog("[Quarantine] All servers were known - no dialog needed");
      return;
    }

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
    try {
      const results = await showQuarantinedServersDialog(newEvents, parentWindow ?? undefined, isAdminOrOwner);
      // After dialog closes, quarantine all servers that were NOT successfully submitted.
      // Successfully submitted servers are already removed by mcp:handleServerAction/resubmitServer.
      // Match by fingerprint since the server may have been renamed during resubmit.
      const submittedFingerprints = new Set(
        results
          .filter((r) => r.action === "registered" || r.action === "requested")
          .map((r) => r.fingerprint)
      );
      for (const { server, fingerprint } of newEvents) {
        if (submittedFingerprints.has(fingerprint)) continue; // already handled by submit
        try {
          await quarantineServer(server);
          slog(`[Quarantine] Quarantined skipped/dismissed server: ${server.name}`);
        } catch (err) {
          slog(`[Quarantine] Failed to quarantine "${server.name}": ${err}`);
        }
      }
    } catch (err) {
      slog(`[Quarantine] Failed to show quarantine dialog: ${err}`);
      console.error("[McpConfigMonitor] Failed to show quarantine dialog:", err);
      // Dialog failed - quarantine all pending servers as safety fallback
      for (const { server } of newEvents) {
        try { await quarantineServer(server); } catch { /* best effort */ }
      }
    }
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

const QUARANTINE_POLL_INTERVAL_MS = 5 * 60_000; // 5 min - safety-net only; SSE push is primary
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
      // Monitor already running - its persistent "serversPendingQuarantine" listener
      // (from startQuarantineMonitor) already shows the dialog, so just trigger
      // the workflow directly without adding a second listener.
      await configMonitor.runQuarantineWorkflow();
    } else {
      // No monitor running - spin up a temporary one for this single run
      const tempMonitor = new McpConfigMonitor(getSharedSeenStore());
      tempMonitor.on("error", (err) => {
        slog(`[Quarantine] tempMonitor error (debug run): ${err}`);
        console.error("[runDebugQuarantine] Monitor error:", err);
      });
      tempMonitor.once("serversPendingQuarantine", (events) => {
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
