/**
 * Claude Code ClientIntegration.
 *
 * Hooks live in `~/.claude/settings.json` under `hooks.{UserPromptSubmit,
 * PreToolUse, SessionStart, SessionEnd}`. MCP servers come from four files:
 * user settings, local settings, `~/.claude.json` (host), and an optional
 * enterprise-managed `/Library/Application Support/ClaudeCode/managed-mcp.json`.
 *
 * Claude Code uses a pid-scoped file strategy for session id: SessionStart
 * writes `~/.edison-watch/active_session_<ppid>.json`; PreToolUse reads it.
 */
import { promises as fs, existsSync } from 'fs'
import { parse as parseJsonc } from 'jsonc-parser'
import { CLIENT_DISPLAY } from '../displayMeta'
import type { ClientHookStatus, ClientIntegration, WatchTargets } from '../types'
import type { McpConfigEntry } from '../registry'
import {
  discoverClaudeCode,
  getClaudeCodeDedicatedMcpPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeManagedMcpPath,
  getClaudeCodeUserSettingsPath,
} from './discovery'
import {
  getClaudeCodeSettingsPath,
  injectClaudeCodeHook,
  isClaudeCodeInstalled,
  removeClaudeCodeHook,
  type ClaudeCodeSettings,
} from './hooks'
import { getClaudeCodeProjectMcpPaths } from '../../runtime/mcpProjectPaths'

const CLAUDE_TOTAL_HOOKS = 4

async function getClaudeCodeHookStatus(): Promise<ClientHookStatus> {
  const installed = isClaudeCodeInstalled()
  let hookCount = 0
  if (installed) {
    try {
      const settingsPath = getClaudeCodeSettingsPath()
      if (existsSync(settingsPath)) {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const settings = parseJsonc(content) as ClaudeCodeSettings
        const promptHooks = settings.hooks?.UserPromptSubmit ?? []
        const toolHooks = settings.hooks?.PreToolUse ?? []
        const startHooks = settings.hooks?.SessionStart ?? []
        const endHooks = settings.hooks?.SessionEnd ?? []
        if (promptHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
        )) hookCount++
        if (toolHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
        )) hookCount++
        if (startHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-start'))
        )) hookCount++
        if (endHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-end'))
        )) hookCount++
      }
    } catch { /* ignore */ }
  }
  return { installed, hasHook: hookCount === CLAUDE_TOTAL_HOOKS, hookCount, totalHooks: CLAUDE_TOTAL_HOOKS }
}

const meta = CLIENT_DISPLAY['claude-code']

export const integration: ClientIntegration = {
  id: 'claude-code',
  display: { name: meta.name, brandColor: meta.brandColor },

  isInstalled: isClaudeCodeInstalled,

  discoverServers: discoverClaudeCode,

  async configEntries(): Promise<McpConfigEntry[]> {
    const entries: McpConfigEntry[] = [
      { client: 'claude-code', path: getClaudeCodeUserSettingsPath(), kind: 'json', scope: 'user' },
      { client: 'claude-code', path: getClaudeCodeLocalSettingsPath(), kind: 'json', scope: 'user' },
      {
        client: 'claude-code',
        path: getClaudeCodeHomeJsonPath(),
        kind: 'json',
        scope: 'user',
        triggersDynamicRescan: 'claude-code-projects',
      },
      { client: 'claude-code', path: getClaudeCodeDedicatedMcpPath(), kind: 'json', scope: 'user' },
    ]
    const managed = getClaudeCodeManagedMcpPath()
    if (managed) {
      entries.push({ client: 'claude-code', path: managed, kind: 'json', scope: 'enterprise' })
    }
    for (const p of await getClaudeCodeProjectMcpPaths()) {
      entries.push({ client: 'claude-code', path: p, kind: 'json', scope: 'project' })
    }
    return entries
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
      'user-prompt-submit': { nativeName: 'UserPromptSubmit' },
      'pre-tool-use': { nativeName: 'PreToolUse', matcher: 'mcp__*' },
      'session-start': { nativeName: 'SessionStart' },
      'session-end': { nativeName: 'SessionEnd' },
    },
    sessionIdStrategy: { kind: 'pid-scoped-file', ppidBased: true },
    inject: injectClaudeCodeHook,
    remove: removeClaudeCodeHook,
    getStatus: getClaudeCodeHookStatus,
  },

  backups: {
    globs: () => [
      `${getClaudeCodeSettingsPath()}.backup.*`,
      `${getClaudeCodeHomeJsonPath()}.backup.*`,
      `${getClaudeCodeDedicatedMcpPath()}.backup.*`,
    ],
  },
}
