/**
 * Config writer for applying Edison Watch MCP server entries to client configs.
 *
 * Supports all 11 MCP clients. For "overwrite" clients (vscode, cursor, etc.)
 * a fresh config is written. For "merge" clients (claude-code, zed, jetbrains)
 * the existing config is read, the edison-watch entry is added/replaced, and
 * the file is written back preserving other settings.
 */
import { promises as fs, existsSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as jsonc from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

const execFileAsync = promisify(execFile)

import type { McpClientId, McpServerConfig } from './mcpDiscovery'
import {
  getVscodeUserMcpPath,
  getCursorConfigPath,
  getCursorProjectMcpPaths,
  getClaudeDesktopConfigPath,
  getClaudeCodeHomeJsonPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getClaudeCoworkConfigPath,
  getJetBrainsMcpConfigPaths,
} from './mcpDiscovery'
import { getCodexConfigPath } from './hookInjectionClients'
import {
  readConfigFile,
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
  dryRun?: boolean
}

export interface ApplyIntegrationsResult {
  success: boolean
  modifiedConfigs: ModifiedConfig[]
  errors?: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Build the Edison Watch MCP server entry for a given client. */
function buildEdisonEntry(
  clientId: McpClientId,
  url: string,
  headers?: Record<string, string>,
): Record<string, unknown> {
  // Clients that need explicit type: "http" for reliable Streamable HTTP detection.
  // Cursor v2.5+ has known MCP detection bugs - explicit type avoids silent failures.
  const needsExplicitType: McpClientId[] = [
    'vscode',
    'claude-desktop',
    'cursor',
  ]
  if (needsExplicitType.includes(clientId)) {
    return { type: 'http', url, ...(headers && { headers }) }
  }
  // All others: url only (type implied)
  return { url, ...(headers && { headers }) }
}

/** Map an appId string to its config path and client type. */
async function getPathForApp(
  appId: string,
): Promise<{ configPath: string; clientId: McpClientId } | null> {
  // claude-code is handled separately via applyToClaudeCode() - not in this map
  const STATIC_MAP: Record<string, () => string> = {
    vscode: getVscodeUserMcpPath,
    cursor: getCursorConfigPath,
    'claude-desktop': getClaudeDesktopConfigPath,
    'claude-cowork': getClaudeCoworkConfigPath,
    windsurf: getWindsurfConfigPath,
    zed: getZedConfigPath,
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

/**
 * Remove edison-watch from ~/.mcp.json if present.
 *
 * Claude Code treats ~/.mcp.json as a project-scope config that shadows
 * user-scope entries in ~/.claude.json. Stale entries here (e.g. from older
 * app versions or manual setup) cause "Failed to connect" or "not registered"
 * status even when the user-scope registration is correct.
 */
async function cleanupHomeMcpJson(): Promise<void> {
  const homeMcpJson = join(homedir(), '.mcp.json')
  if (!existsSync(homeMcpJson)) return

  try {
    const raw = await fs.readFile(homeMcpJson, 'utf-8')
    const json = JSON.parse(raw) as Record<string, unknown>
    const servers = json.mcpServers as Record<string, unknown> | undefined
    if (!servers || !('edison-watch' in servers)) return

    delete servers['edison-watch']

    // Remove the file only if mcpServers was the only top-level key and is now empty
    const remainingKeys = Object.keys(json).filter((k) => k !== 'mcpServers')
    if (Object.keys(servers).length === 0 && remainingKeys.length === 0) {
      await fs.unlink(homeMcpJson)
      console.log('[mcpConfigWriter] Removed empty ~/.mcp.json after cleaning edison-watch entry')
    } else {
      json.mcpServers = servers
      await fs.writeFile(homeMcpJson, JSON.stringify(json, null, 2), 'utf-8')
      console.log('[mcpConfigWriter] Removed edison-watch from ~/.mcp.json')
    }
  } catch {
    // Ignore - file may be malformed or inaccessible
  }
}

/**
 * Remove edison-watch from Cursor project-scope .cursor/mcp.json files.
 *
 * Cursor's project-level config (.cursor/mcp.json in workspace dirs) takes
 * precedence over the global ~/.cursor/mcp.json. Stale edison-watch entries
 * in project configs (e.g. from manual setup or older app versions) shadow
 * the global registration and cause "not recognized" errors.
 */
async function cleanupCursorProjectMcpJson(): Promise<void> {
  let projectPaths: string[]
  try {
    projectPaths = await getCursorProjectMcpPaths()
  } catch {
    return
  }

  for (const mcpPath of projectPaths) {
    if (!existsSync(mcpPath)) continue
    try {
      const raw = await fs.readFile(mcpPath, 'utf-8')
      // Cursor configs commonly contain trailing commas - use JSONC parser
      const json = jsonc.parse(raw) as Record<string, unknown>
      const servers = json.mcpServers as Record<string, unknown> | undefined
      if (!servers || !('edison-watch' in servers)) continue

      // Use jsonc.modify + applyEdits to preserve comments, trailing commas,
      // and formatting in team-shared project configs checked into repos.
      const edits = jsonc.modify(raw, ['mcpServers', 'edison-watch'], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' },
      })
      const updated = jsonc.applyEdits(raw, edits)
      await fs.writeFile(mcpPath, updated, 'utf-8')
      console.log(`[mcpConfigWriter] Removed stale edison-watch from Cursor project config: ${mcpPath}`)
    } catch {
      // Ignore - file may be malformed or inaccessible
    }
  }
}

/**
 * Apply Edison Watch MCP to Claude Code using the `claude` CLI.
 * Claude Code reads MCPs from ~/.claude.json, NOT from ~/.claude/settings.json.
 * The `claude mcp add` CLI is the safe way to register servers without risking
 * race conditions with the volatile ~/.claude.json runtime state file.
 *
 * Falls back to direct ~/.claude.json write if CLI is unavailable.
 */
async function applyToClaudeCode(
  url: string,
  headers: Record<string, string> | undefined,
  timestamp: string,
  dryRun: boolean,
): Promise<ModifiedConfig | null> {
  if (dryRun) {
    console.log(`[dry-run] Would add edison-watch to Claude Code via CLI: ${url}`)
    return { appId: 'claude-code', configPath: '(via claude mcp add)', backupPath: '' }
  }

  // Clean up conflicting project-scope entries in ~/.mcp.json that shadow
  // the user-scope registration we're about to create.
  await cleanupHomeMcpJson()

  // Remove any existing edison-watch entries from both user and project scopes
  // to prevent stale registrations from interfering.
  try {
    await execFileAsync('claude', ['mcp', 'remove', 'edison-watch', '--scope', 'user'], { timeout: 10_000 })
  } catch {
    // Ignore - entry may not exist
  }
  try {
    await execFileAsync('claude', ['mcp', 'remove', 'edison-watch', '--scope', 'project'], { timeout: 10_000 })
  } catch {
    // Ignore - entry may not exist
  }

  // Try `claude mcp add` CLI, forwarding any auth headers via --header flags
  const headerArgs = headers
    ? Object.entries(headers).flatMap(([k, v]) => ['--header', `${k}: ${v}`])
    : []
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', ...headerArgs, 'edison-watch', url]

  try {
    await execFileAsync('claude', args, { timeout: 10_000 })
    console.log('[mcpConfigWriter] Added edison-watch to Claude Code via CLI')
    return { appId: 'claude-code', configPath: getClaudeCodeHomeJsonPath(), backupPath: '' }
  } catch (err) {
    // CLI failed - fall back to direct ~/.claude.json write
    console.warn(
      `[mcpConfigWriter] claude mcp add failed, falling back to direct write: ${err instanceof Error ? err.message : String(err)}`
    )
    return await applyToClaudeCodeFallback(url, headers, timestamp)
  }
}

/** Fallback: write directly to ~/.claude.json top-level mcpServers. */
async function applyToClaudeCodeFallback(
  url: string,
  headers: Record<string, string> | undefined,
  timestamp: string,
): Promise<ModifiedConfig> {
  const configPath = getClaudeCodeHomeJsonPath()
  const backupPath = `${configPath}.backup.${timestamp}.json`

  // Backup existing file
  if (existsSync(configPath)) {
    await fs.copyFile(configPath, backupPath)
  }

  // Read, merge, write
  let json: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    json = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // File doesn't exist or is invalid - start fresh
  }

  const mcpServers = (json.mcpServers ?? {}) as Record<string, unknown>
  mcpServers['edison-watch'] = { type: 'http', url, ...(headers && { headers }) }
  json.mcpServers = mcpServers

  await fs.writeFile(configPath, JSON.stringify(json, null, 2), 'utf-8')
  console.log('[mcpConfigWriter] Added edison-watch to ~/.claude.json (fallback)')

  return {
    appId: 'claude-code',
    configPath,
    backupPath: existsSync(backupPath) ? backupPath : '',
  }
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
    // File does not exist or is invalid - start fresh
  }

  const servers = { ...(getServersFromConfig(config, clientId) ?? {}) }
  servers['edison-watch'] = edisonEntry as McpServerConfig
  setServersInConfig(config, clientId, servers)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Apply Edison Watch MCP to Codex CLI by writing to ~/.codex/config.toml.
 * Merges with existing content (preserving hooks and other settings).
 */
async function applyToCodex(
  url: string,
  headers: Record<string, string> | undefined,
  timestamp: string,
  dryRun: boolean,
): Promise<ModifiedConfig | null> {
  const configPath = getCodexConfigPath()
  const backupPath = `${configPath}.backup.${timestamp}.toml`

  if (dryRun) {
    console.log(`[dry-run] Would write edison-watch MCP to Codex config.toml: ${url}`)
    return { appId: 'codex', configPath, backupPath: '' }
  }

  // Ensure parent directory exists
  await fs.mkdir(dirname(configPath), { recursive: true })

  // Read existing content
  let existing = ''
  if (existsSync(configPath)) {
    existing = await fs.readFile(configPath, 'utf-8')
    await fs.copyFile(configPath, backupPath)
  }

  // Remove any existing [mcp_servers.edison-watch] section
  // Use negative lookahead to match section body (handles URLs with '[' e.g. IPv6)
  const sectionRegex = /\n?\[mcp_servers\.edison-watch\][^\n]*\n(?:(?!\n\[)[\s\S])*?(?=\n\[|\s*$)/g
  let cleaned = existing.replace(sectionRegex, '')

  // Build the new TOML section (escape values for valid TOML)
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  let tomlSection = '\n[mcp_servers.edison-watch]\nurl = "' + esc(url) + '"\n'
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      tomlSection += `http_headers."${esc(key)}" = "${esc(value)}"\n`
    }
  }

  // Append the new section (avoid leading blank line on fresh files)
  cleaned = cleaned.replace(/\n*$/, '') // trim trailing newlines
  const final = cleaned ? cleaned + '\n' + tomlSection : tomlSection.replace(/^\n/, '')

  await fs.writeFile(configPath, final, 'utf-8')
  console.log('[mcpConfigWriter] Added edison-watch MCP to Codex config.toml')

  return {
    appId: 'codex',
    configPath,
    backupPath: existsSync(backupPath) ? backupPath : '',
  }
}

/** Apply Edison Watch config to a single app. Returns modified config info. */
async function applyToApp(
  appId: string,
  url: string,
  headers: Record<string, string> | undefined,
  timestamp: string,
  dryRun: boolean,
): Promise<ModifiedConfig | null> {
  // Claude Code needs special handling: CLI-based add to ~/.claude.json
  if (appId === 'claude-code') {
    return applyToClaudeCode(url, headers, timestamp, dryRun)
  }

  // Codex CLI needs special handling: TOML format config
  if (appId === 'codex') {
    return applyToCodex(url, headers, timestamp, dryRun)
  }

  // Clean up stale edison-watch entries from Cursor project-scope configs
  // that could shadow the global ~/.cursor/mcp.json registration.
  if (appId === 'cursor' && !dryRun) {
    await cleanupCursorProjectMcpJson()
  }

  const resolved = await getPathForApp(appId)
  if (!resolved) return null

  const { configPath, clientId } = resolved
  const backupPath = `${configPath}.backup.${timestamp}.json`

  const entry = buildEdisonEntry(clientId, url, headers)

  if (dryRun) {
    console.log(`[dry-run] Would write to ${configPath}:`, JSON.stringify(entry, null, 2))
    return { appId, configPath, backupPath: '' }
  }

  // Ensure parent directory exists
  await fs.mkdir(dirname(configPath), { recursive: true })

  // Backup existing file
  if (existsSync(configPath)) {
    await fs.copyFile(configPath, backupPath)
  }

  await mergeEdisonEntry(configPath, clientId, entry)

  return {
    appId,
    configPath,
    backupPath: existsSync(backupPath) ? backupPath : '',
  }
}

// ── Health check ─────────────────────────────────────────────────────

/** Strip query string from a URL for base-URL comparison. */
function stripQueryString(url: string): string {
  const idx = url.indexOf('?')
  return idx >= 0 ? url.substring(0, idx) : url
}

/**
 * Check whether edison-watch is registered in a given app's MCP config
 * with the correct URL. Returns true only if the entry exists AND the URL
 * matches the expected value (ignoring ?client= query params added per-app).
 * This catches both missing entries and stale entries left over from a
 * previous environment or account.
 *
 * Claude Code is deferred to the caller (uses CLI-based check).
 * Codex uses TOML section header + URL matching.
 */
export async function isEdisonWatchRegistered(
  appId: string,
  expectedUrl?: string,
): Promise<boolean> {
  // Claude Code: use CLI check (already exists in setupConfig.ts)
  if (appId === 'claude-code') {
    // Defer to the caller - claude-code has its own check via checkClaudeCodeMcpConnection()
    return true
  }

  // Codex: parse TOML config and check for edison-watch section with correct URL
  if (appId === 'codex') {
    try {
      const content = await fs.readFile(getCodexConfigPath(), 'utf-8')
      const toml = parseToml(content) as Record<string, unknown>
      const mcpServers = toml.mcp_servers as Record<string, unknown> | undefined
      if (!mcpServers) return false
      const edisonWatch = mcpServers['edison-watch'] as Record<string, unknown> | undefined
      if (!edisonWatch || typeof edisonWatch.url !== 'string') return false
      if (expectedUrl && stripQueryString(edisonWatch.url) !== stripQueryString(expectedUrl)) return false
      return true
    } catch {
      return false
    }
  }

  // File-based apps: read JSON config and check for edison-watch key + URL
  const pathInfo = await getPathForApp(appId)
  if (!pathInfo) return false

  try {
    const config = await readConfigFile(pathInfo.configPath, pathInfo.clientId)
    const servers = getServersFromConfig(config, pathInfo.clientId)
    if (servers == null || !('edison-watch' in servers)) return false
    if (expectedUrl) {
      const entry = servers['edison-watch'] as Record<string, unknown>
      if (stripQueryString(entry.url as string) !== stripQueryString(expectedUrl)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Check all configured apps and return the list of apps where edison-watch
 * is missing or has a stale URL. Skips claude-code (handled separately).
 */
export async function findAppsNeedingReRegistration(
  configuredApps: string[],
  expectedUrl?: string,
): Promise<string[]> {
  const missing: string[] = []
  for (const appId of configuredApps) {
    if (appId === 'claude-code') continue // handled by checkClaudeCodeMcpConnection
    const registered = await isEdisonWatchRegistered(appId, expectedUrl)
    if (!registered) {
      missing.push(appId)
    }
  }
  return missing
}

/**
 * Find apps whose edison-watch URL is registered but missing the ?client= tag.
 * Used for one-time migration to add per-client identity to MCP URLs.
 */
export async function findAppsMissingClientTag(
  configuredApps: string[],
): Promise<string[]> {
  const needsTag: string[] = []
  for (const appId of configuredApps) {
    // Claude Code: check ~/.claude.json top-level mcpServers
    if (appId === 'claude-code') {
      try {
        const raw = await fs.readFile(getClaudeCodeHomeJsonPath(), 'utf-8')
        const json = JSON.parse(raw) as Record<string, unknown>
        const servers = json.mcpServers as Record<string, unknown> | undefined
        const ew = servers?.['edison-watch'] as Record<string, unknown> | undefined
        if (ew && typeof ew.url === 'string' && !ew.url.includes('?client=')) {
          needsTag.push(appId)
        }
      } catch { /* not registered */ }
      continue
    }

    // Codex: check TOML config
    if (appId === 'codex') {
      try {
        const content = await fs.readFile(getCodexConfigPath(), 'utf-8')
        const toml = parseToml(content) as Record<string, unknown>
        const mcpServers = toml.mcp_servers as Record<string, unknown> | undefined
        const ew = mcpServers?.['edison-watch'] as Record<string, unknown> | undefined
        if (ew && typeof ew.url === 'string' && !ew.url.includes('?client=')) {
          needsTag.push(appId)
        }
      } catch { /* not registered */ }
      continue
    }

    // File-based apps: read JSON config
    const pathInfo = await getPathForApp(appId)
    if (!pathInfo) continue
    try {
      const config = await readConfigFile(pathInfo.configPath, pathInfo.clientId)
      const servers = getServersFromConfig(config, pathInfo.clientId)
      if (servers && 'edison-watch' in servers) {
        const entry = servers['edison-watch'] as Record<string, unknown>
        if (typeof entry.url === 'string' && !entry.url.includes('?client=')) {
          needsTag.push(appId)
        }
      }
    } catch { /* not registered */ }
  }
  return needsTag
}

// ── Main entry point ──────────────────────────────────────────────────

export async function applyAppIntegrations(
  args: ApplyIntegrationsArgs,
): Promise<ApplyIntegrationsResult> {
  const { mcpBaseUrl, apiKey, edisonSecretKey, apps, dryRun = false } = args

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
      // Tag each client's MCP URL so the server can identify the connecting agent.
      // The server dispatcher extracts the ?client= param and injects it as an
      // x-edison-client header for session tracking middleware to read.
      const appUrl = `${url}?client=${encodeURIComponent(appId)}`
      const result = await applyToApp(appId, appUrl, headers, timestamp, dryRun)
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
