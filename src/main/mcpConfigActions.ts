import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import { dirname, basename, join } from 'path'
import * as jsonc from 'jsonc-parser'
import type { DiscoveredMcpServer, McpServerConfig, McpClientId } from './mcpDiscovery'
import {
  getJetBrainsMcpConfigPaths,
  getCursorPluginMcpPaths,
  getCursorProjectMcpPaths,
  getClaudeCodeProjectMcpPaths,
} from './mcpDiscovery'
import { getAllConfigPaths } from './mcpConfigPaths'
import { detectSecrets } from './secretDetection'

/**
 * Structure for the disabled/quarantined servers file.
 */
export interface QuarantinedServersFile {
  quarantinedBy: string
  servers: Record<
    string,
    McpServerConfig & {
      originalFile: string
      quarantinedAt: string
    }
  >
}

export interface QuarantineResult {
  server: DiscoveredMcpServer
  originalPath: string
  disabledPath: string
  quarantinedAt: string
}

export interface ConfigFileFormat {
  // VS Code uses "servers", others use "mcpServers"
  servers?: Record<string, McpServerConfig>
  mcpServers?: Record<string, McpServerConfig>
  // Zed uses assistant.mcp_servers
  assistant?: {
    mcp_servers?: Record<string, McpServerConfig>
    [key: string]: unknown
  }
  // Other fields we want to preserve
  [key: string]: unknown
}

/**
 * Check if a client supports JSONC (JSON with Comments).
 */
function supportsJsonc(client: McpClientId): boolean {
  return client === 'vscode' || client === 'vscode-insiders'
}

/**
 * Read and parse a config file, handling JSONC for VS Code.
 */
export async function readConfigFile(filePath: string, client?: McpClientId): Promise<ConfigFileFormat> {
  const raw = await fs.readFile(filePath, 'utf-8')
  if (client && supportsJsonc(client)) {
    return jsonc.parse(raw) as ConfigFileFormat
  }
  return JSON.parse(raw) as ConfigFileFormat
}

/**
 * Write config back to file with backup.
 */
export async function writeConfigFile(
  filePath: string,
  config: ConfigFileFormat,
  createBackup = true
): Promise<void> {
  if (createBackup && existsSync(filePath)) {
    const now = new Date()
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const backupPath = `${filePath}.backup.${timestamp}.json`
    await fs.copyFile(filePath, backupPath)
    console.log(`[MCP Config] Created backup: ${backupPath}`)
  }

  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`[MCP Config] Wrote config: ${filePath}`)
}

/**
 * Get the servers object key for a given client type.
 */
export function getServersKey(client: McpClientId): 'servers' | 'mcpServers' {
  // VS Code uses "servers", all others use "mcpServers"
  // Note: Zed uses assistant.mcp_servers which is handled separately
  return client === 'vscode' || client === 'vscode-insiders' ? 'servers' : 'mcpServers'
}

/**
 * Get the servers map from a config, handling Zed's nested structure.
 */
export function getServersFromConfig(
  config: ConfigFileFormat,
  client: McpClientId
): Record<string, McpServerConfig> | undefined {
  if (client === 'zed') {
    return config.assistant?.mcp_servers
  }
  const key = getServersKey(client)
  return config[key] as Record<string, McpServerConfig> | undefined
}

/**
 * Set the servers map in a config, handling Zed's nested structure.
 */
export function setServersInConfig(
  config: ConfigFileFormat,
  client: McpClientId,
  servers: Record<string, McpServerConfig>
): void {
  if (client === 'zed') {
    if (!config.assistant) {
      config.assistant = {}
    }
    config.assistant.mcp_servers = servers
  } else {
    const key = getServersKey(client)
    config[key] = servers
  }
}

/**
 * Disable a server in its original config file.
 * For VS Code (JSONC): Comments out the server entry.
 * For others: Renames with _disabled_ prefix.
 * Creates a backup of the original file.
 */
export async function disableServerInConfig(server: DiscoveredMcpServer): Promise<void> {
  const raw = await fs.readFile(server.path, 'utf-8')
  const serversKey = getServersKey(server.client)

  // Create backup first
  if (existsSync(server.path)) {
    const now = new Date()
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const backupPath = `${server.path}.backup.${timestamp}.json`
    await fs.copyFile(server.path, backupPath)
    console.log(`[MCP Config] Created backup: ${backupPath}`)
  }

  if (supportsJsonc(server.client)) {
    // VS Code: Comment out the server entry using JSONC
    const result = commentOutServerInJsonc(raw, serversKey, server.name)
    await fs.writeFile(server.path, result, 'utf-8')
    console.log(`[MCP Config] Commented out server "${server.name}" in ${server.path}`)
  } else {
    // Others: Rename with _disabled_ prefix
    const config = JSON.parse(raw) as ConfigFileFormat
    const servers = config[serversKey] as Record<string, McpServerConfig> | undefined

    if (!servers || !(server.name in servers)) {
      throw new Error(`Server "${server.name}" not found in config file`)
    }

    // Move to disabled key
    const disabledName = `_disabled_${server.name}`
    servers[disabledName] = servers[server.name]
    delete servers[server.name]
    config[serversKey] = servers

    await fs.writeFile(server.path, JSON.stringify(config, null, 2), 'utf-8')
    console.log(
      `[MCP Config] Renamed server "${server.name}" to "${disabledName}" in ${server.path}`
    )
  }
}

/**
 * Comment out a server entry in a JSONC file.
 * Uses jsonc-parser to find the exact location and wraps it in block comments.
 */
function commentOutServerInJsonc(content: string, serversKey: string, serverName: string): string {
  const tree = jsonc.parseTree(content)
  if (!tree) {
    throw new Error('Failed to parse JSONC content')
  }

  // Find the servers object
  const serversNode = jsonc.findNodeAtLocation(tree, [serversKey])
  if (!serversNode || serversNode.type !== 'object') {
    throw new Error(`"${serversKey}" not found in config`)
  }

  // Find the specific server entry
  const serverNode = jsonc.findNodeAtLocation(tree, [serversKey, serverName])
  if (!serverNode) {
    throw new Error(`Server "${serverName}" not found in ${serversKey}`)
  }

  // Find the property node (includes the key name)
  // The serverNode is the value, we need to find its parent property
  const serverPropertyNode = serversNode.children?.find(
    (child) => child.type === 'property' && child.children?.[0]?.value === serverName
  )

  if (!serverPropertyNode) {
    throw new Error(`Could not find property node for "${serverName}"`)
  }

  const start = serverPropertyNode.offset
  let end = serverPropertyNode.offset + serverPropertyNode.length

  // Check if there's a trailing comma after this entry
  const afterEntry = content.slice(end)
  const trailingCommaMatch = afterEntry.match(/^\s*,/)
  if (trailingCommaMatch) {
    end += trailingCommaMatch[0].length
  }

  // Extract the server entry text
  const serverText = content.slice(start, end)

  // Check if there's a leading comma before this entry (and it's not the first entry)
  const beforeEntry = content.slice(0, start)
  const leadingCommaMatch = beforeEntry.match(/,\s*$/)
  let actualStart = start
  if (leadingCommaMatch && !trailingCommaMatch) {
    // Remove leading comma instead if no trailing comma
    actualStart = start - leadingCommaMatch[0].length
  }

  // Build the commented version
  const commentedText = `/* DISABLED by Edison Watch:\n${serverText.trim()}\n*/`

  // Replace in content
  if (actualStart !== start) {
    return content.slice(0, actualStart) + '\n    ' + commentedText + content.slice(end)
  }
  return content.slice(0, start) + commentedText + content.slice(end)
}

/**
 * Remove a server from its original config file (deletes the entry).
 * Creates a backup of the original file.
 */
export async function removeServerFromConfig(server: DiscoveredMcpServer): Promise<void> {
  const config = await readConfigFile(server.path, server.client)
  const servers = getServersFromConfig(config, server.client)

  if (!servers || !(server.name in servers)) {
    throw new Error(`Server "${server.name}" not found in config file`)
  }

  // Create backup first
  if (existsSync(server.path)) {
    const now = new Date()
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const backupPath = `${server.path}.backup.${timestamp}.json`
    await fs.copyFile(server.path, backupPath)
    console.log(`[MCP Config] Created backup: ${backupPath}`)
  }

  // Delete the server entry
  delete servers[server.name]
  setServersInConfig(config, server.client, servers)

  await fs.writeFile(server.path, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`[MCP Config] Removed server "${server.name}" from ${server.path}`)
}

/**
 * Replace a server with Edison Watch proxy in its original config file.
 * Creates a backup of the original file.
 */
export async function replaceServerWithProxy(
  server: DiscoveredMcpServer,
  edisonWatchUrl: string,
  edisonSecretKey?: string
): Promise<void> {
  const config = await readConfigFile(server.path, server.client)
  const servers = getServersFromConfig(config, server.client)

  if (!servers || !(server.name in servers)) {
    throw new Error(`Server "${server.name}" not found in config file`)
  }

  // Build headers if secret key is available
  const headers: Record<string, string> | undefined = edisonSecretKey
    ? { 'X-Edison-Secret-Key': edisonSecretKey }
    : undefined

  // Replace with Edison Watch proxy server
  // Keep the original server name but point to Edison Watch
  if (server.client === 'vscode' || server.client === 'vscode-insiders') {
    // VS Code format
    servers[server.name] = {
      type: 'http',
      url: edisonWatchUrl,
      ...(headers && { headers })
    } as McpServerConfig
  } else {
    // Claude Desktop, Cursor, Claude Code, Windsurf, Zed, Antigravity format
    servers[server.name] = {
      type: 'sse',
      url: edisonWatchUrl,
      ...(headers && { headers })
    } as McpServerConfig
  }

  setServersInConfig(config, server.client, servers)

  await writeConfigFile(server.path, config)
  console.log(
    `[MCP Config] Replaced server "${server.name}" with Edison Watch proxy in ${server.path}`
  )
}

/**
 * Submit a server request to the Edison Watch backend for IT admin review.
 * Returns the request_id from the backend response (used for auto-approval by admins).
 */
export async function submitServerRequest(
  server: DiscoveredMcpServer,
  apiBaseUrl: string,
  apiKey: string,
  userId?: string
): Promise<{ request_id: number; secretValues?: Record<string, string>; alreadyPending?: boolean }> {
  const serverConfig = server.config

  // Validate that server has either command (stdio) or url (HTTP/SSE).
  // Stdio servers are identified by presence of command (McpServerConfig uses type?: undefined for stdio).
  const hasCommand = 'command' in serverConfig && !!serverConfig.command
  const hasUrl = 'url' in serverConfig && !!serverConfig.url

  if (!hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server config has neither 'command' (for stdio servers) nor 'url' (for HTTP/SSE servers). The config may be malformed.`
    )
  }
  // Reject malformed stdio: configs that claim type 'stdio' but have no command (e.g. loose JSON).
  const typeVal = (serverConfig as Record<string, unknown>).type
  if (typeVal === 'stdio' && !hasCommand) {
    throw new Error(
      `Cannot request server "${server.name}": stdio server must have a 'command' field.`
    )
  }
  // Servers without explicit type (or type undefined) are assumed stdio and must have command.
  if (!('type' in serverConfig) && !hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server appears to be stdio type but has no 'command' field.`
    )
  }

  // Detect secrets and produce templatized config + template_fields
  const { config: templatizedConfig, templateFields, secretValues } = detectSecrets(server)

  // Build request payload
  const payload: Record<string, unknown> = {
    name: server.name,
    source_app: server.client,
    source_path: server.path,
    justification: `Detected in ${server.client} configuration`,
    user_id: userId
  }

  // Add config details with secrets replaced by {PLACEHOLDER} variables.
  // Include template_fields so the backend knows the schema of required secrets.
  if (hasCommand) {
    payload.command = (templatizedConfig as { command: string }).command
    payload.args = (templatizedConfig as { args?: string[] }).args
    // Send templatized env (with {PLACEHOLDERS}) so backend knows env var names
    const tEnv = (templatizedConfig as { env?: Record<string, string> }).env
    if (tEnv && Object.keys(tEnv).length > 0) {
      payload.env = tEnv
    }
  } else if (hasUrl) {
    payload.url = (templatizedConfig as { url: string }).url
    payload.type = (templatizedConfig as { type: string }).type
    const tHeaders = (templatizedConfig as { headers?: Record<string, string> }).headers
    if (tHeaders && Object.keys(tHeaders).length > 0) {
      payload.headers = tHeaders
    }
  }

  // Include template_fields if any secrets were detected
  if (
    (templateFields.args && Object.keys(templateFields.args).length > 0) ||
    (templateFields.env && Object.keys(templateFields.env).length > 0)
  ) {
    payload.template_fields = templateFields
  }

  const requestUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/mcp-requests`

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const errorText = await response.text()
    if (response.status === 409 && errorText.includes('already have a pending request')) {
      return { request_id: 0, alreadyPending: true }
    }
    throw new Error(`Failed to submit server request: ${response.status} ${errorText}`)
  }

  const responseData = (await response.json()) as { request_id: number }
  const hasSecrets = Object.keys(secretValues).length > 0
  console.log(
    `[MCP Config] Submitted server request for "${server.name}" (id: ${responseData.request_id})` +
      (hasSecrets ? ` with ${Object.keys(secretValues).length} template_fields` : '')
  )
  return {
    request_id: responseData.request_id,
    ...(hasSecrets && { secretValues })
  }
}

/**
 * Approve an MCP server request (admin/owner only).
 * Called after submitServerRequest to auto-approve when the user is admin/owner.
 */
export async function approveServerRequest(
  requestId: number,
  apiBaseUrl: string,
  apiKey: string
): Promise<void> {
  const approveUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/admin/mcp-requests/${requestId}/approve`

  const response = await fetch(approveUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ reviewer_notes: '' })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to approve server request: ${response.status} ${errorText}`)
  }

  console.log(`[MCP Config] Auto-approved server request ${requestId}`)
}

/**
 * Fetch the current user's role from the Edison Watch API.
 * Returns the role string ('admin', 'owner', 'user') or null if unavailable.
 */
export async function fetchUserRole(
  apiBaseUrl: string,
  apiKey: string
): Promise<string | null> {
  try {
    const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/user/profile`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    })
    if (!response.ok) return null
    const data = (await response.json()) as { role?: string }
    return data.role ?? null
  } catch {
    return null
  }
}

/**
 * Get the server config from a discovered server for import.
 * Returns a sanitized version: env vars with key names containing
 * key/token/secret/password/credential are redacted. Aligns with
 * submitServerRequest (client never sends env when submitting requests).
 */
export function getServerConfigForImport(server: DiscoveredMcpServer): {
  name: string
  client: McpClientId
  config: McpServerConfig
} {
  const config = { ...server.config }

  // Remove sensitive env vars
  if ('env' in config && config.env) {
    const sanitizedEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(config.env)) {
      // Keep the key but mask the value for sensitive-looking vars
      const lowerKey = key.toLowerCase()
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('credential') ||
        lowerKey.includes('auth')
      ) {
        sanitizedEnv[key] = '***REDACTED***'
      } else {
        sanitizedEnv[key] = value
      }
    }
    config.env = sanitizedEnv
  }

  return {
    name: server.name,
    client: server.client,
    config
  }
}

/**
 * Get the disabled config file path for a given original config path.
 * Creates a "disabled_<filename>" in the same directory.
 */
export function getDisabledConfigPath(originalPath: string): string {
  const dir = dirname(originalPath)
  const filename = basename(originalPath)
  return join(dir, `disabled_${filename}`)
}

/**
 * Read the quarantined servers file, creating an empty one if it doesn't exist.
 */
async function readQuarantinedServersFile(disabledPath: string): Promise<QuarantinedServersFile> {
  try {
    const content = await fs.readFile(disabledPath, 'utf-8')
    return JSON.parse(content) as QuarantinedServersFile
  } catch {
    // File doesn't exist or is invalid, return empty structure
    return {
      quarantinedBy: 'Edison Watch',
      servers: {}
    }
  }
}

/**
 * Quarantine a server by moving it to a disabled config file and removing from original.
 * This is the core auto-quarantine function that:
 * 1. Adds the server config to disabled_<config>.json with metadata
 * 2. Removes the server from the original config file
 * 3. Creates a backup of the original before modification
 *
 * @returns QuarantineResult with paths and timestamp for notification
 */
export async function quarantineServer(server: DiscoveredMcpServer): Promise<QuarantineResult> {
  const originalPath = server.path
  const disabledPath = getDisabledConfigPath(originalPath)
  const quarantinedAt = new Date().toISOString()

  console.log(`[MCP Quarantine] Quarantining server "${server.name}" from ${originalPath}`)

  // Step 1: Add to disabled file
  const disabledFile = await readQuarantinedServersFile(disabledPath)

  // Add the server with metadata
  disabledFile.servers[server.name] = {
    ...server.config,
    originalFile: originalPath,
    quarantinedAt
  }

  // Write disabled file (no backup needed, it's our own file)
  await fs.writeFile(disabledPath, JSON.stringify(disabledFile, null, 2), 'utf-8')
  console.log(`[MCP Quarantine] Added server "${server.name}" to ${disabledPath}`)

  // Step 2: Remove from original config
  // Wrapped in try/catch to rollback step 1 if this fails
  try {
    const config = await readConfigFile(originalPath, server.client)
    const servers = getServersFromConfig(config, server.client)

    if (servers && server.name in servers) {
      // Create backup first
      if (existsSync(originalPath)) {
        const now = new Date()
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
        const backupPath = `${originalPath}.backup.${timestamp}.json`
        await fs.copyFile(originalPath, backupPath)
        console.log(`[MCP Quarantine] Created backup: ${backupPath}`)
      }

      // Delete the server entry
      delete servers[server.name]
      setServersInConfig(config, server.client, servers)

      // Write the modified config back
      await fs.writeFile(originalPath, JSON.stringify(config, null, 2), 'utf-8')
      console.log(`[MCP Quarantine] Removed server "${server.name}" from ${originalPath}`)
    } else {
      console.log(
        `[MCP Quarantine] Server "${server.name}" not found in original config, skipping removal`
      )
    }
  } catch (err) {
    // Rollback: remove server from disabled file so it does not exist in both places.
    console.error(
      `[MCP Quarantine] Failed to remove server from original config, rolling back:`,
      err
    )
    try {
      const rollbackDisabledFile = await readQuarantinedServersFile(disabledPath)
      delete rollbackDisabledFile.servers[server.name]
      await fs.writeFile(disabledPath, JSON.stringify(rollbackDisabledFile, null, 2), 'utf-8')
      console.log(`[MCP Quarantine] Rolled back: removed server from ${disabledPath}`)
    } catch (rollbackErr) {
      console.error(`[MCP Quarantine] Rollback failed:`, rollbackErr)
    }
    throw err
  }

  return {
    server,
    originalPath,
    disabledPath,
    quarantinedAt
  }
}

/**
 * Restore all quarantined servers back to their original config files.
 * For each disabled_<config>.json found alongside known config paths:
 * 1. Read the quarantined servers from the disabled file
 * 2. Add each server back to its original config file
 * 3. Delete the disabled file
 *
 * @returns Summary of restored servers and any errors encountered
 */
export async function restoreAllQuarantinedServers(): Promise<{
  restored: number
  errors: string[]
}> {

  // Collect all known config paths (including plugin, project, and workspace paths)
  const paths = getAllConfigPaths()
  const [jetbrainsPaths, cursorPluginPaths, cursorProjectPaths, claudeCodeProjectPaths] =
    await Promise.all([
      getJetBrainsMcpConfigPaths(),
      getCursorPluginMcpPaths(),
      getCursorProjectMcpPaths(),
      getClaudeCodeProjectMcpPaths()
    ])

  const allOriginalPaths = [...new Set([
    paths.vscode,
    paths.vscodeInsiders,
    paths.claudeDesktop,
    paths.claudeCowork,
    paths.cursor,
    ...paths.claudeCode,
    paths.windsurf,
    paths.zed,
    paths.antigravity,
    ...jetbrainsPaths.map((x) => x.path),
    ...cursorPluginPaths,
    ...cursorProjectPaths,
    ...claudeCodeProjectPaths
  ])]

  let restored = 0
  const errors: string[] = []

  for (const originalPath of allOriginalPaths) {
    const disabledPath = getDisabledConfigPath(originalPath)

    // Check if a disabled file exists
    try {
      await fs.access(disabledPath)
    } catch {
      continue // No disabled file for this config path
    }

    try {
      const disabledFile = await readQuarantinedServersFile(disabledPath)
      const serverNames = Object.keys(disabledFile.servers)

      if (serverNames.length === 0) {
        // Empty disabled file, just clean it up
        await fs.unlink(disabledPath)
        continue
      }

      // Determine the client type from the original path to know the key format.
      // We infer it from the disabled file's originalFile metadata or from the path itself.
      const clientId = inferClientFromPath(originalPath)

      // Read or create the original config file
      let config: ConfigFileFormat
      try {
        config = await readConfigFile(originalPath, clientId)
      } catch {
        // Original file doesn't exist or is unreadable -- create a minimal one
        config = {}
      }

      // Get or create the servers map
      let servers = getServersFromConfig(config, clientId)
      if (!servers) {
        servers = {}
      }

      // Restore each quarantined server
      for (const [name, serverData] of Object.entries(disabledFile.servers)) {
        // Strip quarantine metadata, keep only the server config
        const { originalFile: _of, quarantinedAt: _qa, ...serverConfig } = serverData
        servers[name] = serverConfig as McpServerConfig
        restored++
        console.log(`[MCP Quarantine Reset] Restored server "${name}" to ${originalPath}`)
      }

      // Write back the original config with restored servers
      setServersInConfig(config, clientId, servers)
      await fs.writeFile(originalPath, JSON.stringify(config, null, 2), 'utf-8')

      // Delete the disabled file
      await fs.unlink(disabledPath)
      console.log(`[MCP Quarantine Reset] Removed disabled file: ${disabledPath}`)
    } catch (err) {
      const msg = `Failed to restore from ${disabledPath}: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[MCP Quarantine Reset] ${msg}`)
      errors.push(msg)
    }
  }

  return { restored, errors }
}

/**
 * Infer the McpClientId from a config file path.
 * Best-effort heuristic based on known path patterns.
 */
function inferClientFromPath(configPath: string): McpClientId {
  const lower = configPath.toLowerCase()
  // Check specific patterns before generic ones to avoid false positives
  // (e.g., /Users/alice/code/project/.cursor/mcp.json matching VS Code)
  if (lower.includes('.cursor')) return 'cursor'
  if (lower.includes('claude') && lower.includes('claude_desktop_config')) return 'claude-desktop'
  if (lower.includes('.claude')) return 'claude-code'
  if (lower.includes('code - insiders')) return 'vscode-insiders'
  if (lower.includes('code') && lower.includes('user') && lower.includes('mcp.json'))
    return 'vscode'
  if (lower.includes('windsurf') || lower.includes('codeium')) return 'windsurf'
  if (lower.includes('zed')) return 'zed'
  if (lower.includes('antigravity') || lower.includes('.gemini')) return 'antigravity'
  if (lower.includes('intellij')) return 'intellij'
  if (lower.includes('pycharm')) return 'pycharm'
  if (lower.includes('webstorm')) return 'webstorm'
  // Default to claude-code style (mcpServers key) which is the most common
  return 'claude-code'
}
