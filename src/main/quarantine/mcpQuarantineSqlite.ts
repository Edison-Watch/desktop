/**
 * Marketplace quarantine orchestrator for MCP servers stored in IDE state databases.
 *
 * Dispatches to agent-specific quarantine modules:
 * - Cursor: clients/cursor/quarantineSqlite.ts
 * - VS Code: clients/vscode/quarantine.ts
 *
 * Shared SQLite primitives (queryStateDb, updateStateDb) live in clients/stateDb.ts.
 */
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../discovery/mcpDiscovery'
import { getCursorStateDbPath } from '../clients/cursor/marketplace'
import { getVscodeStateDbPath } from '../clients/vscode/discovery'
import { quarantineCursorOAuthMcp, restoreCursorOAuthMcp } from '../clients/cursor/quarantineSqlite'
import { quarantineVscodeExtensionMcp, restoreVscodeExtensionMcp } from '../clients/vscode/quarantine'

// Re-export shared SQLite utilities for backward compatibility
export { queryStateDb, updateStateDb } from '../clients/stateDb'

// Re-export agent-specific functions for backward compatibility
export { quarantineCursorOAuthMcp, removeCursorPluginFromStateDb, removeCursorPluginsFromServerConfig, restoreCursorOAuthMcp } from '../clients/cursor/quarantineSqlite'
export { quarantineVscodeExtensionMcp, restoreVscodeExtensionMcp } from '../clients/vscode/quarantine'

// ── Disabled file helpers for marketplace servers ────────────────────────────

/**
 * Structure for marketplace quarantine disabled files.
 * Extends the standard disabled file with state DB metadata.
 */
export interface MarketplaceQuarantinedServer {
  originalFile: string
  quarantinedAt: string
  stateDbKey: string
  serverConfig: McpServerConfig
  /** For Cursor OAuth: the raw state entries (e.g., mcp_server_url, mcp_code_verifier) */
  stateEntries?: Record<string, string>
  /** For VS Code: the removed cache data */
  cacheData?: Record<string, unknown>
}

export interface MarketplaceQuarantinedServersFile {
  quarantinedBy: string
  servers: Record<string, MarketplaceQuarantinedServer>
}

/**
 * Get the disabled file path for marketplace (state.vscdb) servers.
 * Uses a `.json` extension instead of `.vscdb`.
 */
export function getMarketplaceDisabledPath(stateDbPath: string): string {
  const dir = dirname(stateDbPath)
  return join(dir, 'disabled_marketplace_mcps.json')
}

/**
 * Read the marketplace quarantined servers file.
 */
export async function readMarketplaceDisabledFile(
  disabledPath: string
): Promise<MarketplaceQuarantinedServersFile> {
  try {
    const content = await fs.readFile(disabledPath, 'utf-8')
    return JSON.parse(content) as MarketplaceQuarantinedServersFile
  } catch {
    return { quarantinedBy: 'Edison Watch', servers: {} }
  }
}

/**
 * Write the marketplace quarantined servers file.
 */
export async function writeMarketplaceDisabledFile(
  disabledPath: string,
  data: MarketplaceQuarantinedServersFile
): Promise<void> {
  await fs.writeFile(disabledPath, JSON.stringify(data, null, 2), 'utf-8')
}

// ── High-level marketplace quarantine/restore ────────────────────────────────

export interface QuarantineResult {
  server: DiscoveredMcpServer
  originalPath: string
  disabledPath: string
  quarantinedAt: string
}

/**
 * Quarantine a marketplace server stored in a state.vscdb SQLite database.
 * Removes the server from the IDE's state DB and stores it in a marketplace disabled file.
 */
export async function quarantineMarketplaceServer(server: DiscoveredMcpServer): Promise<QuarantineResult> {
  const dbPath = server.path
  const disabledPath = getMarketplaceDisabledPath(dbPath)
  const quarantinedAt = new Date().toISOString()

  console.log(`[MCP Quarantine] Quarantining marketplace server "${server.name}" from ${dbPath}`)

  let stateDbKey: string
  let stateEntries: Record<string, string> | undefined
  let cacheData: Record<string, unknown> | undefined

  const isCursorDb = dbPath === getCursorStateDbPath()
  const isVscodeDb = dbPath === getVscodeStateDbPath()

  if (isCursorDb) {
    stateDbKey = 'anysphere.cursor-mcp'
    stateEntries = await quarantineCursorOAuthMcp(server)
  } else if (isVscodeDb) {
    stateDbKey = 'mcpToolCache'
    cacheData = await quarantineVscodeExtensionMcp(server)
  } else {
    throw new Error(`Unknown state database path for marketplace server: ${dbPath}`)
  }

  const disabledFile = await readMarketplaceDisabledFile(disabledPath)
  disabledFile.servers[server.name] = {
    originalFile: dbPath,
    quarantinedAt,
    stateDbKey,
    serverConfig: server.config,
    ...(stateEntries && { stateEntries }),
    ...(cacheData && { cacheData }),
  }
  await writeMarketplaceDisabledFile(disabledPath, disabledFile)
  console.log(`[MCP Quarantine] Stored marketplace server "${server.name}" in ${disabledPath}`)

  return { server, originalPath: dbPath, disabledPath, quarantinedAt }
}

/**
 * Restore all marketplace-quarantined servers back to their state databases.
 * Scans known state.vscdb paths for disabled_marketplace_mcps.json files.
 */
export async function restoreAllMarketplaceServers(): Promise<{ restored: number; errors: string[] }> {
  let restored = 0
  const errors: string[] = []
  const stateDbPaths = [getCursorStateDbPath(), getVscodeStateDbPath()]

  for (const dbPath of stateDbPaths) {
    const disabledPath = getMarketplaceDisabledPath(dbPath)
    try { await fs.access(disabledPath) } catch { continue }

    try {
      const disabledFile = await readMarketplaceDisabledFile(disabledPath)
      const serverNames = Object.keys(disabledFile.servers)
      if (serverNames.length === 0) { await fs.unlink(disabledPath); continue }

      const restoredNames = new Set<string>()
      for (const [name, entry] of Object.entries(disabledFile.servers)) {
        try {
          if (entry.stateEntries && entry.stateDbKey === 'anysphere.cursor-mcp') {
            await restoreCursorOAuthMcp(dbPath, entry.stateEntries)
          } else if (entry.cacheData && entry.stateDbKey === 'mcpToolCache') {
            await restoreVscodeExtensionMcp(dbPath, name, entry.cacheData)
          }
          restoredNames.add(name)
          restored++
          console.log(`[MCP Quarantine Reset] Restored marketplace server "${name}" to ${dbPath}`)
        } catch (err) {
          const msg = `Failed to restore marketplace server "${name}" to ${dbPath}: ${err instanceof Error ? err.message : String(err)}`
          console.error(`[MCP Quarantine Reset] ${msg}`)
          errors.push(msg)
        }
      }

      if (restoredNames.size === Object.keys(disabledFile.servers).length) {
        await fs.unlink(disabledPath)
        console.log(`[MCP Quarantine Reset] Removed marketplace disabled file: ${disabledPath}`)
      } else if (restoredNames.size > 0) {
        for (const name of restoredNames) {
          delete disabledFile.servers[name]
        }
        await writeMarketplaceDisabledFile(disabledPath, disabledFile)
        console.log(`[MCP Quarantine Reset] Updated marketplace disabled file (kept ${Object.keys(disabledFile.servers).length} failed entries): ${disabledPath}`)
      }
    } catch (err) {
      const msg = `Failed to restore from ${disabledPath}: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[MCP Quarantine Reset] ${msg}`)
      errors.push(msg)
    }
  }

  return { restored, errors }
}
