/**
 * Claude Desktop MCP server discovery.
 *
 * Claude Desktop reads MCP servers from ~/Library/Application Support/Claude/
 * claude_desktop_config.json (and platform equivalents). It has no scriptable
 * hook surface, so this module only handles config-file discovery.
 */

import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'

// ── Path helpers ─────────────────────────────────────────────────────────────

/** Claude Desktop config path (per-platform). */
export function getClaudeDesktopConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      )
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json',
      )
    default:
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse Claude Desktop config (shape: { mcpServers?: { [name]: { ... } } }). */
export async function parseClaudeDesktopConfig(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'claude-desktop',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig,
    })
  }
  return servers
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverClaudeDesktop(): Promise<DiscoveredMcpServer[]> {
  try {
    const configPath = getClaudeDesktopConfigPath()
    await fs.access(configPath)
    return await parseClaudeDesktopConfig(configPath)
  } catch {
    return []
  }
}
