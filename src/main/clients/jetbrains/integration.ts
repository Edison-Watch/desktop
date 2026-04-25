/**
 * Shared factory for JetBrains IDE ClientIntegrations (IntelliJ, PyCharm, WebStorm).
 *
 * The three IDEs share their MCP config layout (`mcp/servers.json` under the
 * IDE preferences folder) and have no hook system. They differ only in `id`,
 * display metadata, and the macOS `.app` names we probe for `isInstalled`.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import type { DiscoveredMcpServer } from '../../discovery/types'
import { appInstalled, type AppInstalledHints } from '../shared'
import {
  getInstalledJetBrainsIdes,
  getJetBrainsMcpConfigPaths,
  parseJetBrainsServersJson,
} from './discovery'
import { MAC_APP_NAMES } from '../../discovery/mcpDiscovery'

export type JetBrainsId = 'intellij' | 'pycharm' | 'webstorm'

// Windows (.exe) and Linux (binary / desktop entry) hints for each
// JetBrains IDE. Toolbox installs place launchers under LOCALAPPDATA;
// non-Toolbox Program Files installs live under `JetBrains\<IDE> <ver>`.
const JETBRAINS_WIN_EXES: Record<JetBrainsId, string[]> = {
  intellij: [
    'JetBrains\\IntelliJ IDEA Ultimate\\bin\\idea64.exe',
    'JetBrains\\IntelliJ IDEA Community Edition\\bin\\idea64.exe',
    'JetBrains\\Toolbox\\scripts\\idea.cmd',
  ],
  pycharm: [
    'JetBrains\\PyCharm Professional\\bin\\pycharm64.exe',
    'JetBrains\\PyCharm Community Edition\\bin\\pycharm64.exe',
    'JetBrains\\Toolbox\\scripts\\pycharm.cmd',
  ],
  webstorm: [
    'JetBrains\\WebStorm\\bin\\webstorm64.exe',
    'JetBrains\\Toolbox\\scripts\\webstorm.cmd',
  ],
}

const JETBRAINS_LINUX_BINS: Record<JetBrainsId, string[]> = {
  intellij: ['idea', 'intellij-idea-ultimate', 'intellij-idea-community', 'jetbrains-idea', 'jetbrains-idea-ce'],
  pycharm: ['pycharm', 'pycharm-professional', 'pycharm-community', 'jetbrains-pycharm', 'jetbrains-pycharm-ce'],
  webstorm: ['webstorm', 'jetbrains-webstorm'],
}

export function createJetBrainsIntegration(id: JetBrainsId): ClientIntegration {
  const meta = CLIENT_DISPLAY[id]
  const hints: AppInstalledHints = {
    mac: MAC_APP_NAMES[id] ?? [],
    win: JETBRAINS_WIN_EXES[id] ?? [],
    linux: JETBRAINS_LINUX_BINS[id] ?? [],
  }

  const self: ClientIntegration = {
    id,
    display: { name: meta.name, brandColor: meta.brandColor },

    isInstalled(): boolean {
      // Sync check: whether this IDE is installed per platform. Deeper
      // detection (preferences-folder scan) is async and lives in
      // getInstalledJetBrainsIdes.
      return appInstalled(hints)
    },

    async discoverServers() {
      const installed = await getInstalledJetBrainsIdes()
      if (!installed.has(id)) return []
      const paths = await getJetBrainsMcpConfigPaths()
      const results: DiscoveredMcpServer[] = []
      for (const { client, path } of paths) {
        if (client !== id) continue
        try {
          results.push(...await parseJetBrainsServersJson(path, client))
        } catch { /* unreadable or invalid JSON */ }
      }
      return results
    },

    async configEntries(): Promise<McpConfigEntry[]> {
      const paths = await getJetBrainsMcpConfigPaths()
      return paths
        .filter((p) => p.client === id)
        .map((p) => ({ client: id, path: p.path, kind: 'json' as const, scope: 'user' as const }))
    },

    async watchTargets(): Promise<WatchTargets> {
      return {
        files: await self.configEntries(),
        dirs: [],
        needsPeriodicRescan: false,
      }
    },

    backups: {
      globs: () => [], // JetBrains integration doesn't write backups today.
    },
  }
  return self
}
