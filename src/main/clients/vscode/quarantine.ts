/**
 * VS Code-specific SQLite quarantine operations for extension-provided MCP servers.
 *
 * VS Code stores extension MCP state in state.vscdb under the `mcpToolCache` key,
 * with `extensionServers` (array of server registrations) and `serverTools` (array
 * of [id, entry] tuples with tool definitions).
 */
import type { DiscoveredMcpServer } from '../../discovery/mcpDiscovery'
import { queryStateDb, updateStateDb } from '../stateDb'

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
 * Note: This is a "soft" quarantine - the extension may re-register the server
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
