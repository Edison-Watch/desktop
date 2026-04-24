/**
 * MCP Server Discovery - aggregator and re-export hub.
 *
 * Discovers MCP servers from all supported clients and deduplicates them.
 * Per-client discovery logic lives in clients/{client}/discovery.ts.
 *
 * This module re-exports types and per-client functions so that existing
 * consumers can update their import path without changing named imports.
 */
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, DiscoveryResult } from './types'
import { isOpaqueConfig } from './types'
import { clientAlias } from './serverDeduplication'

// ── Re-exports (backward compatibility) ────────────────────────────────────

// Types
export type { McpClientId, McpServerTransport, McpServerConfig, DiscoveredMcpServer, DiscoveryResult } from './types'
export { isOpaqueConfig, describeUnsupportedReason } from './types'

// Per-client discovery
export { getVscodeUserMcpPath, getVscodeStateDbPath, discoverVscodeStateMcps, parseVscodeMcpJson } from '../clients/vscode/discovery'
export { getCursorConfigPath, parseCursorMcpJson, discoverCursor } from '../clients/cursor/discovery'
export { getCursorStateDbPath, getCursorProjectsDir, discoverCursorMarketplaceMcps } from '../clients/cursor/marketplace'
export { getWindsurfConfigPath, parseWindsurfMcpJson, discoverWindsurf } from '../clients/windsurf/discovery'
export { getZedConfigPath, parseZedSettingsJson, discoverZed } from '../clients/zed/discovery'
export { getJetBrainsMcpConfigPaths, getInstalledJetBrainsIdes, parseJetBrainsServersJson } from '../clients/jetbrains/discovery'
export {
  getClaudeCodeUserSettingsPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeDedicatedMcpPath,
  getClaudeCodeManagedMcpPath,
  parseClaudeCodeSettingsJson,
  parseClaudeCodeMcpJson,
  parseClaudeHomeJson,
  parseClaudeDedicatedMcpServers,
} from '../clients/claude-code/discovery'
import { discoverClaudeCode } from '../clients/claude-code/discovery'

// Runtime / project paths
export {
  getCursorWorkspaceStoragePath,
  getCursorProjectMcpPaths,
  getCursorPluginsInstalledPaths,
  getCursorPluginMcpPaths,
  getCursorPluginCachePath,
  getClaudeCodeProjectMcpPaths,
  getVsCodeWorkspacePaths,
} from '../runtime/mcpProjectPaths'

// Seen servers
export { getServerFingerprint } from './seenServersStore'

// ── Imports for aggregator ──────────────────────────────────────────────────

import { getVscodeUserMcpPath, discoverVscodeStateMcps, parseVscodeMcpJson } from '../clients/vscode/discovery'
import { discoverCursor } from '../clients/cursor/discovery'
import { discoverWindsurf } from '../clients/windsurf/discovery'
import { discoverZed } from '../clients/zed/discovery'
import { getJetBrainsMcpConfigPaths, parseJetBrainsServersJson } from '../clients/jetbrains/discovery'

// ── macOS app existence check ───────────────────────────────────────────────

// On macOS, map client ids to possible .app bundle names.
export const MAC_APP_NAMES: Record<string, string[]> = {
  vscode: ['Visual Studio Code.app'],
  cursor: ['Cursor.app'],
  windsurf: ['Windsurf.app'],
  zed: ['Zed.app'],
  intellij: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Ultimate.app'],
  pycharm: ['PyCharm.app', 'PyCharm CE.app'],
  webstorm: ['WebStorm.app'],
}

/** On macOS, check whether a GUI client's .app bundle exists. CLI-only clients always pass. */
export async function macAppExists(clientId: string): Promise<boolean> {
  if (platform() !== 'darwin') return true
  const appNames = MAC_APP_NAMES[clientId]
  if (!appNames) return true
  for (const appName of appNames) {
    try { await fs.access(join('/Applications', appName)); return true } catch { /* */ }
    try { await fs.access(join(homedir(), 'Applications', appName)); return true } catch { /* */ }
  }
  return false
}

// ── Aggregator ──────────────────────────────────────────────────────────────

export async function discoverMcpServers(): Promise<DiscoveredMcpServer[]>
export async function discoverMcpServers(opts: { includeRaw: true }): Promise<DiscoveryResult>
export async function discoverMcpServers(opts?: { includeRaw?: boolean }): Promise<DiscoveredMcpServer[] | DiscoveryResult> {
  const results: DiscoveredMcpServer[] = []

  // VS Code - user-level mcp.json file
  try { await fs.access(getVscodeUserMcpPath()); results.push(...await parseVscodeMcpJson(getVscodeUserMcpPath(), 'vscode')) } catch { /* */ }

  // VS Code state.vscdb - extension-provided MCP servers (marketplace)
  {
    const stateMcps = await discoverVscodeStateMcps('vscode')
    const known = new Set(results.map((s) => s.name.toLowerCase()))
    for (const mcp of stateMcps) {
      if (!known.has(mcp.name.toLowerCase())) results.push(mcp)
    }
  }

  // Claude Code discovery
  const claudeCodeServers = await discoverClaudeCode()
  results.push(...claudeCodeServers)

  // Cursor discovery
  const cursorServers = await discoverCursor()
  results.push(...cursorServers)

  // Windsurf discovery
  const windsurfServers = await discoverWindsurf()
  results.push(...windsurfServers)

  // Zed discovery
  const zedServers = await discoverZed()
  results.push(...zedServers)

  // JetBrains IDEs (IntelliJ, PyCharm, WebStorm) - macOS and Windows only
  const jetbrainsPaths = await getJetBrainsMcpConfigPaths()
  for (const { client, path } of jetbrainsPaths) {
    try {
      const servers = await parseJetBrainsServersJson(path, client)
      results.push(...servers)
    } catch {
      // File unreadable or invalid JSON
    }
  }

  // Separate opaque (unsupported) servers before deduplication
  const supported: DiscoveredMcpServer[] = []
  const unsupportedRaw: DiscoveredMcpServer[] = []
  for (const s of results) {
    if (isOpaqueConfig(s.config)) unsupportedRaw.push(s)
    else supported.push(s)
  }
  // Deduplicate unsupported list by name+client (same opaque server from multiple config paths)
  const unsupported: DiscoveredMcpServer[] = []
  const seenUnsupported = new Set<string>()
  for (const s of unsupportedRaw) {
    const key = `${s.name}:${s.client}`
    if (!seenUnsupported.has(key)) {
      seenUnsupported.add(key)
      unsupported.push(s)
    }
  }

  // On macOS, filter out servers whose GUI client .app is not actually installed
  const deduped = deduplicateByNameAndConfig(supported)
  const wrap = (servers: DiscoveredMcpServer[]) =>
    opts?.includeRaw ? { servers, raw: supported, unsupported } : servers

  if (platform() !== 'darwin') return wrap(deduped)

  const installedCache = new Map<string, boolean>()
  const filtered: DiscoveredMcpServer[] = []
  for (const server of deduped) {
    const clientsToCheck = server.clients ?? [server.client]
    let anyInstalled = false
    for (const c of clientsToCheck) {
      let installed = installedCache.get(c)
      if (installed === undefined) {
        installed = await macAppExists(c)
        installedCache.set(c, installed)
      }
      if (installed) { anyInstalled = true; break }
    }
    if (anyInstalled) filtered.push(server)
  }
  return wrap(filtered)
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate discovered MCP servers by name + config.
 *
 * - Entries with the same name AND identical config (command/args/url) are
 *   collapsed into one (true duplicates across clients).
 * - Entries with the same name but different configs are kept but renamed
 *   `name_2`, `name_3`, … so every entry has a unique name.
 */
export function deduplicateByNameAndConfig(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
  const byName = new Map<string, DiscoveredMcpServer[]>()
  for (const server of servers) {
    const group = byName.get(server.name) ?? []
    group.push(server)
    byName.set(server.name, group)
  }

  const configKey = (s: DiscoveredMcpServer): string => {
    const c = s.config
    if ('command' in c && c.command) return JSON.stringify({ command: c.command, args: c.args ?? [] })
    if ('url' in c) return JSON.stringify({ url: c.url })
    return JSON.stringify(c)
  }

  const result: DiscoveredMcpServer[] = []
  for (const [, group] of byName) {
    if (group.length === 1) { result.push({ ...group[0], clients: [group[0].client] }); continue }

    // Collapse true duplicates (same name + same config), merging clients.
    const seen = new Map<string, DiscoveredMcpServer>()
    for (const server of group) {
      const key = configKey(server)
      const existing = seen.get(key)
      if (existing) {
        const clients = existing.clients ?? [existing.client]
        if (!clients.includes(server.client)) clients.push(server.client)
        existing.clients = clients
      } else {
        seen.set(key, { ...server, clients: [server.client] })
      }
    }

    const unique = [...seen.values()]
    if (unique.length === 1) {
      result.push(unique[0])
    } else {
      // Different configs under the same name - rename to disambiguate.
      const clientSet = new Set(unique.map((e) => e.client))
      if (clientSet.size === unique.length) {
        // Each entry from a different client - simple alias suffix
        for (const entry of unique) {
          const alias = clientAlias(entry.client)
          result.push({ ...entry, name: `${entry.name}_${alias}`, originalName: entry.name })
        }
      } else {
        // Some entries share a client - use numeric suffixes per client
        const clientCounter = new Map<string, number>()
        for (const entry of unique) {
          const alias = clientAlias(entry.client)
          const count = (clientCounter.get(alias) ?? 0) + 1
          clientCounter.set(alias, count)
          const suffix = count > 1 || unique.filter((e) => e.client === entry.client).length > 1
            ? `${alias}_${count}` : alias
          result.push({ ...entry, name: `${entry.name}_${suffix}`, originalName: entry.name })
        }
      }
    }
  }

  return result
}
