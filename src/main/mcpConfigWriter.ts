/**
 * Config writer for applying Edison Watch MCP server entries to client configs.
 *
 * Supports all 11 MCP clients. For "overwrite" clients (vscode, cursor, etc.)
 * a fresh config is written. For "merge" clients (claude-code, zed, jetbrains)
 * the existing config is read, the edison-watch entry is added/replaced, and
 * the file is written back preserving other settings.
 */
import { promises as fs, existsSync } from 'fs'
import { dirname } from 'path'

import type { McpClientId, McpServerConfig } from './mcpDiscovery'
import {
  getVscodeUserMcpPath,
  getVscodeInsidersUserMcpPath,
  getCursorConfigPath,
  getClaudeDesktopConfigPath,
  getClaudeCodeUserSettingsPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getAntigravityConfigPath,
  getJetBrainsMcpConfigPaths,
} from './mcpDiscovery'
import {
  readConfigFile,
  getServersKey,
  getServersFromConfig,
  setServersInConfig,
  type ConfigFileFormat,
} from './mcpConfigActions'

// ── Public types ──────────────────────────────────────────────────────

export interface ModifiedConfig {
  appId: string
  configPath: string
  backupPath: string
}

export interface ApplyIntegrationsArgs {
  serverAddress: string
  mcpBaseUrl: string
  apiKey: string
  edisonSecretKey?: string
  apps: string[]
}

export interface ApplyIntegrationsResult {
  success: boolean
  modifiedConfigs: ModifiedConfig[]
  errors?: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Clients whose config files contain other settings we must preserve. */
function isMergeClient(clientId: McpClientId): boolean {
  return ['claude-code', 'zed', 'intellij', 'pycharm', 'webstorm'].includes(clientId)
}

/** Build the Edison Watch MCP server entry for a given client. */
function buildEdisonEntry(
  clientId: McpClientId,
  url: string,
  headers?: Record<string, string>,
): Record<string, unknown> {
  // VS Code variants and Claude Desktop use explicit type: "http"
  if (
    clientId === 'vscode' ||
    clientId === 'vscode-insiders' ||
    clientId === 'claude-desktop'
  ) {
    return { type: 'http', url, ...(headers && { headers }) }
  }
  // All others: url only (type implied)
  return { url, ...(headers && { headers }) }
}

/** Map an appId string to its config path and client type. */
async function getPathForApp(
  appId: string,
): Promise<{ configPath: string; clientId: McpClientId } | null> {
  const STATIC_MAP: Record<string, () => string> = {
    vscode: getVscodeUserMcpPath,
    'vscode-insiders': getVscodeInsidersUserMcpPath,
    cursor: getCursorConfigPath,
    'claude-desktop': getClaudeDesktopConfigPath,
    'claude-code': getClaudeCodeUserSettingsPath,
    windsurf: getWindsurfConfigPath,
    zed: getZedConfigPath,
    antigravity: getAntigravityConfigPath,
  }

  if (STATIC_MAP[appId]) {
    return { configPath: STATIC_MAP[appId](), clientId: appId as McpClientId }
  }

  // JetBrains IDEs require directory scanning
  if (['intellij', 'pycharm', 'webstorm'].includes(appId)) {
    const jbPaths = await getJetBrainsMcpConfigPaths()
    const match = jbPaths.find((p) => p.client === appId)
    if (match) return { configPath: match.path, clientId: match.client }
    return null
  }

  return null
}

/** For merge clients: read existing config, add edison-watch, write back. */
async function mergeEdisonEntry(
  configPath: string,
  clientId: McpClientId,
  edisonEntry: Record<string, unknown>,
): Promise<void> {
  let config: ConfigFileFormat = {}
  try {
    config = await readConfigFile(configPath, clientId)
  } catch {
    // File does not exist or is invalid — start fresh
  }

  const servers = { ...(getServersFromConfig(config, clientId) ?? {}) }
  servers['edison-watch'] = edisonEntry as McpServerConfig
  setServersInConfig(config, clientId, servers)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/** For overwrite clients: write a fresh config with just the edison-watch entry. */
async function writeEdisonConfig(
  configPath: string,
  clientId: McpClientId,
  edisonEntry: Record<string, unknown>,
): Promise<void> {
  const config: ConfigFileFormat = {}
  const key = getServersKey(clientId)
  config[key] = { 'edison-watch': edisonEntry as McpServerConfig }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/** Apply Edison Watch config to a single app. Returns modified config info. */
async function applyToApp(
  appId: string,
  url: string,
  headers: Record<string, string> | undefined,
  timestamp: string,
): Promise<ModifiedConfig | null> {
  const resolved = await getPathForApp(appId)
  if (!resolved) return null

  const { configPath, clientId } = resolved
  const backupPath = `${configPath}.backup.${timestamp}.json`

  // Ensure parent directory exists
  await fs.mkdir(dirname(configPath), { recursive: true })

  // Backup existing file
  if (existsSync(configPath)) {
    await fs.copyFile(configPath, backupPath)
  }

  const entry = buildEdisonEntry(clientId, url, headers)

  if (isMergeClient(clientId)) {
    await mergeEdisonEntry(configPath, clientId, entry)
  } else {
    await writeEdisonConfig(configPath, clientId, entry)
  }

  return {
    appId,
    configPath,
    backupPath: existsSync(backupPath) ? backupPath : '',
  }
}

// ── Main entry point ──────────────────────────────────────────────────

export async function applyAppIntegrations(
  args: ApplyIntegrationsArgs,
): Promise<ApplyIntegrationsResult> {
  const { mcpBaseUrl, apiKey, edisonSecretKey, apps } = args

  // Build MCP URL: mcpBaseUrl/mcp/{apiKey}/
  const baseUrl = mcpBaseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/mcp/${apiKey}/`

  // Build optional headers
  const headers: Record<string, string> | undefined = edisonSecretKey
    ? { 'X-Edison-Secret-Key': edisonSecretKey }
    : undefined

  // Timestamp for backup files
  const now = new Date()
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')

  const modifiedConfigs: ModifiedConfig[] = []
  const errors: string[] = []

  for (const appId of apps) {
    try {
      const result = await applyToApp(appId, url, headers, timestamp)
      if (result) modifiedConfigs.push(result)
    } catch (err) {
      errors.push(`${appId}: ${err instanceof Error ? err.message : String(err)}`)
      console.error(`[mcpConfigWriter] Failed to apply to ${appId}:`, err)
    }
  }

  return {
    success: errors.length === 0,
    modifiedConfigs,
    errors: errors.length > 0 ? errors : undefined,
  }
}
