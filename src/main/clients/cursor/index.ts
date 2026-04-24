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
import { promises as fs, existsSync } from 'fs'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientHookStatus, ClientIntegration, DirWatchTarget, WatchTargets } from '../types'
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
  type CursorHooksFile,
} from './hooks'
import {
  getCursorPluginCachePath,
  getCursorPluginMcpPaths,
  getCursorPluginsInstalledPaths,
  getCursorProjectMcpPaths,
  getCursorWorkspaceStoragePath,
} from '../../runtime/mcpProjectPaths'

const CURSOR_TOTAL_HOOKS = 3

async function getCursorHookStatus(): Promise<ClientHookStatus> {
  const installed = isCursorInstalled()
  let hookCount = 0
  if (installed) {
    try {
      const hooksPath = getCursorHooksPath()
      if (existsSync(hooksPath)) {
        const content = await fs.readFile(hooksPath, 'utf-8')
        const hooksFile = JSON.parse(content) as CursorHooksFile
        const sessionStart = hooksFile.hooks?.sessionStart ?? []
        const beforeMCP = hooksFile.hooks?.beforeMCPExecution ?? []
        const preToolUse = hooksFile.hooks?.preToolUse ?? []
        const sessionEnd = hooksFile.hooks?.sessionEnd ?? []
        if (sessionStart.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))) hookCount++
        if (beforeMCP.some((h) => h.command?.includes('edison-session-hook')) ||
            preToolUse.some((h) => h.command?.includes('edison-session-hook'))) hookCount++
        if (sessionEnd.some((h) => h.command?.includes('edison-session-end'))) hookCount++
      }
    } catch { /* ignore */ }
  }
  return { installed, hasHook: hookCount === CURSOR_TOTAL_HOOKS, hookCount, totalHooks: CURSOR_TOTAL_HOOKS }
}

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
    getStatus: getCursorHookStatus,
  },

  backups: {
    globs: () => [
      `${getCursorConfigPath()}.backup.*`,
      `${getCursorHooksPath()}.backup.*`,
    ],
  },
}
