/**
 * Claude Desktop ClientIntegration.
 *
 * Claude Desktop has no scriptable hook system, so this integration only
 * exposes config-file discovery. The MCP config lives in the platform-specific
 * `claude_desktop_config.json` (mcpServers map at the top level).
 */
import { existsSync } from 'fs'
import { dirname } from 'path'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { appInstalled } from '../shared'
import { discoverClaudeDesktop, getClaudeDesktopConfigPath } from './discovery'

const meta = CLIENT_DISPLAY['claude-desktop']

export const integration: ClientIntegration = {
  id: 'claude-desktop',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled(): boolean {
    return existsSync(dirname(getClaudeDesktopConfigPath())) && appInstalled({
      mac: ['Claude.app'],
      win: ['Claude\\Claude.exe'],
      linux: ['claude-desktop', 'Claude'],
    })
  },

  discoverServers: discoverClaudeDesktop,

  async configEntries(): Promise<McpConfigEntry[]> {
    return [
      { client: 'claude-desktop', path: getClaudeDesktopConfigPath(), kind: 'json', scope: 'user' },
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
    globs: () => [`${getClaudeDesktopConfigPath()}.backup.*`],
  },
}
