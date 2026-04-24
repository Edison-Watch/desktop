/**
 * Zed ClientIntegration.
 *
 * Zed has no hook system; we only read/write its MCP config at
 * `~/.config/zed/settings.json` under `assistant.mcp_servers`.
 */
import { existsSync } from 'fs'
import { dirname } from 'path'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { appBundleExists } from '../shared'
import { discoverZed, getZedConfigPath } from './discovery'

const meta = CLIENT_DISPLAY['zed']

export const integration: ClientIntegration = {
  id: 'zed',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled(): boolean {
    return existsSync(dirname(getZedConfigPath())) && appBundleExists(['Zed.app'])
  },

  discoverServers: discoverZed,

  async configEntries(): Promise<McpConfigEntry[]> {
    return [{ client: 'zed', path: getZedConfigPath(), kind: 'json', scope: 'user' }]
  },

  async watchTargets(): Promise<WatchTargets> {
    return {
      files: await integration.configEntries(),
      dirs: [],
      needsPeriodicRescan: false,
    }
  },

  backups: {
    globs: () => [`${getZedConfigPath()}.backup.*`],
  },
}
