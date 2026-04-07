/**
 * IPC handlers for MCP server discovery, submission, and removal.
 *
 * Extracted from ipcHandlers.ts to stay under the 800-line CI limit.
 */

import { app, ipcMain } from "electron";
import { promises as fs } from "fs";
import { homedir } from "os";
import { resolve, sep } from "path";

import { discoverMcpServers } from "./mcpDiscovery";
import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "./mcpDiscovery";
import { removeServerFromConfig, quarantineCursorPlugin } from "./mcpConfigActions";
import { fetchUserRole, submitServerRequest, submitServerWithOverrides, approveServerRequest } from "./mcpServerSubmit";
import { detectSecrets } from "./secretDetection";
import type { TemplatizedConfig } from "./secretDetection";
import { filterOutEdisonWatchServers } from "./mcpConfigMonitor";
import { applyAppIntegrations } from "./mcpConfigWriter";
import { deduplicateServers, findDuplicateGroups, buildRemovalMap } from "./serverDeduplication";
import { DRY_RUN, getApiBaseUrl, getSetupData, getCredentialsForEnv } from "./setupConfig";

/** Remove or disable a server from its config. Cursor plugins are disabled via project dir renames. */
async function removeOrDisableServer(server: DiscoveredMcpServer): Promise<void> {
  if (server.source === 'plugin' && server.client === 'cursor') {
    await quarantineCursorPlugin(server);
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

export function registerMcpSubmitHandlers(): void {
  ipcMain.handle("mcp:discover", async () => {
    const { servers, unsupported } = await runDiscovery();
    console.log("[mcp:discover] Found", servers.length, "servers,", unsupported.length, "unsupported");
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
  }): Promise<{ success: boolean; error?: string }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;
    const userId = params.userId || setup.userId;

    if (!apiKey || !apiBaseUrl) {
      return { success: false, error: "Not signed in or server URL not configured." };
    }

    // Use cache first, fall back to passed config
    const { servers: cached, raw: cachedRaw } = getCachedDiscovery();
    let server: DiscoveredMcpServer | undefined = cached.find((s) => s.name === params.originalName);
    const rawEntries = cachedRaw.filter((s) => s.name === (server?.originalName ?? params.originalName));

    if (!server && params.config && params.client) {
      server = {
        name: params.originalName,
        client: params.client as McpClientId,
        source: "user",
        path: params.configPath ?? "",
        config: params.config as McpServerConfig,
      };
    }
    if (!server) {
      return { success: false, error: `Server "${params.originalName}" not found.` };
    }

    try {
      const renamed = { ...server, name: params.newName, originalName: server.name };
      const result = await submitServerRequest(renamed, apiBaseUrl, apiKey, userId);
      console.log(`[mcp:resubmitServer] Submit result for "${params.newName}":`, JSON.stringify(result));
      if (result.alreadyPending) {
        return { success: false, error: `"${params.newName}" already has a pending request.` };
      }
      if (result.alreadyExists) {
        return { success: false, error: result.errorMessage ?? `"${params.newName}" already exists.` };
      }

      const role = await fetchUserRole(apiBaseUrl, apiKey);
      if (role === "admin" || role === "owner") {
        try { await approveServerRequest(result.request_id, apiBaseUrl, apiKey); } catch { /* non-fatal */ }
      }

      // Remove from all agent configs if still present (using original name, not renamed)
      const entriesToRemove = rawEntries.length > 0 ? rawEntries : [server];
      for (const entry of entriesToRemove) {
        try { await removeOrDisableServer(entry); } catch { /* non-fatal */ }
      }
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[mcp:resubmitServer] Error:`, msg);
      return { success: false, error: msg };
    }
  });

  /** Remove specific servers from their agent config files.
   *  Accepts either plain names (removes from ALL agents) or {name, client} pairs (targeted removal).
   *  Names can be dedup-renamed (e.g. "same_cursor") — resolved back to raw names via the deduped cache. */
  ipcMain.handle("mcp:removeServers", async (_event, targets: Array<string | { name: string; client: string }>): Promise<{
    removed: string[];
    errors: string[];
  }> => {
    // Use cached raw (pre-dedup) list so we find ALL per-agent instances
    const { servers: deduped, raw: filtered } = getCachedDiscovery();
    const removed: string[] = [];
    const errors: string[] = [];

    // Build lookup sets from targets
    const nameOnly = new Set<string>();
    const nameAndClient = new Set<string>();
    for (const t of targets) {
      if (typeof t === "string") nameOnly.add(t);
      else nameAndClient.add(`${t.name}:${t.client}`);
    }

    // Resolve dedup-renamed names back to original names so they match the raw list.
    // e.g. target "same_cursor" → deduped server with originalName "same" → matches raw server "same"
    for (const s of deduped) {
      if (s.originalName && nameOnly.has(s.name)) {
        nameOnly.add(s.originalName);
      }
      if (s.originalName && nameAndClient.has(`${s.name}:${s.client}`)) {
        nameAndClient.add(`${s.originalName}:${s.client}`);
      }
    }

    for (const server of filtered) {
      const matchByName = nameOnly.has(server.name);
      const matchByPair = nameAndClient.has(`${server.name}:${server.client}`);
      if (!matchByName && !matchByPair) continue;
      try {
        await removeOrDisableServer(server);
        removed.push(`${server.name} (${server.client})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${server.name} [${server.client}]: ${msg}`);
      }
    }
    return { removed, errors };
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
          await execFileAsync("claude", ["mcp", "remove", "edison-watch", "-s", "user"], { timeout: 10_000 });
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
    total: number;
    servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
    error?: string;
    errors?: string[];
    failures?: Array<{ name: string; client: string; reason: "conflict" | "error"; message: string; config?: Record<string, unknown>; configPath?: string }>;
  }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;
    const userId = params.userId || setup.userId;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const { servers: cached, raw: cachedRaw } = getCachedDiscovery();
    const allServers = deduplicateServers(cached);
    const skipSet = new Set(params.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    const removalMap = buildRemovalMap(cachedRaw, servers);

    const serverList = servers.map((s) => ({ name: s.name, client: s.client, clients: s.clients, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    const errors: string[] = [];
    const failures: Array<{ name: string; client: string; reason: "conflict" | "error"; message: string; config?: Record<string, unknown>; configPath?: string }> = [];

    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";

    for (const server of servers) {
      try {
        const overrides = params.templateOverrides[server.name];
        const submitResult = overrides
          ? await submitServerWithOverrides(server, overrides, apiBaseUrl, apiKey, userId)
          : await submitServerRequest(server, apiBaseUrl, apiKey, userId);

        if (submitResult.alreadyPending) continue;
        if (submitResult.alreadyExists) {
          failures.push({
            name: server.name,
            client: server.client,
            reason: "conflict",
            message: submitResult.errorMessage ?? "A server with this name already exists",
            config: server.config as unknown as Record<string, unknown>,
            configPath: server.path,
          });
          continue;
        }
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

        // Remove from ALL agent configs, not just the first
        const rawEntries = removalMap.get(server.name) ?? [server];
        for (const entry of rawEntries) {
          try { await removeOrDisableServer(entry); } catch { /* non-fatal */ }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ name: server.name, client: server.client, reason: "error", message: msg, config: server.config as unknown as Record<string, unknown>, configPath: server.path });
      }
    }
    return {
      submitted, autoApproved,
      skipped: servers.length - submitted - failures.length,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : undefined,
      failures: failures.length > 0 ? failures : undefined,
    };
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
    total: number;
    servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
    error?: string;
    errors?: string[];
    failures?: Array<{ name: string; client: string; reason: "conflict" | "error"; message: string; config?: Record<string, unknown>; configPath?: string }>;
  }> => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params?.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params?.apiBaseUrl || setup.apiBaseUrl;
    const userId = params?.userId || setup.userId;

    if (!apiKey || !apiBaseUrl) {
      return { submitted: 0, autoApproved: 0, skipped: 0, total: 0,
        error: "Not signed in or server URL not configured." };
    }

    const { servers: cached, raw: cachedRaw } = getCachedDiscovery();

    // Deduplicate servers with the same name across different clients.
    const allServers = deduplicateServers(cached);
    const skipSet = new Set(params?.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    const removalMap = buildRemovalMap(cachedRaw, servers);

    const serverList = servers.map((s) => ({ name: s.name, client: s.client, clients: s.clients, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    const errors: string[] = [];
    const failures: Array<{ name: string; client: string; reason: "conflict" | "error"; message: string; config?: Record<string, unknown>; configPath?: string }> = [];

    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";

    for (const server of servers) {
      try {
        const submitResult = await submitServerRequest(server, apiBaseUrl, apiKey, userId);
        if (submitResult.alreadyPending) continue;
        if (submitResult.alreadyExists) {
          failures.push({
            name: server.name,
            client: server.client,
            reason: "conflict",
            message: submitResult.errorMessage ?? "A server with this name already exists",
            config: server.config as unknown as Record<string, unknown>,
            configPath: server.path,
          });
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

        // Remove from ALL agent configs, not just the first
        const rawEntries = removalMap.get(server.name) ?? [server];
        for (const entry of rawEntries) {
          try {
            await removeOrDisableServer(entry);
          } catch (removeErr) {
            console.error(`[mcp:submitAllDiscovered] Failed to remove "${entry.name}" from ${entry.path}:`, removeErr);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ name: server.name, client: server.client, reason: "error", message: msg, config: server.config as unknown as Record<string, unknown>, configPath: server.path });
        console.error("[mcp:submitAllDiscovered]", `${server.name}: ${msg}`);
      }
    }
    return {
      submitted,
      autoApproved,
      skipped: servers.length - submitted - failures.length,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : undefined,
      failures: failures.length > 0 ? failures : undefined,
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
    templateOverrides?: Array<{
      entryId: string;
      varName: string;
      selectedText: string;
      start: number;
      end: number;
    }>;
  }) => {
    // Only submit for registration/request actions — skip dismissed/skipped servers
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
      source: "user",
      path: params.configPath,
      config: params.config as McpServerConfig,
    };

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

    // Remove server from config after successful submission
    try { await removeOrDisableServer(server); } catch { /* non-fatal — quarantine manager handles fallback */ }

    return { request_id, action: params.action, autoApproved, approveError };
  });
}
