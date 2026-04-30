/**
 * Claude Cowork ClientIntegration.
 *
 * Cowork uses the same `claude_desktop_config.json` as Claude Desktop. We
 * surface it as a separate client because the Cowork-vs-Desktop distinction
 * is meaningful in the UI; gating on `vm_bundles/` ensures we only treat the
 * file as Cowork-owned once Cowork has actually been run.
 *
 * `isInstalled()` is intentionally synchronous to match the
 * ClientIntegration contract; we mirror Cowork's `vm_bundles/` check using
 * existsSync here to keep it in-process.
 */
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { appInstalled } from '../shared'
import { discoverClaudeCowork, getClaudeCoworkConfigPath } from './discovery'

const meta = CLIENT_DISPLAY['claude-cowork']

export const integration: ClientIntegration = {
  id: 'claude-cowork',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled(): boolean {
    const configPath = getClaudeCoworkConfigPath()
    const vmBundlesDir = join(dirname(configPath), 'vm_bundles')
    if (!existsSync(vmBundlesDir)) return false
    return appInstalled({
      mac: ['Claude.app'],
      win: ['Claude\\Claude.exe'],
      linux: ['claude-desktop', 'Claude'],
    })
  },

  discoverServers: discoverClaudeCowork,

  async configEntries(): Promise<McpConfigEntry[]> {
    return [
      { client: 'claude-cowork', path: getClaudeCoworkConfigPath(), kind: 'json', scope: 'user' },
    ]
  },

  async watchTargets(): Promise<WatchTargets> {
    return {
      files: await integration.configEntries(),
      dirs: [],
      needsPeriodicRescan: false,
    }
  },

  backups: {
    globs: () => [`${getClaudeCoworkConfigPath()}.backup.*`],
  },
}
