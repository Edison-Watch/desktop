/**
 * Claude Cowork MCP server discovery.
 *
 * Cowork shares its config file with Claude Desktop
 * (claude_desktop_config.json) and is detected via the presence of the
 * `vm_bundles/` subdirectory, which Claude Desktop creates on first Cowork
 * launch. Reference:
 * https://support.claude.com/en/articles/13345190-get-started-with-cowork
 *
 * Cowork has no scriptable hook surface.
 */

import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { dirname, join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'

// ── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Cowork config path. Same file as Claude Desktop on every platform - the
 * `vm_bundles/` sibling directory is what differentiates a Cowork install.
 */
export function getClaudeCoworkConfigPath(): string {
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

/** Parse Cowork config (same shape as Claude Desktop: top-level `mcpServers`). */
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
      config: cfg as McpServerConfig,
    })
  }
  return servers
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverClaudeCowork(): Promise<DiscoveredMcpServer[]> {
  try {
    const configPath = getClaudeCoworkConfigPath()
    // Guard: only present once Cowork has been launched at least once.
    const vmBundlesDir = join(dirname(configPath), 'vm_bundles')
    await fs.access(vmBundlesDir)
    await fs.access(configPath)
    return await parseClaudeCoworkConfig(configPath)
  } catch {
    return []
  }
}
