/**
 * Cursor ClientIntegration.
 *
 * Cursor has three discovery surfaces: the user config file
 * ~/.cursor/mcp.json (JSONC), the state SQLite DB (marketplace + Extension
 * API installs), and installed plugins under ~/.cursor/plugins. Hooks live
 * in ~/.cursor/hooks.json across sessionStart, beforeMCPExecution,
 * preToolUse, and sessionEnd. Cursor v2.5+ exposes a conversation_id via
 * stdin on hook invocations.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, DirWatchTarget, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { discoverCursor, getCursorConfigPath } from './discovery'
import {
  discoverCursorMarketplaceMcps,
  getCursorStateDbPath,
} from './marketplace'
import {
  getCursorHooksPath,
  injectCursorHook,
  isCursorInstalled,
  removeCursorHook,
} from './hooks'
import {
  getCursorPluginCachePath,
  getCursorPluginMcpPaths,
  getCursorPluginsInstalledPaths,
  getCursorProjectMcpPaths,
  getCursorWorkspaceStoragePath,
} from '../../runtime/mcpProjectPaths'

const meta = CLIENT_DISPLAY['cursor']

export const integration: ClientIntegration = {
  id: 'cursor',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled: isCursorInstalled,

  async discoverServers() {
    const [file, state] = await Promise.all([
      discoverCursor(),
      discoverCursorMarketplaceMcps(),
    ])
    const known = new Set(file.map((s) => s.name.toLowerCase()))
    return [...file, ...state.filter((s) => !known.has(s.name.toLowerCase()))]
  },

  async configEntries(): Promise<McpConfigEntry[]> {
    const entries: McpConfigEntry[] = [
      { client: 'cursor', path: getCursorConfigPath(), kind: 'jsonc', scope: 'user' },
      { client: 'cursor', path: getCursorStateDbPath(), kind: 'sqlite-state', scope: 'marketplace' },
    ]
    for (const p of getCursorPluginsInstalledPaths()) {
      entries.push({
        client: 'cursor',
        path: p,
        kind: 'json',
        scope: 'plugin-registry',
        triggersDynamicRescan: 'cursor-plugins',
      })
    }
    for (const p of await getCursorProjectMcpPaths()) {
      entries.push({ client: 'cursor', path: p, kind: 'jsonc', scope: 'project' })
    }
    for (const p of await getCursorPluginMcpPaths()) {
      entries.push({ client: 'cursor', path: p, kind: 'json', scope: 'user' })
    }
    return entries
  },

  async watchTargets(): Promise<WatchTargets> {
    const dirs: DirWatchTarget[] = [
      {
        path: getCursorWorkspaceStoragePath(),
        depth: 1,
        onChange: 'rescan-dynamic-config-paths',
      },
      {
        path: getCursorPluginCachePath(),
        depth: 3,
        onChange: 'rescan-dynamic-config-paths',
      },
    ]
    return {
      files: await integration.configEntries(),
      dirs,
      // State DB writes aren't file-touch events; rescan periodically so
      // marketplace installs and Extension API registrations are picked up.
      needsPeriodicRescan: true,
    }
  },

  hooks: {
    supportedEvents: {
      'session-start': { nativeName: 'sessionStart' },
      'pre-tool-use': { nativeName: 'beforeMCPExecution' },
      'session-end': { nativeName: 'sessionEnd' },
    },
    sessionIdStrategy: { kind: 'native-stdin', field: 'conversation_id' },
    inject: injectCursorHook,
    remove: removeCursorHook,
  },

  backups: {
    globs: () => [
      `${getCursorConfigPath()}.backup.*`,
      `${getCursorHooksPath()}.backup.*`,
    ],
  },
}
