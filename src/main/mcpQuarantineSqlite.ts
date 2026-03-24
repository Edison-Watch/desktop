/**
 * SQLite-based quarantine operations for MCP servers stored in IDE state databases.
 *
 * Supports quarantining servers from:
 * - Cursor's `anysphere.cursor-mcp` key (OAuth marketplace MCPs like Sentry, Supabase)
 * - VS Code's `mcpToolCache` key (extension-provided MCP servers)
 *
 * Uses the sqlite3 CLI to avoid adding a native SQLite dependency.
 */
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'
import { getCursorStateDbPath } from './mcpDiscoveryCursorMarketplace'
import { getVscodeStateDbPath, getVscodeInsidersStateDbPath } from './mcpDiscoveryVscodeState'

const SQLITE_TIMEOUT_MS = 5000

/**
 * Read a key's value from a state.vscdb SQLite database.
 * Returns null if the DB doesn't exist or the key isn't found.
 */
export async function queryStateDb(dbPath: string, key: string): Promise<string | null> {
  try {
    await fs.access(dbPath)
  } catch {
    return null
  }

  const safeKey = key.replace(/'/g, "''")
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${safeKey}' LIMIT 1;`],
      { timeout: SQLITE_TIMEOUT_MS },
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
 * Update a key's value in a state.vscdb SQLite database.
 * Writes the new JSON value via a temp file to avoid shell escaping issues.
 */
export async function updateStateDb(dbPath: string, key: string, value: string): Promise<void> {
  try {
    await fs.access(dbPath)
  } catch {
    throw new Error(`State database not found: ${dbPath}`)
  }

  // Write value to temp file to avoid shell escaping issues with large JSON
  const tmpPath = join(dirname(dbPath), `.ew_statedb_tmp_${Date.now()}.txt`)
  try {
    await fs.writeFile(tmpPath, value, 'utf-8')

    const safeKey = key.replace(/'/g, "''")
    // Use readfile() to read the value from the temp file
    const sql = `UPDATE ItemTable SET value = readfile('${tmpPath.replace(/'/g, "''")}') WHERE key = '${safeKey}';`

    await new Promise<void>((resolve, reject) => {
      execFile(
        'sqlite3',
        [dbPath, sql],
        { timeout: SQLITE_TIMEOUT_MS },
        (err) => {
          if (err) reject(new Error(`Failed to update state DB: ${err.message}`))
          else resolve()
        }
      )
    })
  } finally {
    // Clean up temp file
    try { await fs.unlink(tmpPath) } catch { /* ignore */ }
  }
}

// ── Cursor OAuth marketplace MCP quarantine ──────────────────────────────────

const CURSOR_MCP_STATE_KEY = 'anysphere.cursor-mcp'

/**
 * Quarantine a Cursor OAuth marketplace MCP by removing its entries from state.vscdb.
 * Returns the removed entries (server_url, code_verifier) for storage in the disabled file.
 */
export async function quarantineCursorOAuthMcp(
  server: DiscoveredMcpServer
): Promise<Record<string, string>> {
  const dbPath = server.path
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY)
  if (!raw) {
    throw new Error(`Could not read ${CURSOR_MCP_STATE_KEY} from ${dbPath}`)
  }

  const state = JSON.parse(raw) as Record<string, string>

  // Find all entries for this server name (e.g., [user-sentry] mcp_server_url, [user-sentry] mcp_code_verifier)
  const prefix = `[user-${server.name}] `
  const removedEntries: Record<string, string> = {}
  const newState: Record<string, string> = {}

  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(prefix)) {
      removedEntries[key] = value
    } else {
      newState[key] = value
    }
  }

  if (Object.keys(removedEntries).length === 0) {
    throw new Error(`Server "${server.name}" not found in ${CURSOR_MCP_STATE_KEY}`)
  }

  // Write the modified state back
  await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(newState))
  console.log(`[MCP Quarantine SQLite] Removed "${server.name}" from ${CURSOR_MCP_STATE_KEY} in ${dbPath}`)

  return removedEntries
}

/**
 * Restore a Cursor OAuth marketplace MCP by adding its entries back to state.vscdb.
 */
export async function restoreCursorOAuthMcp(
  dbPath: string,
  entries: Record<string, string>
): Promise<void> {
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY)
  const state = raw ? (JSON.parse(raw) as Record<string, string>) : {}

  // Merge entries back
  Object.assign(state, entries)

  await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(state))
  console.log(`[MCP Quarantine SQLite] Restored entries to ${CURSOR_MCP_STATE_KEY} in ${dbPath}`)
}

// ── VS Code extension MCP quarantine ─────────────────────────────────────────

const VSCODE_MCP_TOOL_CACHE_KEY = 'mcpToolCache'

interface VscodeToolCacheEntry {
  serverName?: string
  serverInstructions?: string
  nonce?: string
  tools?: unknown[]
}

interface VscodeToolCache {
  extensionServers: Array<{
    id: string
    label?: string
    [key: string]: unknown
  }>
  serverTools: Array<[string, VscodeToolCacheEntry]>
}

/**
 * Quarantine a VS Code extension MCP server by removing it from the mcpToolCache.
 * Returns the removed entry data for storage in the disabled file.
 *
 * Note: This is a "soft" quarantine — the extension may re-register the server
 * on next VS Code startup. The periodic rescan will re-detect and re-quarantine.
 */
export async function quarantineVscodeExtensionMcp(
  server: DiscoveredMcpServer
): Promise<Record<string, unknown>> {
  const dbPath = server.path
  const raw = await queryStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY)
  if (!raw) {
    throw new Error(`Could not read ${VSCODE_MCP_TOOL_CACHE_KEY} from ${dbPath}`)
  }

  const cache = JSON.parse(raw) as VscodeToolCache
  const removedData: Record<string, unknown> = {}

  // Remove from extensionServers
  const extIdx = cache.extensionServers.findIndex(
    (s) => s.id === server.name || s.label === server.name
  )
  if (extIdx !== -1) {
    removedData.extensionServer = cache.extensionServers.splice(extIdx, 1)[0]
  }

  // Remove from serverTools (match on id or serverName since discovery may use either)
  const toolIdx = cache.serverTools.findIndex(
    ([id, entry]) => id === server.name || entry.serverName === server.name
  )
  if (toolIdx !== -1) {
    removedData.serverTool = cache.serverTools.splice(toolIdx, 1)[0]
  }

  if (Object.keys(removedData).length === 0) {
    throw new Error(`Server "${server.name}" not found in ${VSCODE_MCP_TOOL_CACHE_KEY}`)
  }

  await updateStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY, JSON.stringify(cache))
  console.log(`[MCP Quarantine SQLite] Removed "${server.name}" from ${VSCODE_MCP_TOOL_CACHE_KEY} in ${dbPath}`)

  return removedData
}

/**
 * Restore a VS Code extension MCP server by adding it back to mcpToolCache.
 */
export async function restoreVscodeExtensionMcp(
  dbPath: string,
  serverName: string,
  removedData: Record<string, unknown>
): Promise<void> {
  const raw = await queryStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY)
  if (!raw) {
    throw new Error(`Could not read ${VSCODE_MCP_TOOL_CACHE_KEY} from ${dbPath}`)
  }

  const cache = JSON.parse(raw) as VscodeToolCache

  if (removedData.extensionServer) {
    cache.extensionServers.push(removedData.extensionServer as VscodeToolCache['extensionServers'][0])
  }
  if (removedData.serverTool) {
    cache.serverTools.push(removedData.serverTool as [string, VscodeToolCacheEntry])
  }

  await updateStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY, JSON.stringify(cache))
  console.log(`[MCP Quarantine SQLite] Restored "${serverName}" to ${VSCODE_MCP_TOOL_CACHE_KEY} in ${dbPath}`)
}

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
  const isVscodeDb = dbPath === getVscodeStateDbPath() || dbPath === getVscodeInsidersStateDbPath()

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
  const stateDbPaths = [getCursorStateDbPath(), getVscodeStateDbPath(), getVscodeInsidersStateDbPath()]

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
