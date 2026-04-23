/**
 * Server deduplication logic for discovered MCP servers.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import type { DiscoveredMcpServer, McpClientId, McpServerConfig } from "./mcpDiscovery";

export interface DuplicateGroup {
  fingerprint: string;
  /** "same-config" = different names, same config. "name-conflict" = same original name, different configs (auto-renamed). "profile-conflict" = same agent, same name, different profiles. */
  kind: "same-config" | "name-conflict" | "profile-conflict";
  servers: Array<{ name: string; originalName?: string; client: McpClientId; clients?: McpClientId[]; config: McpServerConfig; profileName?: string }>;
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
      // Detect profile conflicts: same agent, same original name, different profiles
      const isProfileConflict = group.length > 1
        && new Set(group.map((s) => s.client)).size === 1
        && group.some((s) => s.profileName);
      groups.push({
        fingerprint: isProfileConflict ? `profile-conflict:${origName}` : `name-conflict:${origName}`,
        kind: isProfileConflict ? "profile-conflict" : "name-conflict",
        servers: group.map((s) => ({ name: s.name, originalName: s.originalName, client: s.client, clients: s.clients, config: s.config, profileName: s.profileName })),
      });
    }
  }

  return groups;
}

/**
 * Build a map from deduped server name → the raw (pre-dedup) server instances
 * that should be removed when this deduped entry is submitted.
 *
 * When all raw entries with the same name have identical configs, dedup merges
 * them into a single entry - the removal map points to all of them (remove from
 * every agent config).
 *
 * When configs differ, dedup renames each one (adds originalName). In that case
 * each deduped entry should only remove the raw entries it actually represents,
 * matched by config + path + projectName + profileName to avoid double-removal.
 */
export function buildRemovalMap(
  raw: DiscoveredMcpServer[],
  deduped: DiscoveredMcpServer[],
): Map<string, DiscoveredMcpServer[]> {
  // Deduplicate raw entries so the same server at the same file path is never
  // removed twice. Multiple discovery paths can find the same config file
  // (e.g. Cursor global + workspace storage pointing at the same project).
  const seenRaw = new Set<string>();
  const uniqueRaw: DiscoveredMcpServer[] = [];
  for (const s of raw) {
    const key = `${s.name}\0${s.path}\0${s.projectName ?? ''}\0${s.profileName ?? ''}`;
    if (!seenRaw.has(key)) {
      seenRaw.add(key);
      uniqueRaw.push(s);
    }
  }

  // Group raw servers by name (original name in config)
  const rawByName = new Map<string, DiscoveredMcpServer[]>();
  for (const s of uniqueRaw) {
    const group = rawByName.get(s.name) ?? [];
    group.push(s);
    rawByName.set(s.name, group);
  }

  const map = new Map<string, DiscoveredMcpServer[]>();
  for (const server of deduped) {
    const origName = server.originalName ?? server.name;
    const rawEntries = rawByName.get(origName) ?? [];

    if (server.originalName) {
      // Dedup renamed this server - configs differ across raw entries.
      // Match only the raw entries that correspond to this specific deduped server.
      const matched = rawEntries.filter((r) =>
        configsEqual(r.config, server.config)
        && r.path === server.path
        && r.projectName === server.projectName
        && r.profileName === server.profileName
      );
      map.set(server.name, matched.length > 0 ? matched : [server]);
    } else {
      // No rename - all raw entries have identical configs, remove from all.
      map.set(server.name, rawEntries);
    }
  }
  return map;
}

/** Short contiguous alias for each client, used in name suffixes for same-name conflicts. */
export const CLIENT_SHORT_ALIAS: Record<string, string> = {
  'vscode': 'vscode',
  'cursor': 'cursor',
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
      // Configs differ - suffix each to disambiguate.
      // If all from different clients, use name_clientAlias.
      // If some share a client (e.g. same server in multiple Claude Code profiles),
      // use numeric suffixes: name_ccode_1, name_ccode_2, etc.
      const clientSet = new Set(group.map((s) => s.client));
      if (clientSet.size === group.length) {
        for (const s of group) {
          result.push({ ...s, name: `${s.name}_${clientAlias(s.client)}`, originalName: s.name, clients: s.clients ?? [s.client] });
        }
      } else {
        const clientCounter = new Map<string, number>();
        for (const s of group) {
          const alias = clientAlias(s.client);
          const count = (clientCounter.get(alias) ?? 0) + 1;
          clientCounter.set(alias, count);
          const hasSameClient = group.filter((o) => o.client === s.client).length > 1;
          const suffix = count > 1 || hasSameClient ? `${alias}_${count}` : alias;
          result.push({ ...s, name: `${s.name}_${suffix}`, originalName: s.name, clients: s.clients ?? [s.client] });
        }
      }
    }
  }
  return result;
}
