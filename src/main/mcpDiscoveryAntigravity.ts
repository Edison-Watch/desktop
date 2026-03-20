/**
 * Antigravity (Google AI IDE) MCP discovery helpers.
 * Kept separate from mcpDiscovery.ts to stay within line limits.
 */
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'

// Antigravity (Google) config path (same on all platforms)
export function getAntigravityConfigPath(): string {
  return join(homedir(), '.gemini', 'antigravity', 'mcp_config.json')
}

// Parse Antigravity mcp.json (shape: { mcpServers?: { [name]: { ... } } })
// Exported for testing
export async function parseAntigravityMcpJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'antigravity',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

export async function discoverAntigravity(): Promise<DiscoveredMcpServer[]> {
  try {
    const configPath = getAntigravityConfigPath()
    await fs.access(configPath)
    return await parseAntigravityMcpJson(configPath)
  } catch {
    // File not found or unreadable; ignore
    return []
  }
}
