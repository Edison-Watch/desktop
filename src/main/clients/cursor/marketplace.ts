/**
 * Discover Cursor marketplace MCP servers from Cursor's internal state.
 *
 * Cursor stores OAuth marketplace MCP server URLs (Sentry, Supabase, etc.) in its
 * Electron state database (state.vscdb) under the `anysphere.cursor-mcp` key.
 * Plugin marketplace MCPs (like Datadog) appear in the per-project mcps/ cache
 * directories with a `plugin-` prefix.
 *
 * This module is read-only --it discovers servers but cannot quarantine them.
 */
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/mcpDiscovery'

// Cursor's Electron global state database (stores marketplace MCP configs)
export function getCursorStateDbPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      )
    default:
      return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
}

// Cursor projects directory (stores per-project MCP tool caches and plugin install state)
export function getCursorProjectsDir(): string {
  return join(homedir(), '.cursor', 'projects')
}

/**
 * Query a value from Cursor's Electron state database (state.vscdb).
 * Uses the sqlite3 CLI to avoid adding a native dependency.
 * Returns null if the DB doesn't exist or the key isn't found.
 */
async function queryCursorStateDb(key: string): Promise<string | null> {
  const dbPath = getCursorStateDbPath()
  try {
    await fs.access(dbPath)
  } catch {
    return null
  }

  // Escape single quotes to prevent SQL injection (key is always a known constant,
  // but defensive coding in case future callers pass dynamic values)
  const safeKey = key.replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${safeKey}' LIMIT 1;`],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null)
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

/**
 * Discover marketplace MCP servers from Cursor's internal state.
 *
 * 1. OAuth marketplace MCPs -- URLs stored in state.vscdb under anysphere.cursor-mcp
 * 2. Plugin marketplace MCPs -- detected from mcps/plugin-* /SERVER_METADATA.json in
 *    the per-project cache directories
 */
export async function discoverCursorMarketplaceMcps(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []
  const stateDbPath = getCursorStateDbPath()

  // 1. OAuth marketplace MCPs from state.vscdb ->anysphere.cursor-mcp key
  // Format: { "[user-sentry] mcp_server_url": "https://...", "[user-sentry] mcp_code_verifier": "..." }
  try {
    const raw = await queryCursorStateDb('anysphere.cursor-mcp')
    if (raw) {
      const state = JSON.parse(raw) as Record<string, string>
      for (const [key, value] of Object.entries(state)) {
        const urlMatch = key.match(/^\[user-(.+?)\] mcp_server_url$/)
        if (urlMatch && value) {
          const serverName = urlMatch[1]
          results.push({
            name: serverName,
            client: 'cursor',
            source: 'marketplace',
            path: stateDbPath,
            config: { type: 'http', url: value } as McpServerConfig,
          })
        }
      }
    }
  } catch {
    // state.vscdb unreadable or sqlite3 not available; skip
  }

  // 2. Plugin marketplace MCPs from ~/.cursor/projects/*/mcps/plugin-*/SERVER_METADATA.json
  try {
    const projectsDir = getCursorProjectsDir()
    const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue
      const mcpsDir = join(projectsDir, projDir.name, 'mcps')
      try {
        const mcpEntries = await fs.readdir(mcpsDir, { withFileTypes: true })
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory() || !mcpDir.name.startsWith('plugin-')) continue
          // Avoid duplicating servers already found via OAuth state above
          const metadataPath = join(mcpsDir, mcpDir.name, 'SERVER_METADATA.json')
          try {
            const raw = await fs.readFile(metadataPath, 'utf-8')
            const metadata = JSON.parse(raw) as { serverIdentifier?: string; serverName?: string }
            const serverName = metadata.serverName ?? mcpDir.name.replace(/^plugin-/, '')
            // Check if we already discovered this server from the OAuth state
            if (results.some((s) => s.name.toLowerCase() === serverName.toLowerCase())) continue
            results.push({
              name: serverName,
              client: 'cursor',
              source: 'marketplace',
              path: metadataPath,
              config: { type: 'opaque' as const },
            })
          } catch {
            // SERVER_METADATA.json missing or unreadable; skip
          }
        }
      } catch {
        // mcps/ dir doesn't exist for this project; skip
      }
    }
  } catch {
    // projects dir doesn't exist; skip
  }

  return results
}
