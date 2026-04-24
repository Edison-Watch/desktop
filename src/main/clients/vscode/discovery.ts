/**
 * Discover MCP servers from VS Code's internal state database (state.vscdb).
 *
 * VS Code stores extension-provided MCP servers in its Electron state database
 * under the `mcpToolCache` key. This module discovers those servers so they can
 * be reported to admins and quarantined if needed.
 *
 * Also discovers servers registered in VS Code's `settings.json` under the
 * `mcp` key (distinct from the file-based `mcp.json`).
 */
import { homedir, platform } from 'os'
import { join } from 'path'
import { promises as fs } from 'fs'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'
import { queryStateDb } from '../stateDb'

// ── Path helpers ─────────────────────────────────────────────────────────────

/** VS Code user-level mcp.json path */
export function getVscodeUserMcpPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code',
        'User',
        'mcp.json'
      )
    default:
      return join(homedir(), '.config', 'Code', 'User', 'mcp.json')
  }
}

export function getVscodeStateDbPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code',
        'User',
        'globalStorage',
        'state.vscdb'
      )
    default:
      return join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'state.vscdb')
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────

interface ToolCacheExtensionServer {
  id: string
  label?: string
  extensionId?: string
  serverUrl?: string
  [key: string]: unknown
}

interface ToolCacheEntry {
  serverName?: string
  serverInstructions?: string
  nonce?: string
  tools?: unknown[]
}

interface VscodeToolCache {
  extensionServers: ToolCacheExtensionServer[]
  serverTools: Array<[string, ToolCacheEntry]>
}

/**
 * Discover MCP servers from VS Code's state.vscdb mcpToolCache.
 *
 * Extension-provided servers appear in `mcpToolCache.extensionServers`.
 * We also check `mcpToolCache.serverTools` for servers that might not be
 * in extensionServers but are actively cached (e.g., from extension API registrations).
 */
export async function discoverVscodeStateMcps(
  client: 'vscode' = 'vscode'
): Promise<DiscoveredMcpServer[]> {
  const dbPath = getVscodeStateDbPath()
  const results: DiscoveredMcpServer[] = []

  try {
    const raw = await queryStateDb(dbPath, 'mcpToolCache')
    if (!raw) return results

    const cache = JSON.parse(raw) as VscodeToolCache

    // 1. Extension-provided servers (registered via VS Code Extension API)
    if (Array.isArray(cache.extensionServers)) {
      for (const extServer of cache.extensionServers) {
        if (!extServer.id) continue

        const config: McpServerConfig = extServer.serverUrl
          ? { type: 'http', url: extServer.serverUrl }
          : { type: 'opaque' as const }

        results.push({
          name: extServer.label ?? extServer.id,
          client,
          source: 'marketplace',
          path: dbPath,
          config,
        })
      }
    }

    // 2. Check serverTools for extension-originated entries not in extensionServers.
    //    Extension tool entries have IDs that don't start with "mcp.config." (those are from mcp.json).
    if (Array.isArray(cache.serverTools)) {
      const knownNames = new Set(results.map((s) => s.name.toLowerCase()))

      for (const [serverId, entry] of cache.serverTools) {
        // Skip mcp.json-based servers (already discovered via file parsing)
        if (serverId.startsWith('mcp.config.')) continue
        // Skip cursor-prefixed entries (discovered via Cursor discovery)
        if (serverId.startsWith('cursor.')) continue

        const name = entry.serverName ?? serverId
        if (knownNames.has(name.toLowerCase())) continue

        results.push({
          name,
          client,
          source: 'marketplace',
          path: dbPath,
          config: { type: 'opaque' as const },
        })
        knownNames.add(name.toLowerCase())
      }
    }
  } catch {
    // state.vscdb unreadable or sqlite3 not available; skip
  }

  return results
}

// ── File-based parser ───────────────────────────────────────────────────────

/** Parse a VS Code-style mcp.json (shape: { servers: { [name]: { ... } }, inputs?: [...] }) */
export async function parseVscodeMcpJson(
  filePath: string,
  client: 'vscode' = 'vscode'
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    servers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.servers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client,
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}
