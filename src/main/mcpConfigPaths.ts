/**
 * Unified MCP config-path registry.
 *
 * Single source of truth for all MCP config file paths across all agents.
 * Used by discovery, the config monitor, and quarantine restore so they
 * never drift out of sync.
 */
import type { McpClientId } from './mcpDiscovery'
import {
  getVscodeUserMcpPath,
  getClaudeDesktopConfigPath,
  getCursorConfigPath,
  getCursorWorkspaceStoragePath,
  getClaudeCodeUserSettingsPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeDedicatedMcpPath,
  getClaudeCodeManagedMcpPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getJetBrainsMcpConfigPaths,
  getCursorProjectMcpPaths,
  getCursorPluginMcpPaths,
  getCursorPluginsInstalledPaths,
  getClaudeCodeProjectMcpPaths,
} from './mcpDiscovery'
import { getClaudeCoworkConfigPath } from './mcpDiscoveryCowork'
import { getCursorStateDbPath } from './mcpDiscoveryCursorMarketplace'
import { getVscodeStateDbPath } from './mcpDiscoveryVscodeState'
import { getCodexConfigPath } from './hookInjectionClients'

/** Describes a single MCP config file or database. */
export interface McpConfigEntry {
  /** Which client this config belongs to */
  client: McpClientId
  /** The resolved file path */
  path: string
  /** File format: json, jsonc (VS Code/Zed), toml (Codex), or sqlite-state (marketplace DBs) */
  kind: 'json' | 'jsonc' | 'toml' | 'sqlite-state'
  /** Scope of the config */
  scope: 'user' | 'project' | 'enterprise' | 'marketplace' | 'plugin-registry'
  /**
   * When this path changes, should the monitor trigger a rescan of dynamic paths?
   * e.g. ~/.claude.json changes → rescan Claude Code project paths.
   */
  triggersDynamicRescan?: 'claude-code-projects' | 'cursor-plugins'
}

// ── Static (sync) entries ────────────────────────────────────────────────────

/** All statically-known config paths (no I/O required). */
export function getStaticConfigEntries(): McpConfigEntry[] {
  const entries: McpConfigEntry[] = [
    // VS Code
    { client: 'vscode', path: getVscodeUserMcpPath(), kind: 'json', scope: 'user' },
    { client: 'vscode', path: getVscodeStateDbPath(), kind: 'sqlite-state', scope: 'marketplace' },

    // Claude Desktop
    { client: 'claude-desktop', path: getClaudeDesktopConfigPath(), kind: 'json', scope: 'user' },

    // Claude Cowork
    { client: 'claude-cowork', path: getClaudeCoworkConfigPath(), kind: 'json', scope: 'user' },

    // Cursor
    { client: 'cursor', path: getCursorConfigPath(), kind: 'jsonc', scope: 'user' },
    { client: 'cursor', path: getCursorStateDbPath(), kind: 'sqlite-state', scope: 'marketplace' },
    // Plugin registry files (trigger rescan of plugin .mcp.json paths when changed)
    ...getCursorPluginsInstalledPaths().map((p): McpConfigEntry => ({
      client: 'cursor', path: p, kind: 'json', scope: 'plugin-registry',
      triggersDynamicRescan: 'cursor-plugins',
    })),

    // Claude Code
    { client: 'claude-code', path: getClaudeCodeUserSettingsPath(), kind: 'json', scope: 'user' },
    { client: 'claude-code', path: getClaudeCodeLocalSettingsPath(), kind: 'json', scope: 'user' },
    {
      client: 'claude-code', path: getClaudeCodeHomeJsonPath(), kind: 'json', scope: 'user',
      triggersDynamicRescan: 'claude-code-projects',
    },
    { client: 'claude-code', path: getClaudeCodeDedicatedMcpPath(), kind: 'json', scope: 'user' },

    // Codex
    { client: 'codex', path: getCodexConfigPath(), kind: 'toml', scope: 'user' },

    // Windsurf
    { client: 'windsurf', path: getWindsurfConfigPath(), kind: 'json', scope: 'user' },

    // Zed
    { client: 'zed', path: getZedConfigPath(), kind: 'json', scope: 'user' },
  ]

  // Claude Code enterprise managed MCP (platform-dependent, may be null)
  const managedPath = getClaudeCodeManagedMcpPath()
  if (managedPath) {
    entries.push({ client: 'claude-code', path: managedPath, kind: 'json', scope: 'enterprise' })
  }

  return entries
}

// ── Dynamic (async) entries ──────────────────────────────────────────────────

/** All config paths including dynamically-scanned ones (JetBrains, Cursor projects/plugins, Claude Code projects). */
export async function getAllConfigEntries(): Promise<McpConfigEntry[]> {
  const entries = getStaticConfigEntries()

  const [jetbrainsPaths, cursorProjectPaths, cursorPluginPaths, claudeCodeProjectPaths] =
    await Promise.all([
      getJetBrainsMcpConfigPaths(),
      getCursorProjectMcpPaths(),
      getCursorPluginMcpPaths(),
      getClaudeCodeProjectMcpPaths(),
    ])

  for (const { client, path } of jetbrainsPaths) {
    entries.push({ client, path, kind: 'json', scope: 'user' })
  }
  for (const path of cursorProjectPaths) {
    entries.push({ client: 'cursor', path, kind: 'jsonc', scope: 'project' })
  }
  for (const path of cursorPluginPaths) {
    entries.push({ client: 'cursor', path, kind: 'json', scope: 'user' })
  }
  for (const path of claudeCodeProjectPaths) {
    entries.push({ client: 'claude-code', path, kind: 'json', scope: 'project' })
  }

  return entries
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a lookup map from path → entry for O(1) access. */
export function buildEntryMap(entries: McpConfigEntry[]): Map<string, McpConfigEntry> {
  const map = new Map<string, McpConfigEntry>()
  for (const e of entries) {
    map.set(e.path, e)
  }
  return map
}

/** Get all watchable file paths (excludes sqlite-state which needs special handling). */
export function getWatchablePaths(entries: McpConfigEntry[]): string[] {
  return entries.filter((e) => e.kind !== 'sqlite-state').map((e) => e.path)
}

/** Get the Cursor workspaceStorage path (for the depth:1 watcher that detects new projects). */
export { getCursorWorkspaceStoragePath } from './mcpDiscovery'

// ── Deprecated — use getAllConfigEntries() instead ───────────────────────────

/** @deprecated Use getStaticConfigEntries() or getAllConfigEntries() instead. */
export interface McpConfigPaths {
  vscode: string
  claudeDesktop: string
  claudeCowork: string
  cursor: string
  cursorWorkspaceStorage: string
  claudeCode: string[]
  codex: string
  windsurf: string
  zed: string
}

/** @deprecated Use getStaticConfigEntries() or getAllConfigEntries() instead. */
export function getAllConfigPaths(): McpConfigPaths {
  return {
    vscode: getVscodeUserMcpPath(),
    claudeDesktop: getClaudeDesktopConfigPath(),
    claudeCowork: getClaudeCoworkConfigPath(),
    cursor: getCursorConfigPath(),
    cursorWorkspaceStorage: getCursorWorkspaceStoragePath(),
    claudeCode: [
      getClaudeCodeUserSettingsPath(),
      getClaudeCodeLocalSettingsPath(),
      getClaudeCodeHomeJsonPath(),
      getClaudeCodeDedicatedMcpPath()
    ],
    codex: getCodexConfigPath(),
    windsurf: getWindsurfConfigPath(),
    zed: getZedConfigPath(),
  }
}
