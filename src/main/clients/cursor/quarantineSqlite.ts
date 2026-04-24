/**
 * Cursor-specific SQLite quarantine operations for OAuth marketplace MCPs.
 *
 * Cursor stores OAuth MCP state in state.vscdb under the `anysphere.cursor-mcp` key,
 * with entries prefixed by `[user-{name}]` or `[plugin-{name}-{name}]`.
 * Also manages the `cursorai/serverConfig` key for onboarding plugin names.
 */
import type { DiscoveredMcpServer } from '../../discovery/mcpDiscovery'
import { queryStateDb, updateStateDb } from '../stateDb'
import { getCursorStateDbPath } from './marketplace'

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
 * Remove a Cursor plugin's entries from the anysphere.cursor-mcp state DB key.
 * Plugin entries use prefixes like `[plugin-slack-slack]` or `[plugin-datadog-datadog]`.
 * Non-fatal: logs and returns silently if no entries found (e.g. datadog has no OAuth).
 */
export async function removeCursorPluginFromStateDb(
  pluginDirPrefixes: string[]
): Promise<void> {
  const dbPath = getCursorStateDbPath()
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY)
  if (!raw) return

  const state = JSON.parse(raw) as Record<string, string>
  const newState: Record<string, string> = {}
  let removedCount = 0

  for (const [key, value] of Object.entries(state)) {
    const matched = pluginDirPrefixes.some((p) => key.startsWith(`[${p}] `))
    if (matched) {
      removedCount++
    } else {
      newState[key] = value
    }
  }

  if (removedCount > 0) {
    await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(newState))
    console.log(`[MCP Quarantine SQLite] Removed ${removedCount} plugin entries from ${CURSOR_MCP_STATE_KEY}`)
  }
}

const CURSOR_SERVER_CONFIG_KEY = 'cursorai/serverConfig'

/**
 * Remove plugin names from onboardingConfig.marketplacePluginNames in Cursor's serverConfig.
 * This prevents Cursor from re-cloning and re-activating quarantined plugins.
 *
 * @param pluginNames The plugin names to remove (e.g. ["datadog", "slack"])
 */
export async function removeCursorPluginsFromServerConfig(
  pluginNames: string[]
): Promise<void> {
  const dbPath = getCursorStateDbPath()
  const raw = await queryStateDb(dbPath, CURSOR_SERVER_CONFIG_KEY)
  if (!raw) return

  try {
    const config = JSON.parse(raw) as Record<string, unknown>
    const onboarding = config.onboardingConfig as { marketplacePluginNames?: string[] } | undefined
    if (!onboarding?.marketplacePluginNames || !Array.isArray(onboarding.marketplacePluginNames)) return

    const removeSet = new Set(pluginNames.map((n) => n.toLowerCase()))
    const before = onboarding.marketplacePluginNames.length
    onboarding.marketplacePluginNames = onboarding.marketplacePluginNames.filter(
      (name) => !removeSet.has(name.toLowerCase())
    )
    const removed = before - onboarding.marketplacePluginNames.length

    if (removed > 0) {
      await updateStateDb(dbPath, CURSOR_SERVER_CONFIG_KEY, JSON.stringify(config))
      console.log(`[MCP Quarantine SQLite] Removed ${removed} plugin(s) from onboardingConfig.marketplacePluginNames`)
    }
  } catch (err) {
    console.warn(`[MCP Quarantine SQLite] Failed to update serverConfig:`, err)
  }
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
