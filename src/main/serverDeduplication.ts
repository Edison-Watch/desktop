/**
 * Server deduplication logic for discovered MCP servers.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "./mcpDiscovery";

export interface DuplicateGroup {
  fingerprint: string;
  /** "same-config" = different names, same config. "name-conflict" = same original name, different configs (auto-renamed). */
  kind: "same-config" | "name-conflict";
  servers: Array<{ name: string; originalName?: string; client: McpClientId; clients?: McpClientId[]; config: McpServerConfig }>;
}

/** Recursively sort object keys for stable JSON comparison. */
function sortedStringify(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
}

/** Normalized key from a config, suitable for cross-name duplicate detection. */
export function configFingerprint(config: McpServerConfig): string {
  return sortedStringify(config);
}

/**
 * Find all duplicate groups:
 * 1. Different names, same config (aliases)
 * 2. Same original name, different configs (auto-renamed to name_alias)
 */
export function findDuplicateGroups(servers: DiscoveredMcpServer[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  // Case 1: Different names, same config
  const byFp = new Map<string, DiscoveredMcpServer[]>();
  for (const s of servers) {
    const fp = configFingerprint(s.config);
    const group = byFp.get(fp) ?? [];
    group.push(s);
    byFp.set(fp, group);
  }
  for (const [fp, group] of byFp) {
    if (new Set(group.map((s) => s.name)).size > 1) {
      groups.push({
        fingerprint: fp,
        kind: "same-config",
        servers: group.map((s) => ({ name: s.name, originalName: s.originalName, client: s.client, clients: s.clients, config: s.config })),
      });
    }
  }

  // Case 2: Same original name, different configs (auto-renamed servers)
  const byOrigName = new Map<string, DiscoveredMcpServer[]>();
  for (const s of servers) {
    if (!s.originalName) continue;
    const group = byOrigName.get(s.originalName) ?? [];
    group.push(s);
    byOrigName.set(s.originalName, group);
  }
  for (const [origName, group] of byOrigName) {
    if (group.length > 1) {
      groups.push({
        fingerprint: `name-conflict:${origName}`,
        kind: "name-conflict",
        servers: group.map((s) => ({ name: s.name, originalName: s.originalName, client: s.client, clients: s.clients, config: s.config })),
      });
    }
  }

  return groups;
}

/**
 * Build a map from deduped server name → all raw (pre-dedup) server instances.
 * This allows removing a server from ALL agent configs, not just the first one.
 */
export function buildRemovalMap(
  raw: DiscoveredMcpServer[],
  deduped: DiscoveredMcpServer[],
): Map<string, DiscoveredMcpServer[]> {
  // Group raw servers by name (original name in config)
  const rawByName = new Map<string, DiscoveredMcpServer[]>();
  for (const s of raw) {
    const group = rawByName.get(s.name) ?? [];
    group.push(s);
    rawByName.set(s.name, group);
  }

  const map = new Map<string, DiscoveredMcpServer[]>();
  for (const server of deduped) {
    // The original name (before any dedup suffix) maps to the raw entries
    const origName = server.originalName ?? server.name;
    const rawEntries = rawByName.get(origName) ?? [];
    map.set(server.name, rawEntries);
  }
  return map;
}

/** Short contiguous alias for each client, used in name suffixes for same-name conflicts. */
export const CLIENT_SHORT_ALIAS: Record<string, string> = {
  'vscode': 'vscode',
  'cursor': 'cursor',
  'claude-desktop': 'cdesktop',
  'claude-cowork': 'ccowork',
  'claude-code': 'ccode',
  'windsurf': 'windsurf',
  'zed': 'zed',
  'codex': 'codex',
  'intellij': 'intellij',
  'pycharm': 'pycharm',
  'webstorm': 'webstorm',
};

export function clientAlias(clientId: string): string {
  return CLIENT_SHORT_ALIAS[clientId] ?? clientId;
}

/** Compare two McpServerConfig objects for structural equality (ignoring key order). */
export function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return sortedStringify(a) === sortedStringify(b);
}

/**
 * Deduplicate discovered servers that share the same name across clients.
 * - Identical configs → keep the first one (single submission).
 * - Different configs → rename both to `name_client` (e.g. sqlite_vscode, sqlite_cursor).
 */
export function deduplicateServers(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
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
      result.push({ ...group[0], clients: group[0].clients ?? [group[0].client] });
      continue;
    }

    // Check if all configs in the group are identical
    const allSame = group.every((s) => configsEqual(s.config, group[0].config));
    if (allSame) {
      // Keep just the first one, merge all clients
      const clients = [...new Set(group.flatMap((s) => s.clients ?? [s.client]))];
      result.push({ ...group[0], clients });
    } else {
      // Configs differ — suffix each with its client alias
      for (const s of group) {
        result.push({ ...s, name: `${s.name}_${clientAlias(s.client)}`, originalName: s.name, clients: s.clients ?? [s.client] });
      }
    }
  }
  return result;
}
