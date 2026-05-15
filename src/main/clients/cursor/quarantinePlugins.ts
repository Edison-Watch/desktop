/**
 * Cursor plugin quarantine (directory-based).
 *
 * Cursor marketplace plugins are installed via:
 *   ~/.cursor/plugins/cache/<marketplace>/<name>/<sha>/mcp.json
 * and activated per-project at:
 *   ~/.cursor/projects/<project>/mcps/plugin-<name>-<name>/
 *
 * Quarantine renames both the cache dir and project dirs with an `ew-disabled-` prefix,
 * cleans the state DB entries, and removes the plugin from the onboarding config.
 */
import { promises as fs } from 'fs'
import { dirname, basename, join, sep } from 'path'

/** Split a file path on both / and \ so it works cross-platform. */
const splitPath = (p: string): string[] => p.split(/[/\\]/)
import type { DiscoveredMcpServer } from '../../discovery/mcpDiscovery'
import { getCursorProjectsDir, getCursorPluginCachePath } from '../../discovery/mcpDiscovery'
import type { QuarantineResult } from '../../runtime/mcpConfigActions'
import {
  removeCursorPluginFromStateDb,
  removeCursorPluginsFromServerConfig,
} from './quarantineSqlite'

const CURSOR_PLUGIN_DISABLED_PREFIX = 'ew-disabled-'

/**
 * Strip any number of leading `ew-disabled-` prefixes from a segment. Defense
 * against a feedback loop where a quarantined path leaks into rediscovery and
 * the next quarantine round would double-prefix (`ew-disabled-ew-disabled-X`).
 */
function stripDisabledPrefix(segment: string): string {
  let s = segment
  while (s.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) {
    s = s.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length)
  }
  return s
}

function deriveCursorPluginDirPrefixes(server: DiscoveredMcpServer): string[] {
  const parts = splitPath(server.path)
  const cacheIdx = parts.indexOf('cache')
  if (cacheIdx !== -1 && cacheIdx + 2 < parts.length) {
    const marketplace = stripDisabledPrefix(parts[cacheIdx + 1]!)
    const pluginName = stripDisabledPrefix(parts[cacheIdx + 2]!)
    return [
      `plugin-${pluginName}-${pluginName}`,
      `plugin-${marketplace}-${pluginName}`,
      `plugin-${pluginName}`,
    ]
  }
  const name = stripDisabledPrefix(server.name)
  return [`plugin-${name}-${name}`, `plugin-${name}`]
}

/**
 * Quarantine a Cursor plugin by:
 * 1. Renaming project dirs (plugin-X → ew-disabled-plugin-X) across all projects
 * 2. Cleaning anysphere.cursor-mcp state DB entries
 * 3. Removing from onboardingConfig.marketplacePluginNames
 * 4. Renaming the plugin cache directory
 */
export async function quarantineCursorPlugin(
  server: DiscoveredMcpServer
): Promise<QuarantineResult | null> {
  // Already-quarantined short-circuit: if the path contains an ew-disabled-
  // segment, this plugin is already in quarantine state and re-running would
  // either no-op or (worse) double-prefix and eventually hit ENAMETOOLONG.
  const pathParts = splitPath(server.path)
  if (pathParts.some((p) => p.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX))) {
    console.log(`[MCP Quarantine] Skipping "${server.name}" - path already contains ew-disabled-: ${server.path}`)
    return null
  }

  const projectsDir = getCursorProjectsDir()
  const prefixes = deriveCursorPluginDirPrefixes(server)
  const quarantinedAt = new Date().toISOString()
  let disabledCount = 0

  console.log(`[MCP Quarantine] Quarantining Cursor plugin "${server.name}" - dirs: ${prefixes.join(', ')}`)

  try {
    const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue
      const mcpsDir = join(projectsDir, projDir.name, 'mcps')
      try {
        const mcpEntries = await fs.readdir(mcpsDir, { withFileTypes: true })
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory()) continue
          if (mcpDir.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue
          if (!prefixes.includes(mcpDir.name)) continue
          const oldPath = join(mcpsDir, mcpDir.name)
          const newPath = join(mcpsDir, `${CURSOR_PLUGIN_DISABLED_PREFIX}${mcpDir.name}`)
          // Remove stale disabled dir if Cursor recreated the active one
          try { await fs.rm(newPath, { recursive: true, force: true }) } catch { /* */ }
          await fs.rename(oldPath, newPath)
          disabledCount++
          console.log(`[MCP Quarantine] Disabled plugin dir: ${oldPath} → ${newPath}`)
        }
      } catch { /* mcps/ doesn't exist */ }
    }
  } catch { /* projects dir doesn't exist */ }

  // Remove the plugin's entries from the Cursor state DB (anysphere.cursor-mcp)
  try { await removeCursorPluginFromStateDb(prefixes) } catch { /* non-fatal */ }

  // Remove from onboardingConfig.marketplacePluginNames so Cursor doesn't re-clone
  try {
    const parts = splitPath(server.path)
    const cacheIdx = parts.indexOf('cache')
    const pluginName = cacheIdx !== -1 && cacheIdx + 2 < parts.length
      ? parts[cacheIdx + 2]!      // from cache path: .../cache/<marketplace>/<name>/...
      : server.name               // fallback
    await removeCursorPluginsFromServerConfig([pluginName, server.name])
  } catch { /* non-fatal */ }

  // Rename the plugin's cache directory so Cursor doesn't auto-recreate project dirs.
  // Cache path: plugins/cache/<marketplace>/<name>/<sha>/mcp.json → rename <name> dir
  try {
    const parts = splitPath(server.path)
    const cacheIdx = parts.indexOf('cache')
    if (cacheIdx !== -1 && cacheIdx + 2 < parts.length) {
      const pluginCacheDir = parts.slice(0, cacheIdx + 3).join(sep) // .../cache/<marketplace>/<name>
      const parentDir = dirname(pluginCacheDir)
      const pluginDirName = basename(pluginCacheDir)
      const disabledCacheDir = join(parentDir, `${CURSOR_PLUGIN_DISABLED_PREFIX}${pluginDirName}`)
      try { await fs.rm(disabledCacheDir, { recursive: true, force: true }) } catch { /* */ }
      await fs.rename(pluginCacheDir, disabledCacheDir)
      console.log(`[MCP Quarantine] Disabled plugin cache: ${pluginCacheDir} → ${disabledCacheDir}`)
    }
  } catch (err) {
    console.warn(`[MCP Quarantine] Failed to disable plugin cache dir:`, err)
  }

  if (disabledCount === 0) {
    console.log(`[MCP Quarantine] No project directories found for plugin "${server.name}"`)
  }
  // Return success even with disabledCount=0 - the cache dir rename is the primary mechanism
  return { server, originalPath: server.path, disabledPath: projectsDir, quarantinedAt }
}

/**
 * Restore all quarantined Cursor plugins by reversing dir renames and cache renames.
 */
export async function restoreAllCursorPlugins(): Promise<{ restored: number; errors: string[] }> {
  const projectsDir = getCursorProjectsDir()
  let restored = 0
  const errors: string[] = []

  // Restore project dirs (ew-disabled-plugin-* → plugin-*)
  try {
    const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true })
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue
      const mcpsDir = join(projectsDir, projDir.name, 'mcps')
      try {
        const mcpEntries = await fs.readdir(mcpsDir, { withFileTypes: true })
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory()) continue
          if (!mcpDir.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue
          const originalName = mcpDir.name.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length)
          const oldPath = join(mcpsDir, mcpDir.name)
          const newPath = join(mcpsDir, originalName)
          try {
            await fs.rename(oldPath, newPath)
            restored++
            console.log(`[MCP Quarantine Reset] Restored plugin dir: ${oldPath} → ${newPath}`)
          } catch (err) {
            const msg = `Failed to restore plugin dir ${oldPath}: ${err instanceof Error ? err.message : String(err)}`
            errors.push(msg)
          }
        }
      } catch { /* mcps/ doesn't exist */ }
    }
  } catch { /* projects dir doesn't exist */ }

  // Restore plugin cache dirs (ew-disabled-<name> → <name>)
  try {
    const cacheDir = getCursorPluginCachePath()
    const marketplaces = await fs.readdir(cacheDir, { withFileTypes: true })
    for (const mkt of marketplaces) {
      if (!mkt.isDirectory()) continue
      const mktPath = join(cacheDir, mkt.name)
      const plugins = await fs.readdir(mktPath, { withFileTypes: true })
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue
        if (!plugin.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue
        const originalName = plugin.name.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length)
        const oldPath = join(mktPath, plugin.name)
        const newPath = join(mktPath, originalName)
        try {
          await fs.rename(oldPath, newPath)
          restored++
          console.log(`[MCP Quarantine Reset] Restored plugin cache: ${oldPath} → ${newPath}`)
        } catch (err) {
          const msg = `Failed to restore plugin cache ${oldPath}: ${err instanceof Error ? err.message : String(err)}`
          errors.push(msg)
        }
      }
    }
  } catch { /* cache dir doesn't exist */ }

  return { restored, errors }
}
