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
  getClaudeCodeProjectMcpPaths
} from './mcpProjectPaths'

// Re-export so callers don't need to know about the split
export { getCursorWorkspaceStoragePath, getCursorProjectMcpPaths, getCursorPluginsInstalledPath, getCursorPluginsInstalledPaths, getCursorPluginMcpPaths, getClaudeCodeProjectMcpPaths }
export { getServerFingerprint } from './seenServersStore'
export { getClaudeCoworkConfigPath, parseClaudeCoworkConfig } from './mcpDiscoveryCowork'
export { getAntigravityConfigPath, parseAntigravityMcpJson } from './mcpDiscoveryAntigravity'
export { getCursorStateDbPath, discoverCursorMarketplaceMcps } from './mcpDiscoveryCursorMarketplace'
import { discoverClaudeCowork, deduplicateByNameAndConfig } from './mcpDiscoveryCowork'
import { discoverAntigravity } from './mcpDiscoveryAntigravity'
import { discoverCursorMarketplaceMcps } from './mcpDiscoveryCursorMarketplace'

// Standardized structures we return to the renderer. Designed to be easily extensible
// to additional MCP clients beyond VS Code.
export type McpClientId =
  | 'vscode'
  | 'vscode-insiders'
  | 'cursor'
  | 'claude-desktop'
  | 'claude-cowork'
  | 'claude-code'
  | 'windsurf'
  | 'zed'
  | 'antigravity'
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
      // http server (bare url, no type — used by Cursor and others)
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
  client: McpClientId
  source: 'user' | 'workspace' | 'remote' | 'unknown' | 'enterprise' | 'project' | 'marketplace'
  path: string
  config: McpServerConfig
  projectName?: string
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

// VS Code Insiders file locations
export function getVscodeInsidersUserMcpPath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code - Insiders',
        'User',
        'mcp.json'
      )
    default:
      return join(homedir(), '.config', 'Code - Insiders', 'User', 'mcp.json')
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
  client: 'vscode' | 'vscode-insiders' = 'vscode'
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

// Claude Code specific file locations
export function getClaudeCodeUserSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export function getClaudeCodeLocalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.local.json')
}

export function getClaudeCodeHomeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

export function getClaudeCodeDedicatedMcpPath(): string {
  return join(homedir(), '.claude', 'mcp_servers.json')
}

export function getClaudeCodeManagedMcpPath(): string | null {
  switch (platform()) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode/managed-mcp.json'
    case 'win32':
      return 'C:\\ProgramData\\ClaudeCode\\managed-mcp.json'
    default:
      return '/etc/claude-code/managed-mcp.json'
  }
}

// Parse Claude Code settings.json (shape: { mcpServers?: { [name]: { ... } }, ... })
// Exported for testing
export async function parseClaudeCodeSettingsJson(
  filePath: string
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
      client: 'claude-code',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// Parse Claude Code managed-mcp.json or .mcp.json (shape: { mcpServers: { [name]: { ... } } })
// Exported for testing
export async function parseClaudeCodeMcpJson(
  filePath: string,
  source: 'enterprise' | 'project'
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers: Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'claude-code',
      source,
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

// Parse ~/.claude.json which may contain either root mcpServers or a
// projects map whose values contain mcpServers
// Exported for testing
export async function parseClaudeHomeJson(filePath: string): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
    projects?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>
  }

  const servers: DiscoveredMcpServer[] = []

  // Top-level mcpServers (treat as user scope)
  const topLevel = Object.entries(json.mcpServers ?? {})
  for (const [name, cfg] of topLevel) {
    servers.push({
      name,
      client: 'claude-code',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }

  // Projects map (treat as project scope)
  const projects = json.projects ?? {}
  for (const [projectPath, projCfg] of Object.entries(projects)) {
    const projectName = basename(projectPath)
    const entries = Object.entries(projCfg?.mcpServers ?? {})
    for (const [name, cfg] of entries) {
      servers.push({
        name,
        client: 'claude-code',
        source: 'project',
        path: filePath,
        config: cfg as McpServerConfig,
        projectName
      })
    }
  }

  return servers
}

// Parse dedicated ~/.claude/mcp_servers.json which may either be
// { mcpServers: { ... } } or a direct mapping of servers
// Exported for testing
export async function parseClaudeDedicatedMcpServers(
  filePath: string
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as Record<string, unknown>

  // Check if it has mcpServers key or is a direct mapping
  let mapping: Record<string, McpServerConfig>
  if ('mcpServers' in json && json.mcpServers && typeof json.mcpServers === 'object') {
    mapping = json.mcpServers as Record<string, McpServerConfig>
  } else {
    mapping = json as Record<string, McpServerConfig>
  }

  const servers: DiscoveredMcpServer[] = []
  const entries = Object.entries(mapping ?? {})
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: 'claude-code',
      source: 'user',
      path: filePath,
      config: cfg as McpServerConfig
    })
  }
  return servers
}

async function discoverClaudeCode(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  // Claude Code user settings: ~/.claude/settings.json
  try {
    const userPath = getClaudeCodeUserSettingsPath()
    await fs.access(userPath)
    const userServers = await parseClaudeCodeSettingsJson(userPath)
    results.push(...userServers)
  } catch {
    // File not found or unreadable; ignore
  }

  // Claude Code user local overrides: ~/.claude/settings.local.json
  try {
    const localPath = join(homedir(), '.claude', 'settings.local.json')
    await fs.access(localPath)
    const localServers = await parseClaudeCodeSettingsJson(localPath)
    results.push(...localServers)
  } catch {
    // ignore
  }

  // Main ~/.claude.json — top-level user-scoped mcpServers and per-project mcpServers
  try {
    const homeJsonPath = join(homedir(), '.claude.json')
    await fs.access(homeJsonPath)
    const homeJsonServers = await parseClaudeHomeJson(homeJsonPath)
    results.push(...homeJsonServers)
  } catch {
    // ignore
  }

  // Dedicated ~/.claude/mcp_servers.json
  try {
    const dedicatedPath = join(homedir(), '.claude', 'mcp_servers.json')
    await fs.access(dedicatedPath)
    const dedicatedServers = await parseClaudeDedicatedMcpServers(dedicatedPath)
    results.push(...dedicatedServers)
  } catch {
    // ignore
  }

  // Project-scoped .mcp.json in each known project directory
  // (project scope: checked into repo, shared with team — distinct from per-project mcpServers in ~/.claude.json)
  const projectMcpPaths = await getClaudeCodeProjectMcpPaths()
  for (const mcpPath of projectMcpPaths) {
    try {
      await fs.access(mcpPath)
      const projectName = basename(dirname(mcpPath))
      const servers = await parseClaudeCodeMcpJson(mcpPath, 'project')
      // Tag each server with the project name for display
      for (const s of servers) {
        s.projectName = projectName
      }
      results.push(...servers)
    } catch {
      // .mcp.json doesn't exist in this project; ignore
    }
  }

  // Claude Code enterprise managed MCP
  try {
    const managedPath = getClaudeCodeManagedMcpPath()
    if (managedPath) {
      await fs.access(managedPath)
      const managedServers = await parseClaudeCodeMcpJson(managedPath, 'enterprise')
      results.push(...managedServers)
    }
  } catch {
    // File not found or unreadable; ignore
  }

  return results
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

  // Plugin-bundled MCP servers: ~/.cursor/plugins/cache/<marketplace>/<plugin>/latest/.mcp.json
  const pluginMcpPaths = await getCursorPluginMcpPaths()
  for (const mcpPath of pluginMcpPaths) {
    try {
      await fs.access(mcpPath)
      const servers = await parseCursorMcpJson(mcpPath, 'user')
      results.push(...servers)
    } catch {
      // Plugin doesn't define MCP servers; ignore
    }
  }

  // Marketplace MCP apps (OAuth + plugin- prefixed) — read-only from Cursor's internal state
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
  'vscode-insiders': ['Visual Studio Code - Insiders.app'],
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

export async function discoverMcpServers(): Promise<DiscoveredMcpServer[]> {
  const results: DiscoveredMcpServer[] = []

  // VS Code (stable) - user-level configuration.
  try {
    const userPath = getVscodeUserMcpPath()
    await fs.access(userPath)
    const vsUser = await parseVscodeMcpJson(userPath, 'vscode')
    results.push(...vsUser)
  } catch {
    // File not found or unreadable; ignore for now.
  }

  // VS Code Insiders - user-level configuration.
  try {
    const insidersPath = getVscodeInsidersUserMcpPath()
    await fs.access(insidersPath)
    const vsInsiders = await parseVscodeMcpJson(insidersPath, 'vscode-insiders')
    results.push(...vsInsiders)
  } catch {
    // File not found or unreadable; ignore for now.
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

  // Antigravity discovery
  const antigravityServers = await discoverAntigravity()
  results.push(...antigravityServers)

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

  // On macOS, filter out servers whose GUI client .app is not actually installed
  const deduped = deduplicateByNameAndConfig(results)
  if (platform() !== 'darwin') return deduped

  const installedCache = new Map<string, boolean>()
  const filtered: DiscoveredMcpServer[] = []
  for (const server of deduped) {
    let installed = installedCache.get(server.client)
    if (installed === undefined) {
      installed = await macAppExists(server.client)
      installedCache.set(server.client, installed)
    }
    if (installed) filtered.push(server)
  }
  return filtered
}

// McpConfigPaths and getAllConfigPaths moved to ./mcpConfigPaths
