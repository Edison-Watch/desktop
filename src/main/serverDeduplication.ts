/**
 * Server deduplication logic for discovered MCP servers.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import type { DiscoveredMcpServer, McpServerConfig } from "./mcpDiscovery";

/** Compare two McpServerConfig objects for structural equality (ignoring key order). */
export function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
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
