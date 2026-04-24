/**
 * Zed MCP server discovery.
 */

import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'

// ── Path helpers ─────────────────────────────────────────────────────────────

/** Zed config path (MCP servers in assistant.mcp_servers) */
export function getZedConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), '.config', 'zed', 'settings.json')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Zed',
        'settings.json'
      )
    default:
      return join(homedir(), '.config', 'zed', 'settings.json')
  }
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse Zed settings.json (shape: { context_servers?: { [name]: { ... } } }) */
export async function parseZedSettingsJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    context_servers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const mcpServers = json.context_servers ?? {}
  const entries = Object.entries(mcpServers)
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'zed',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverZed(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  try {
    const configPath = getZedConfigPath()
    await fs.access(configPath)
    const servers = await parseZedSettingsJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  return results
}
