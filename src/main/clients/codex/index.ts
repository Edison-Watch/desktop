/**
 * Codex CLI ClientIntegration.
 *
 * Codex hooks live in a TOML config (`~/.codex/config.toml`) as
 * `[[hooks.SessionStart]]` (registration) and `[[hooks.Stop]]` (session end)
 * blocks. Codex CLI hooks are experimental (v0.114.0+) and have no
 * PreToolUse/BeforeTool event, so session isolation is not possible. Codex
 * has no discovery surface today - its MCP configuration is opaque from our
 * side.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import {
  getCodexConfigPath,
  injectCodexHook,
  isCodexInstalled,
  removeCodexHook,
} from './hooks'

const meta = CLIENT_DISPLAY['codex']

export const integration: ClientIntegration = {
  id: 'codex',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled: isCodexInstalled,

  async discoverServers() {
    return []
  },

  async configEntries(): Promise<McpConfigEntry[]> {
    return [{ client: 'codex', path: getCodexConfigPath(), kind: 'toml', scope: 'user' }]
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
      'session-start': { nativeName: 'SessionStart' },
      'session-end': { nativeName: 'Stop' },
    },
    sessionIdStrategy: {
      kind: 'unsupported',
      reason: 'Codex does not expose a per-conversation id to hooks.',
    },
    inject: injectCodexHook,
    remove: removeCodexHook,
  },

  backups: {
    globs: () => [`${getCodexConfigPath()}.backup.*`],
  },
}
