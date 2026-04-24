/**
 * Windsurf MCP server discovery.
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'

// ── Path helpers ─────────────────────────────────────────────────────────────

/** Windsurf (Codeium) config path (same on all platforms) */
export function getWindsurfConfigPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse Windsurf mcp_config.json (shape: { mcpServers?: { [name]: { ... } } }) */
export async function parseWindsurfMcpJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'windsurf',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverWindsurf(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  try {
    const configPath = getWindsurfConfigPath()
    await fs.access(configPath)
    const servers = await parseWindsurfMcpJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  return results
}
