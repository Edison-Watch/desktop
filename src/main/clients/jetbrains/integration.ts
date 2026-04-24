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
import { appBundleExists } from '../shared'
import {
  getInstalledJetBrainsIdes,
  getJetBrainsMcpConfigPaths,
  parseJetBrainsServersJson,
} from './discovery'
import { MAC_APP_NAMES } from '../../discovery/mcpDiscovery'

export type JetBrainsId = 'intellij' | 'pycharm' | 'webstorm'

export function createJetBrainsIntegration(id: JetBrainsId): ClientIntegration {
  const meta = CLIENT_DISPLAY[id]
  const macNames = MAC_APP_NAMES[id] ?? []

  const self: ClientIntegration = {
    id,
    display: { name: meta.name, brandColor: meta.brandColor },

    isInstalled(): boolean {
      // Sync check: whether this IDE ships a .app bundle on macOS. Deeper
      // detection (preferences-folder scan) is async and lives in
      // getInstalledJetBrainsIdes.
      return appBundleExists(macNames)
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
