/**
 * Cursor MCP server discovery - global config, project configs, and plugin-bundled servers.
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, basename, dirname } from 'path'
import * as jsonc from 'jsonc-parser'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'
import {
  getCursorProjectMcpPaths,
  getCursorPluginMcpPaths,
} from '../../runtime/mcpProjectPaths'
import { discoverCursorMarketplaceMcps } from './marketplace'

// ── Path helpers ─────────────────────────────────────────────────────────────

/** Cursor global user-level config path (same on all platforms) */
export function getCursorConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse Cursor mcp.json (shape: { mcpServers?: { [name]: { ... } } }) */
export async function parseCursorMcpJson(
  filePath: string,
  source: DiscoveredMcpServer['source'] = 'user',
  projectName?: string
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  // Cursor config files commonly contain trailing commas; use JSONC parser
  const json = jsonc.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'cursor',
      source,
      path: filePath,
      config: cfg as McpServerConfig,
      ...(projectName !== undefined ? { projectName } : {})
    })
  }
  return servers
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverCursor(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  // Global user-level config: ~/.cursor/mcp.json
  try {
    const configPath = getCursorConfigPath()
    await fs.access(configPath)
    const servers = await parseCursorMcpJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  // Project-level configs: .cursor/mcp.json in each known workspace
  const projectMcpPaths = await getCursorProjectMcpPaths()
  for (const mcpPath of projectMcpPaths) {
    try {
      await fs.access(mcpPath)
      const projectName = basename(dirname(dirname(mcpPath))) // project dir name
      const servers = await parseCursorMcpJson(mcpPath, 'project', projectName)
      results.push(...servers)
    } catch {
      // File doesn't exist in this project; ignore
    }
  }

  // Plugin-bundled MCP servers: ~/.cursor/plugins/cache/<marketplace>/<plugin>/<sha>/mcp.json
  const pluginMcpPaths = await getCursorPluginMcpPaths()
  for (const mcpPath of pluginMcpPaths) {
    try {
      await fs.access(mcpPath)
      const servers = await parseCursorMcpJson(mcpPath, 'plugin')
      results.push(...servers)
    } catch {
      // Plugin doesn't define MCP servers; ignore
    }
  }

  // Marketplace MCP apps (OAuth + plugin- prefixed) - read-only from Cursor's internal state
  const marketplaceMcps = await discoverCursorMarketplaceMcps()
  // Deduplicate: marketplace servers already in mcp.json should not appear twice
  const existingNames = new Set(results.map((s) => s.name.toLowerCase()))
  for (const mcp of marketplaceMcps) {
    if (!existingNames.has(mcp.name.toLowerCase())) {
      results.push(mcp)
    }
  }

  return results
}
