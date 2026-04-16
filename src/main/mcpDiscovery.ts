import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join, basename, dirname } from 'path'
import * as jsonc from 'jsonc-parser'
import {
  getCursorWorkspaceStoragePath,
  getCursorProjectMcpPaths,
  getCursorPluginsInstalledPath,
  getCursorPluginsInstalledPaths,
  getCursorPluginMcpPaths,
  getCursorPluginCachePath,
  getClaudeCodeProjectMcpPaths
} from './mcpProjectPaths'

// Re-export so callers don't need to know about the split
export { getCursorWorkspaceStoragePath, getCursorProjectMcpPaths, getCursorPluginsInstalledPath, getCursorPluginsInstalledPaths, getCursorPluginMcpPaths, getCursorPluginCachePath, getClaudeCodeProjectMcpPaths }
export { getServerFingerprint } from './seenServersStore'
export { getClaudeCoworkConfigPath, parseClaudeCoworkConfig } from './mcpDiscoveryCowork'
export { getCursorStateDbPath, getCursorProjectsDir, discoverCursorMarketplaceMcps } from './mcpDiscoveryCursorMarketplace'
export { getVscodeStateDbPath, discoverVscodeStateMcps } from './mcpDiscoveryVscodeState'
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
} from './mcpDiscoveryClaudeCode'
import { discoverClaudeCowork, deduplicateByNameAndConfig } from './mcpDiscoveryCowork'
import { discoverClaudeCode } from './mcpDiscoveryClaudeCode'
import { discoverCursorMarketplaceMcps } from './mcpDiscoveryCursorMarketplace'
import { discoverVscodeStateMcps } from './mcpDiscoveryVscodeState'

// Standardized structures we return to the renderer. Designed to be easily extensible
// to additional MCP clients beyond VS Code.
export type McpClientId =
  | 'vscode'
  | 'cursor'
  | 'claude-desktop'
  | 'claude-cowork'
  | 'claude-code'
  | 'windsurf'
  | 'zed'
  | 'codex'
  | 'intellij'
  | 'pycharm'
  | 'webstorm'

export type McpServerTransport = 'stdio' | 'http' | 'sse'

export type McpServerConfig =
  | {
      // stdio server
      type?: undefined
      command: string
      args?: string[]
      env?: Record<string, string>
      envFile?: string
    }
  | {
      // http/sse server (with explicit type)
      type: McpServerTransport
      url: string
      headers?: Record<string, string>
    }
  | {
      // http server (bare url, no type - used by Cursor and others)
      type?: undefined
      command?: undefined
      url: string
      headers?: Record<string, string>
    }
  | {
      // IDE-managed server with no accessible launch config (e.g. Cursor marketplace MCPs)
      type: 'opaque'
    }

export interface DiscoveredMcpServer {
  name: string
  /** Original key in the config file (before deduplication suffix). Falls back to `name` when absent. */
  originalName?: string
  client: McpClientId
  /** All clients where this server was found (populated by deduplication). */
  clients?: McpClientId[]
  source: 'user' | 'workspace' | 'remote' | 'unknown' | 'enterprise' | 'project' | 'marketplace' | 'plugin'
  path: string
  config: McpServerConfig
  projectName?: string
  /** Claude Code profile name (when discovered inside a profiles.{name} block). */
  profileName?: string
}

/** Check whether a server config is opaque (IDE-managed, no accessible launch config). */
export function isOpaqueConfig(config: McpServerConfig): boolean {
  return 'type' in config && config.type === 'opaque'
}

/**
 * Human-readable explanation of why a server was classified as unsupported.
 * Returns null for supported servers.
 *
 * All opaque configs today come from IDE state databases or per-project metadata
 * files that don't expose a launch command - so the text is keyed on source/client
 * rather than requiring callers to thread a reason string through synthesis.
 */
export function describeUnsupportedReason(server: DiscoveredMcpServer): string | null {
  if (!isOpaqueConfig(server.config)) return null
  if (server.client === 'cursor' && server.source === 'marketplace') {
    return 'Cursor marketplace plugin: only SERVER_METADATA.json is exposed (no launch config)'
  }
  if ((server.client === 'vscode' || server.client === 'claude-desktop') && server.source === 'marketplace') {
    return 'VS Code-style extension-managed server: state DB exposes no launch URL or command'
  }
  if (server.source === 'marketplace') {
    return `${server.client} marketplace install exposes no launch config`
  }
  return 'Opaque config (no launch command or URL surfaced by the host)'
}

// VS Code specific file locations (macOS first pass). We keep this in a function so
// adding Windows/Linux/Insiders variants is trivial.
export function getVscodeUserMcpPath(): string {
  // Example path confirmed across docs and community references:
  // ~/Library/Application Support/Code/User/mcp.json
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code',
        'User',
        'mcp.json'
      )
    default:
      return join(homedir(), '.config', 'Code', 'User', 'mcp.json')
  }
}

// Claude Desktop config path
export function getClaudeDesktopConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      )
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Claude',
        'claude_desktop_config.json'
      )
    default:
      return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
  }
}

// Cursor global user-level config path (same on all platforms)
export function getCursorConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

// Windsurf (Codeium) config path (same on all platforms)
export function getWindsurfConfigPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json')
}

// Zed config path (MCP servers in assistant.mcp_servers)
export function getZedConfigPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), '.config', 'zed', 'settings.json')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Zed',
        'settings.json'
      )
    default:
      return join(homedir(), '.config', 'zed', 'settings.json')
  }
}

// JetBrains IDE base directory (macOS and Windows only; plan scope)
function getJetBrainsBaseDir(): string | null {
  const plat = platform()
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'JetBrains')
  }
  if (plat === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'JetBrains')
  }
  return null
}

// IDE folder prefix -> McpClientId for common JetBrains IDEs
const JETBRAINS_IDE_PREFIXES: Array<{ prefix: string; client: 'intellij' | 'pycharm' | 'webstorm' }> = [
  { prefix: 'IntelliJIdea', client: 'intellij' },
  { prefix: 'PyCharm', client: 'pycharm' },
  { prefix: 'WebStorm', client: 'webstorm' }
]

/**
 * Scan JetBrains base dir and return which IDEs have a preferences folder present
 * (regardless of whether mcp/servers.json exists yet).
 * Only supports macOS and Windows; returns empty set on other platforms.
 */
export async function getInstalledJetBrainsIdes(): Promise<Set<'intellij' | 'pycharm' | 'webstorm'>> {
  const base = getJetBrainsBaseDir()
  if (!base) return new Set()
  const result = new Set<'intellij' | 'pycharm' | 'webstorm'>()
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      for (const { prefix, client } of JETBRAINS_IDE_PREFIXES) {
        if (dirent.name.startsWith(prefix)) {
          result.add(client)
          break
        }
      }
    }
  } catch { /* Base dir missing or unreadable */ }
  return result
}

/**
 * Scan JetBrains base dir for IDE folders and return MCP config paths.
 * Only supports macOS and Windows; returns [] on other platforms.
 */
export async function getJetBrainsMcpConfigPaths(): Promise<
  Array<{ client: 'intellij' | 'pycharm' | 'webstorm'; path: string }>
> {
  const base = getJetBrainsBaseDir()
  if (!base) return []

  const result: Array<{ client: 'intellij' | 'pycharm' | 'webstorm'; path: string }> = []
  try {
    const entries = await fs.readdir(base, { withFileTypes: true })
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      const name = dirent.name
      for (const { prefix, client } of JETBRAINS_IDE_PREFIXES) {
        if (name.startsWith(prefix)) {
          const serversPath = join(base, name, 'mcp', 'servers.json')
          try {
            await fs.access(serversPath)
            result.push({ client, path: serversPath })
          } catch {
            // servers.json missing or unreadable; skip
          }
          break
        }
      }
    }
  } catch {
    // Base dir missing or unreadable
  }
  return result
}

// Parse JetBrains mcp/servers.json (shape: { mcpServers?: { [name]: { ... } } })
export async function parseJetBrainsServersJson(
  filePath: string,
  client: 'intellij' | 'pycharm' | 'webstorm'
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client,
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// Parse a VS Code-style mcp.json (shape: { servers: { [name]: { ... } }, inputs?: [...] })
// Exported for testing
export async function parseVscodeMcpJson(
  filePath: string,
  client: 'vscode' = 'vscode'
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    servers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.servers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client,
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// Parse Claude Desktop config (shape: { mcpServers?: { [name]: { ... } } })
// Exported for testing
export async function parseClaudeDesktopConfig(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'claude-desktop',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

async function discoverClaudeDesktop(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  try {
    const configPath = getClaudeDesktopConfigPath()
    await fs.access(configPath)
    const servers = await parseClaudeDesktopConfig(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  return results
}

// Parse Cursor mcp.json (shape: { mcpServers?: { [name]: { ... } } })
// Exported for testing
export async function parseCursorMcpJson(
  filePath: string,
  source: DiscoveredMcpServer['source'] = 'user',
  projectName?: string
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  // Cursor config files commonly contain trailing commas; use JSONC parser
  const json = jsonc.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'cursor',
      source,
      path: filePath,
      config: cfg as McpServerConfig,
      ...(projectName !== undefined ? { projectName } : {})
    })
  }
  return servers
}

async function discoverCursor(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  // Global user-level config: ~/.cursor/mcp.json
  try {
    const configPath = getCursorConfigPath()
    await fs.access(configPath)
    const servers = await parseCursorMcpJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  // Project-level configs: .cursor/mcp.json in each known workspace
  const projectMcpPaths = await getCursorProjectMcpPaths()
  for (const mcpPath of projectMcpPaths) {
    try {
      await fs.access(mcpPath)
      const projectName = basename(dirname(dirname(mcpPath))) // project dir name
      const servers = await parseCursorMcpJson(mcpPath, 'project', projectName)
      results.push(...servers)
    } catch {
      // File doesn't exist in this project; ignore
    }
  }

  // Plugin-bundled MCP servers: ~/.cursor/plugins/cache/<marketplace>/<plugin>/<sha>/mcp.json
  // Include every plugin whose cache mcp.json exists, even if Cursor hasn't
  // finished writing the project-side entry yet. We deliberately do NOT wait
  // for a matching projects/<proj>/mcps/plugin-<name>/ dir: Cursor's install is
  // a two-phase write (cache first, projects second), so gating on both would
  // hide a freshly-installed plugin from quarantine until the next rescan tick
  // that happens to fall after phase 2. Quarantine is already best-effort on
  // both sides (mcpQuarantineCursorPlugins.quarantineCursorPlugin moves
  // whichever dirs happen to exist at the time, ignoring missing ones).
  const pluginMcpPaths = await getCursorPluginMcpPaths()
  for (const mcpPath of pluginMcpPaths) {
    try {
      await fs.access(mcpPath)
      const servers = await parseCursorMcpJson(mcpPath, 'plugin')
      results.push(...servers)
    } catch {
      // Plugin doesn't define MCP servers; ignore
    }
  }

  // Marketplace MCP apps (OAuth + plugin- prefixed) - read-only from Cursor's internal state
  const marketplaceMcps = await discoverCursorMarketplaceMcps()
  // Deduplicate: marketplace servers already in mcp.json should not appear twice
  const existingNames = new Set(results.map((s) => s.name.toLowerCase()))
  for (const mcp of marketplaceMcps) {
    if (!existingNames.has(mcp.name.toLowerCase())) {
      results.push(mcp)
    }
  }

  return results
}

// Parse Windsurf mcp_config.json (shape: { mcpServers?: { [name]: { ... } } })
// Exported for testing
export async function parseWindsurfMcpJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'windsurf',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

async function discoverWindsurf(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  try {
    const configPath = getWindsurfConfigPath()
    await fs.access(configPath)
    const servers = await parseWindsurfMcpJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  return results
}

// Parse Zed settings.json (shape: { context_servers?: { [name]: { ... } } })
// Exported for testing
export async function parseZedSettingsJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    context_servers?: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const mcpServers = json.context_servers ?? {}
  const entries = Object.entries(mcpServers)
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'zed',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

async function discoverZed(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  try {
    const configPath = getZedConfigPath()
    await fs.access(configPath)
    const servers = await parseZedSettingsJson(configPath)
    results.push(...servers)
  } catch {
    // File not found or unreadable; ignore
  }

  return results
}

// On macOS, map client ids to possible .app bundle names.
// Clients without an entry are CLI-only and always pass the check.
// JetBrains IDEs can have variant names (e.g. "IntelliJ IDEA CE.app").
export const MAC_APP_NAMES: Record<string, string[]> = {
  vscode: ['Visual Studio Code.app'],
  cursor: ['Cursor.app'],
  windsurf: ['Windsurf.app'],
  zed: ['Zed.app'],
  'claude-desktop': ['Claude.app'],
  'claude-cowork': ['Claude.app'],
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

export interface DiscoveryResult { servers: DiscoveredMcpServer[]; raw: DiscoveredMcpServer[]; unsupported: DiscoveredMcpServer[] }

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

  // Claude Desktop discovery
  const claudeDesktopServers = await discoverClaudeDesktop()
  results.push(...claudeDesktopServers)

  // Claude Cowork discovery (shares config with Desktop; separate client tag)
  const claudeCoworkServers = await discoverClaudeCowork()
  results.push(...claudeCoworkServers)

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
