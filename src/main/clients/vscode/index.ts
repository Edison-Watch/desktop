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
 * `hooks.inject` / `hooks.remove` only cover the Copilot hook. Per-workspace
 * task injection is owned by the detector daemon; the client only detects an
 * existing workspace task (via `VSCODE_TASK_LABEL`) for status reporting.
 */
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientHookStatus, ClientIntegration, WatchTargets } from '../types'
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
  VSCODE_TASK_LABEL,
  type VsCodeCopilotHooksFile,
  type VsCodeTasksFile,
} from './hooks'
import { appInstalled } from '../shared'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { getVsCodeWorkspacePaths } from '../../runtime/mcpProjectPaths'
import type { DiscoveredMcpServer } from '../../discovery/types'

const VSCODE_INSTALL_HINTS = {
  mac: ['Visual Studio Code.app'],
  win: ['Microsoft VS Code\\Code.exe'],
  linux: ['code'],
}

async function getVsCodeHookStatus(): Promise<ClientHookStatus> {
  if (!appInstalled(VSCODE_INSTALL_HINTS)) {
    return { installed: false, hasHook: false, hookCount: 0, totalHooks: 1 }
  }
  try {
    const workspacePaths = await getVsCodeWorkspacePaths()
    let hookCount = 0
    let totalHooks = 0
    if (workspacePaths.length > 0) totalHooks++
    for (const wsPath of workspacePaths) {
      const tasksPath = join(wsPath, '.vscode', 'tasks.json')
      if (!existsSync(tasksPath)) continue
      try {
        const content = await fs.readFile(tasksPath, 'utf-8')
        const tasksFile = JSON.parse(content) as VsCodeTasksFile
        if (tasksFile.tasks?.some((t) => t.label === VSCODE_TASK_LABEL)) {
          hookCount++
          break
        }
      } catch { /* unreadable; skip */ }
    }

    const copilotInstalled = isVsCodeCopilotInstalled()
    if (copilotInstalled) {
      totalHooks += 4
      try {
        const copilotHooksPath = getVsCodeCopilotHooksPath()
        if (existsSync(copilotHooksPath)) {
          const content = await fs.readFile(copilotHooksPath, 'utf-8')
          const hooksFile = JSON.parse(content) as VsCodeCopilotHooksFile
          if (hooksFile.hooks?.SessionStart?.some((h) => h.command?.includes('edison-session-start'))) hookCount++
          if (hooksFile.hooks?.UserPromptSubmit?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))) hookCount++
          if (hooksFile.hooks?.PreToolUse?.some((h) => h.command?.includes('edison-session-hook') && !h.command?.includes('edison-session-end'))) hookCount++
          if (hooksFile.hooks?.Stop?.some((h) => h.command?.includes('edison-session-end'))) hookCount++
        }
      } catch { /* ignore */ }
    }

    const installed = workspacePaths.length > 0 || copilotInstalled
    return {
      installed,
      hasHook: totalHooks > 0 && hookCount === totalHooks,
      hookCount,
      totalHooks,
    }
  } catch {
    return { installed: false, hasHook: false, hookCount: 0, totalHooks: 1 }
  }
}

const meta = CLIENT_DISPLAY['vscode']

export const integration: ClientIntegration = {
  id: 'vscode',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled(): boolean {
    return appInstalled(VSCODE_INSTALL_HINTS)
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
    getStatus: getVsCodeHookStatus,
  },

  backups: {
    globs: () => [
      `${getVscodeUserMcpPath()}.backup.*`,
      `${getVsCodeCopilotHooksPath()}.backup.*`,
    ],
  },
}
