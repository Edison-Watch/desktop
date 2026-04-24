/**
 * Windsurf (Codeium) ClientIntegration.
 *
 * Hooks live in `~/.codeium/windsurf/hooks.json` under `pre_user_prompt`.
 * MCP config lives in `~/.codeium/windsurf/mcp_config.json`.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { discoverWindsurf, getWindsurfConfigPath } from './discovery'
import {
  getWindsurfHooksPath,
  injectWindsurfHook,
  isWindsurfInstalled,
  removeWindsurfHook,
} from './hooks'

const meta = CLIENT_DISPLAY['windsurf']

export const integration: ClientIntegration = {
  id: 'windsurf',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled: isWindsurfInstalled,

  discoverServers: discoverWindsurf,

  async configEntries(): Promise<McpConfigEntry[]> {
    return [{ client: 'windsurf', path: getWindsurfConfigPath(), kind: 'json', scope: 'user' }]
  },

  async watchTargets(): Promise<WatchTargets> {
    return {
      files: await integration.configEntries(),
      dirs: [],
      needsPeriodicRescan: false,
    }
  },

  hooks: {
    supportedEvents: {
      'user-prompt-submit': { nativeName: 'pre_user_prompt' },
    },
    sessionIdStrategy: {
      kind: 'heuristic',
      note: 'Windsurf pre_user_prompt does not expose a session id.',
    },
    inject: injectWindsurfHook,
    remove: removeWindsurfHook,
  },

  backups: {
    globs: () => [
      `${getWindsurfConfigPath()}.backup.*`,
      `${getWindsurfHooksPath()}.backup.*`,
    ],
  },
}
