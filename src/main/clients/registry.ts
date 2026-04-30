/**
 * Unified MCP config-path registry + per-client integration map.
 *
 * `CLIENTS` / `CLIENT_LIST` give every orchestrator a uniform way to reach a
 * client's discovery, hook, and (future) edison-mcp operations. The helpers
 * (`getAllConfigEntries`, `buildEntryMap`, `getWatchablePaths`) delegate to
 * each integration's `configEntries()` instead of branching on client id.
 */
import type { ClientIntegration } from './types'
import type { McpClientId } from '../discovery/types'
import {
  getVscodeUserMcpPath,
} from './vscode/discovery'
import { getCursorConfigPath } from './cursor/discovery'
import {
  getClaudeCodeUserSettingsPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeDedicatedMcpPath,
} from './claude-code/discovery'
import { getWindsurfConfigPath } from './windsurf/discovery'
import { getZedConfigPath } from './zed/discovery'
import { getCodexConfigPath } from './codex/hooks'
import {
  getCursorWorkspaceStoragePath,
  getCursorPluginCachePath,
} from '../runtime/mcpProjectPaths'

import { integration as claudeCode } from './claude-code'
import { integration as claudeDesktop } from './claude-desktop'
import { integration as claudeCowork } from './claude-cowork'
import { integration as codex } from './codex'
import { integration as cursor } from './cursor'
import { integration as vscode } from './vscode'
import { integration as windsurf } from './windsurf'
import { integration as zed } from './zed'
import { integration as intellij } from './jetbrains/intellij'
import { integration as pycharm } from './jetbrains/pycharm'
import { integration as webstorm } from './jetbrains/webstorm'

// ── Client integration map ───────────────────────────────────────────────────

/**
 * Every supported client, keyed by McpClientId.
 *
 * Orchestrators (hookInjection, mcpConfigWriter, mcpConfigActions,
 * mcpConfigMonitor, mcpDiscovery) iterate over this map instead of branching
 * on client id.
 */
export const CLIENTS: Record<McpClientId, ClientIntegration> = {
  'claude-code': claudeCode,
  'claude-desktop': claudeDesktop,
  'claude-cowork': claudeCowork,
  codex,
  cursor,
  vscode,
  windsurf,
  zed,
  intellij,
  pycharm,
  webstorm,
}

/** All integrations as an array, in the insertion order of `CLIENTS`. */
export const CLIENT_LIST: ClientIntegration[] = Object.values(CLIENTS)

// ── Config entries ───────────────────────────────────────────────────────────

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

/** All config paths (static + dynamically scanned), collected from every client's integration. */
export async function getAllConfigEntries(): Promise<McpConfigEntry[]> {
  const perClient = await Promise.all(CLIENT_LIST.map((c) => c.configEntries()))
  return perClient.flat()
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
export { getCursorWorkspaceStoragePath }

/** Get the Cursor plugin cache path (for the watcher that detects new plugin installs). */
export { getCursorPluginCachePath }

// ── Deprecated - use getAllConfigEntries() instead ───────────────────────────

/** @deprecated Use getAllConfigEntries() instead. */
export interface McpConfigPaths {
  vscode: string
  cursor: string
  cursorWorkspaceStorage: string
  claudeCode: string[]
  codex: string
  windsurf: string
  zed: string
}

/** @deprecated Use getAllConfigEntries() instead. */
export function getAllConfigPaths(): McpConfigPaths {
  return {
    vscode: getVscodeUserMcpPath(),
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
