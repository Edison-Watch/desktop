/**
 * IPC handlers for MCP server discovery, submission, and removal.
 *
 * Extracted from ipcHandlers.ts to stay under the 800-line CI limit.
 */

import { app, ipcMain } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

const execFileAsync = promisify(execFile);

import { discoverMcpServers, describeUnsupportedReason } from "../discovery/mcpDiscovery";
import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "../discovery/mcpDiscovery";
import { submitServersViaDetectord, resubmitServerViaDetectord } from "../detectord/submit";
import { removeServerFromConfig } from "../runtime/mcpConfigActions";
import { quarantineCursorPlugin } from "../clients/cursor/quarantinePlugins";
import {
  fetchUserRole,
  submitServerRequest,
  submitServerWithOverrides,
  approveServerRequest,
  fetchBackendFingerprints,
  findBackendFingerprintMatch,
  type BackendFingerprintEntry,
} from "../discovery/mcpServerSubmit";
import { detectSecrets } from "../discovery/secretDetection";
import type { TemplatizedConfig } from "../discovery/secretDetection";
import { filterOutEdisonWatchServers } from "../runtime/mcpConfigMonitor";
import { applyAppIntegrations } from "../runtime/mcpConfigWriter";
import { deduplicateServers, findDuplicateGroups } from "../discovery/serverDeduplication";
import { DRY_RUN, getApiBaseUrl, getSetupData, getCredentialsForEnv } from "../infra/setupConfig";
import { getSharedSeenStore } from "../discovery/seenServersStore";
import { getCachedOrgId, refreshOrgIdFromBackend } from "../infra/orgIdCache";
import { logClaudeCmd } from "../runtime/monitorLog";

/**
 * Caller's org_id for seen-store writes: cached if warm, else an inline backend
 * refresh. Explicit apiBaseUrl/apiKey lets onboarding work before
 * getCredentialsForEnv() is populated (keychain not written yet).
 */
async function getOrRefreshOrgId(
  apiBaseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): Promise<string | null> {
  const cached = getCachedOrgId();
  if (cached) {
    console.log(`[mcp:submit] org_id cache hit: ${cached}`);
    return cached;
  }
  if (!apiBaseUrl || !apiKey) {
    console.warn(`[mcp:submit] org_id cache miss and no apiBaseUrl/apiKey available to refresh`);
    return null;
  }
  console.log(`[mcp:submit] org_id cache miss - refreshing from ${apiBaseUrl}`);
  const orgId = await refreshOrgIdFromBackend(apiBaseUrl, apiKey);
  if (!orgId) console.warn(`[mcp:submit] org_id refresh returned null - /user/profile is missing org_id`);
  return orgId;
}

/** Remove or disable a server from its config. Cursor plugins are disabled via project dir renames.
 *  Claude Code project-scoped servers are removed via `claude mcp remove` CLI. */
async function removeOrDisableServer(server: DiscoveredMcpServer): Promise<void> {
  if (server.source === 'plugin' && server.client === 'cursor') {
    await quarantineCursorPlugin(server);
  } else if (server.client === 'claude-code' && server.source === 'project' && server.projectName) {
    const name = server.originalName ?? server.name;
    console.log(`[MCP Config] Removing Claude Code project-scoped server "${name}" via CLI (project=${server.projectName})`);
    const removeArgs = ['mcp', 'remove', name];
    logClaudeCmd(removeArgs, { cwd: server.projectName });
    await execFileAsync('claude', removeArgs, {
      timeout: 10_000,
      cwd: server.projectName,
    });
    console.log(`[MCP Config] Removed "${name}" via claude mcp remove`);
  } else {
    await removeServerFromConfig(server);
  }
}

// ── Discovery cache ─────────────────────────────────────────────────────
// Populated by mcp:discover; consumed by submit/resubmit so they never re-discover.
let discoveryCache: { servers: DiscoveredMcpServer[]; raw: DiscoveredMcpServer[]; unsupported: DiscoveredMcpServer[] } | null = null;

/** Run discovery, populate cache, return filtered+deduped servers. */
async function runDiscovery() {
  const { servers, raw, unsupported } = await discoverMcpServers({ includeRaw: true });
  const filtered = filterOutEdisonWatchServers(servers);
  const rawFiltered = filterOutEdisonWatchServers(raw);
  discoveryCache = { servers: filtered, raw: rawFiltered, unsupported };
  return discoveryCache;
}

/** Get cached discovery or return empty if cache is not populated. */
function getCachedDiscovery() {
  return discoveryCache ?? { servers: [] as DiscoveredMcpServer[], raw: [] as DiscoveredMcpServer[], unsupported: [] as DiscoveredMcpServer[] };
}

/**
 * Fingerprint already on the backend: skip the submit, but still update the
 * seen-store (so quarantine recognises it) and remove the local config entry so
 * traffic flows through Edison Watch. `removalMap` omitted (single-server path)
 * falls back to removing the discovered server itself.
 */
async function handleAlreadyOnBackend(
  server: DiscoveredMcpServer,
  match: BackendFingerprintEntry,
  apiBaseUrl: string,
  apiKey: string,
  removalMap?: Map<string, DiscoveredMcpServer[]>,
): Promise<void> {
  const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
  if (orgId) {
    try {
      await getSharedSeenStore().markSeen(orgId, server, match.status);
    } catch { /* non-fatal */ }
  }
  const entries = removalMap?.get(server.name) ?? [server];
  for (const entry of entries) {
    try { await removeOrDisableServer(entry); } catch { /* non-fatal */ }
  }
}

export function registerMcpSubmitHandlers(): void {
  ipcMain.handle("mcp:discover", async () => {
    const { servers, unsupported } = await runDiscovery();
    console.log(`[mcp:discover] Found ${servers.length} servers, ${unsupported.length} unsupported`);
    for (const s of servers) {
      console.log(`[mcp:discover]   supported: ${s.name}@${s.client} source=${s.source} path=${s.path}`);
    }
    for (const s of unsupported) {
      const reason = describeUnsupportedReason(s) ?? 'unknown';
      console.log(`[mcp:discover]   unsupported: ${s.name}@${s.client} source=${s.source} path=${s.path} reason=${reason}`);
    }
    return { servers, unsupported };
  });

  ipcMain.handle("mcp:findDuplicates", async () => {
    const { servers } = getCachedDiscovery();
    return findDuplicateGroups(servers);
  });

  /** Resubmit a single server under a new name.
   *  Uses discovery cache + passed config as fallback. */
  ipcMain.handle("mcp:resubmitServer", async (_event, params: {
    originalName: string;
    newName: string;
    apiKey?: string;
    apiBaseUrl?: string;
    userId?: string;
    config?: Record<string, unknown>;
    client?: string;
    configPath?: string;
    source?: string;
  }): Promise<{ success: boolean; error?: string }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;

    if (!apiKey || !apiBaseUrl) {
      return { success: false, error: "Not signed in or server URL not configured." };
    }

    // Resubmit-under-new-name is a daemon disposition with rename. Pass client
    // through as-is (may be undefined) so the daemon matches by name alone when
    // it's omitted, preserving the optional-client contract.
    return resubmitServerViaDetectord(params.originalName, params.newName, params.client);
  });

  /** Remove specific servers from their agent config files.
   *  Accepts either plain names (removes from ALL agents) or {name, client} pairs (targeted removal).
   *  Names can be dedup-renamed (e.g. "same_cursor") - resolved back to raw names via the deduped cache. */
  ipcMain.handle("mcp:removeServers", async (_event, targets: Array<string | { name: string; client: string }>): Promise<{
    removed: string[];
    errors: string[];
  }> => {
    // The daemon owns removal. Servers the user didn't send to EW are
    // auto-quarantined once enforcement arms at setup:complete, so there's
    // nothing for the client to remove here.
    const names = targets.map((t) => (typeof t === "string" ? t : t.name));
    console.log(`[detectord] removeServers no-op (daemon quarantines when armed): ${names.join(", ")}`);
    return { removed: [], errors: [] };
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
    configs: Array<{ configPath: string; backupPath: string; appId?: string }>;
  }): Promise<{ reverted: number; errors: string[] }> => {
    const { configs } = args;
    let reverted = 0;
    const errors: string[] = [];
    const allowedDirs = [homedir(), app.getPath("userData")];
    const isAllowedPath = (p: string): boolean =>
      allowedDirs.some((dir) => resolve(p).startsWith(dir + sep));

    for (const { configPath, backupPath, appId } of configs) {
      try {
        // Claude Code: use CLI to remove instead of backup restore
        if (appId === "claude-code" && !backupPath) {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          const revertArgs = ["mcp", "remove", "edison-watch", "-s", "user"];
          logClaudeCmd(revertArgs);
          await execFileAsync("claude", revertArgs, { timeout: 10_000 });
          reverted++;
          console.log("[MCP Revert] Removed edison-watch from Claude Code via CLI");
          continue;
        }

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
  ipcMain.handle("mcp:analyzeSecrets", async (_event, params?: { skipServers?: string[] }): Promise<Array<{
    name: string;
    client: string;
    source: string;
    config: McpServerConfig;
    templatized: TemplatizedConfig;
  }>> => {
    const { servers: cached } = getCachedDiscovery();
    const allServers = deduplicateServers(cached);
    const skipSet = new Set(params?.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    return servers.map((server) => ({
      name: server.name,
      client: server.client,
      source: server.source,
      config: server.config,
      templatized: detectSecrets(server),
    }));
  });

  // Analyze secrets for a single server (used by quarantine/registration dialogs)
  ipcMain.handle("mcp:analyzeServerSecrets", async (_event, params: {
    serverName: string;
    sourceApp: string;
    config: Record<string, unknown>;
    configPath: string;
  }) => {
    const server: DiscoveredMcpServer = {
      name: params.serverName,
      client: params.sourceApp as McpClientId,
      source: "user",
      path: params.configPath,
      config: params.config as McpServerConfig,
    };
    const result = detectSecrets(server);
    return {
      config: params.config,
      templatizedConfig: result.config,
      templateFields: result.templateFields,
      secretValues: result.secretValues,
    };
  });

  // Submit servers with user-defined template overrides
  ipcMain.handle("mcp:submitWithTemplates", async (_event, params: {
    apiKey?: string;
    apiBaseUrl?: string;
    userId?: string;
    skipServers?: string[];
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
    alreadyOnBackend: number;
    total: number;
    servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
    error?: string;
    errors?: string[];
    failures?: Array<{ name: string; client: string; reason: "conflict" | "error" | "already-on-backend"; message: string; config?: Record<string, unknown>; configPath?: string; backendStatus?: "registered" | "requested" }>;
  }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, alreadyOnBackend: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const { servers: cached } = getCachedDiscovery();
    const allServers = deduplicateServers(cached);
    const skipSet = new Set(params.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;

    // The daemon owns submit. Pass the credential-review overrides so the user's
    // manual redactions are honored (the daemon still auto-templatizes on top).
    const summary = await submitServersViaDetectord(servers, params.templateOverrides);
    console.log(`[detectord] onboarding submit (with template overrides): ${summary.submitted} submitted, ${summary.failures.length} failed`);
    return summary;
  });

  // Submit all discovered MCP servers for approval
  ipcMain.handle("mcp:submitAllDiscovered", async (_event, params?: {
    apiKey?: string;
    apiBaseUrl?: string;
    userId?: string;
    skipServers?: string[];
  }): Promise<{
    submitted: number;
    autoApproved: number;
    skipped: number;
    alreadyOnBackend: number;
    total: number;
    servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
    error?: string;
    errors?: string[];
    failures?: Array<{ name: string; client: string; reason: "conflict" | "error" | "already-on-backend"; message: string; config?: Record<string, unknown>; configPath?: string; backendStatus?: "registered" | "requested" }>;
  }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params?.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params?.apiBaseUrl || setup.apiBaseUrl;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, alreadyOnBackend: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const { servers: cached } = getCachedDiscovery();

    // Deduplicate servers with the same name across different clients.
    const allServers = deduplicateServers(cached);
    const skipSet = new Set(params?.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;

    // The daemon owns submit (and handles stdio). Route each registration
    // through it instead of the client's http-only submit path.
    const summary = await submitServersViaDetectord(servers);
    console.log(`[detectord] onboarding submit: ${summary.submitted} submitted, ${summary.failures.length} failed`);
    return summary;
  });

  // Handle individual server actions from the registration/quarantine dialogs
  ipcMain.handle("mcp:handleServerAction", async (_event, params: {
    fingerprint: string;
    serverName: string;
    sourceApp: string;
    action: string;
    config: Record<string, unknown>;
    configPath: string;
    source?: string;
    templateOverrides?: Array<{
      entryId: string;
      varName: string;
      selectedText: string;
      start: number;
      end: number;
    }>;
  }) => {
    // Only submit for registration/request actions - skip dismissed/skipped servers
    if (params.action !== "registered" && params.action !== "requested") {
      return { action: params.action };
    }

    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl();

    if (!apiKey || !apiBaseUrl) {
      throw new Error("Not signed in or server URL not configured.");
    }

    const server: DiscoveredMcpServer = {
      name: params.serverName,
      client: params.sourceApp as McpClientId,
      source: (params.source as DiscoveredMcpServer['source']) || "user",
      path: params.configPath,
      config: params.config as McpServerConfig,
    };

    // Preflight: if the fingerprint is already on the backend, skip the submit
    // (same server) and just sync local state, guarding a double-acknowledge.
    const backendIndex = await fetchBackendFingerprints(apiBaseUrl, apiKey);
    const backendMatch = findBackendFingerprintMatch(server, backendIndex);
    if (backendMatch) {
      await handleAlreadyOnBackend(server, backendMatch, apiBaseUrl, apiKey);
      return {
        action: params.action,
        alreadyOnBackend: true,
        backendStatus: backendMatch.status,
        existingName: backendMatch.name,
      };
    }

    const submitResult = params.templateOverrides && params.templateOverrides.length > 0
      ? await submitServerWithOverrides(server, params.templateOverrides, apiBaseUrl, apiKey, setup.userId)
      : await submitServerRequest(server, apiBaseUrl, apiKey, setup.userId);

    if (submitResult.alreadyPending) {
      return { action: params.action, alreadyPending: true };
    }
    if (submitResult.alreadyExists) {
      return { action: params.action, alreadyExists: true, errorMessage: submitResult.errorMessage };
    }

    const { request_id } = submitResult;

    // Auto-approve if user is admin/owner and action is "registered".
    // The backend already auto-approves admin/owner submissions, so honour
    // submitResult.autoApproved first and skip the redundant approve call.
    let autoApproved = submitResult.autoApproved === true;
    let approveError: string | undefined;
    if (!autoApproved && params.action === "registered") {
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

    // Mark in seen store so quarantine recognises it as known
    const seenAction = autoApproved ? "registered" : "requested";
    {
      const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
      if (orgId) {
        try { await getSharedSeenStore().markSeen(orgId, server, seenAction as "registered" | "requested"); } catch { /* non-fatal */ }
      } else {
        console.warn(`[mcp:submit] No org_id available - "${server.name}" won't be marked as seen; next detection will prompt.`);
      }
    }

    // Remove server from config after successful submission
    try { await removeOrDisableServer(server); } catch { /* non-fatal - quarantine manager handles fallback */ }

    return { request_id, action: params.action, autoApproved, approveError };
  });
}
