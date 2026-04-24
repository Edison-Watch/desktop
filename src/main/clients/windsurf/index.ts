/**
 * Windsurf (Codeium) ClientIntegration.
 *
 * Hooks live in `~/.codeium/windsurf/hooks.json` under `pre_user_prompt`.
 * MCP config lives in `~/.codeium/windsurf/mcp_config.json`.
 */
import { promises as fs, existsSync } from 'fs'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientHookStatus, ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import { discoverWindsurf, getWindsurfConfigPath } from './discovery'
import {
  getWindsurfHooksPath,
  injectWindsurfHook,
  isWindsurfInstalled,
  removeWindsurfHook,
  type WindsurfHooksFile,
} from './hooks'

const WINDSURF_TOTAL_HOOKS = 1

async function getWindsurfHookStatus(): Promise<ClientHookStatus> {
  const installed = isWindsurfInstalled()
  let hasHook = false
  if (installed) {
    try {
      const hooksPath = getWindsurfHooksPath()
      if (existsSync(hooksPath)) {
        const content = await fs.readFile(hooksPath, 'utf-8')
        const hooksFile = JSON.parse(content) as WindsurfHooksFile
        const hooks = hooksFile.hooks?.pre_user_prompt ?? []
        hasHook = hooks.some((h) => h.command?.includes('edison-hook'))
      }
    } catch { /* ignore */ }
  }
  return { installed, hasHook, hookCount: hasHook ? 1 : 0, totalHooks: WINDSURF_TOTAL_HOOKS }
}

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
    getStatus: getWindsurfHookStatus,
  },

  backups: {
    globs: () => [
      `${getWindsurfConfigPath()}.backup.*`,
      `${getWindsurfHooksPath()}.backup.*`,
    ],
  },
}
