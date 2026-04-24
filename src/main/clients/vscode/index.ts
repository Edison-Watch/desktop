/**
 * VS Code ClientIntegration.
 *
 * VS Code has two hook surfaces:
 *   1. A per-workspace task in `.vscode/tasks.json` (label "Edison Watch
 *      Registration") that triggers on folder-open.
 *   2. GitHub Copilot's hooks file at `~/.copilot/hooks/hooks.json`
 *      (SessionStart, UserPromptSubmit, PreToolUse, Stop).
 * MCP discovery reads both the user `mcp.json` and the VS Code `state.vscdb`
 * which Extension API installs populate.
 *
 * For this scaffolding PR, `hooks.inject` / `hooks.remove` only cover the
 * Copilot hook - workspace task injection is per-workspace and orchestrated
 * separately by `injectVsCodeWorkspaceHook`.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import {
  discoverVscodeStateMcps,
  getVscodeStateDbPath,
  getVscodeUserMcpPath,
  parseVscodeMcpJson,
} from './discovery'
import {
  getVsCodeCopilotHooksPath,
  injectVsCodeCopilotHook,
  isVsCodeCopilotInstalled,
  removeVsCodeCopilotHook,
} from './hooks'
import { appBundleExists } from '../shared'
import { promises as fs } from 'fs'
import type { DiscoveredMcpServer } from '../../discovery/types'

const meta = CLIENT_DISPLAY['vscode']

export const integration: ClientIntegration = {
  id: 'vscode',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled(): boolean {
    return appBundleExists(['Visual Studio Code.app'])
  },

  async discoverServers() {
    const results: DiscoveredMcpServer[] = []
    try {
      await fs.access(getVscodeUserMcpPath())
      results.push(...await parseVscodeMcpJson(getVscodeUserMcpPath(), 'vscode'))
    } catch { /* user mcp.json missing */ }
    const state = await discoverVscodeStateMcps('vscode')
    const known = new Set(results.map((s) => s.name.toLowerCase()))
    for (const s of state) {
      if (!known.has(s.name.toLowerCase())) results.push(s)
    }
    return results
  },

  async configEntries(): Promise<McpConfigEntry[]> {
    return [
      { client: 'vscode', path: getVscodeUserMcpPath(), kind: 'json', scope: 'user' },
      { client: 'vscode', path: getVscodeStateDbPath(), kind: 'sqlite-state', scope: 'marketplace' },
    ]
  },

  async watchTargets(): Promise<WatchTargets> {
    return {
      files: await integration.configEntries(),
      dirs: [],
      needsPeriodicRescan: true,
    }
  },

  hooks: {
    supportedEvents: {
      'session-start': { nativeName: 'SessionStart' },
      'user-prompt-submit': { nativeName: 'UserPromptSubmit' },
      'pre-tool-use': { nativeName: 'PreToolUse' },
      'session-end': { nativeName: 'Stop' },
    },
    sessionIdStrategy: { kind: 'native-stdin', field: 'sessionId' },
    inject: async () => {
      if (!isVsCodeCopilotInstalled()) return false
      return injectVsCodeCopilotHook()
    },
    remove: removeVsCodeCopilotHook,
  },

  backups: {
    globs: () => [
      `${getVscodeUserMcpPath()}.backup.*`,
      `${getVsCodeCopilotHooksPath()}.backup.*`,
    ],
  },
}
