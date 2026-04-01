/**
 * Claude Cowork MCP discovery and server deduplication helpers.
 * Kept separate from mcpDiscovery.ts to stay within line limits.
 */
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { dirname, join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'
import { clientAlias } from './serverDeduplication'

// Claude Cowork config path — same file as Claude Desktop; Cowork is detected
// via the presence of the vm_bundles/ subdirectory (downloaded on first Cowork launch).
// https://support.claude.com/en/articles/13345190-get-started-with-cowork
export function getClaudeCoworkConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      )
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json'
      )
    default:
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

// Parse Claude Cowork config — same shape as Claude Desktop (mcpServers key)
// Exported for testing
export async function parseClaudeCoworkConfig(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'claude-cowork',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

export async function discoverClaudeCowork(): Promise<DiscoveredMcpServer[]> {
  try {
    const configPath = getClaudeCoworkConfigPath()
    // Guard: only present when Cowork is installed (vm_bundles/ is downloaded on first launch)
    const vmBundlesDir = join(dirname(configPath), 'vm_bundles')
    await fs.access(vmBundlesDir)
    await fs.access(configPath)
    return await parseClaudeCoworkConfig(configPath)
  } catch {
    return []
  }
}

/**
 * Deduplicate discovered MCP servers by name + config.
 *
 * - Entries with the same name AND identical config (command/args/url) are
 *   collapsed into one (true duplicates across clients).
 * - Entries with the same name but different configs are kept but renamed
 *   `name_2`, `name_3`, … so every entry has a unique name.
 */
export function deduplicateByNameAndConfig(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
  const byName = new Map<string, DiscoveredMcpServer[]>()
  for (const server of servers) {
    const group = byName.get(server.name) ?? []
    group.push(server)
    byName.set(server.name, group)
  }

  const configKey = (s: DiscoveredMcpServer): string => {
    const c = s.config
    if ('command' in c && c.command) return JSON.stringify({ command: c.command, args: c.args ?? [] })
    if ('url' in c) return JSON.stringify({ url: c.url })
    return JSON.stringify(c)
  }

  const result: DiscoveredMcpServer[] = []
  for (const [, group] of byName) {
    if (group.length === 1) { result.push({ ...group[0], clients: [group[0].client] }); continue }

    // Collapse true duplicates (same name + same config), merging clients.
    const seen = new Map<string, DiscoveredMcpServer>()
    for (const server of group) {
      const key = configKey(server)
      const existing = seen.get(key)
      if (existing) {
        const clients = existing.clients ?? [existing.client]
        if (!clients.includes(server.client)) clients.push(server.client)
        existing.clients = clients
      } else {
        seen.set(key, { ...server, clients: [server.client] })
      }
    }

    const unique = [...seen.values()]
    if (unique.length === 1) {
      result.push(unique[0])
    } else {
      // Different configs under the same name — rename all to name_clientAlias
      for (const entry of unique) {
        const alias = clientAlias(entry.client)
        result.push({ ...entry, name: `${entry.name}_${alias}`, originalName: entry.name })
      }
    }
  }

  return result
}
