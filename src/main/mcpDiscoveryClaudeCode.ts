/**
 * Claude Code MCP server discovery — path helpers, parsers, and the main
 * discoverClaudeCode() aggregator.
 *
 * Extracted from mcpDiscovery.ts to stay under the 800-line CI limit.
 */

import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join, basename, dirname } from 'path'
import { getClaudeCodeProjectMcpPaths } from './mcpProjectPaths'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'

// ── Path helpers ────────────────────────────────────────────────────────────

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

// ── Parsers ─────────────────────────────────────────────────────────────────

// Parse Claude Code settings.json (shape: { mcpServers?: { [name]: { ... } }, profiles?: { [profile]: { mcpServers?: { ... } } } })
// Exported for testing
export async function parseClaudeCodeSettingsJson(
  filePath: string
): Promise<DiscoveredMcpServer[]> {
  const raw = await fs.readFile(filePath, 'utf-8')
  const json = JSON.parse(raw) as {
    mcpServers?: Record<string, McpServerConfig>
    profiles?: Record<string, { mcpServers?: Record<string, McpServerConfig> }>
  }

  const servers: DiscoveredMcpServer[] = []

  // Top-level mcpServers
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

  // Per-profile mcpServers (e.g. profiles.work.mcpServers)
  const profiles = json.profiles ?? {}
  for (const [profileName, profileCfg] of Object.entries(profiles)) {
    const profileEntries = Object.entries(profileCfg?.mcpServers ?? {})
    for (const [name, cfg] of profileEntries) {
      servers.push({
        name,
        client: 'claude-code',
        source: 'user',
        path: filePath,
        config: cfg as McpServerConfig,
        profileName
      })
    }
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
  // Store the full project path as projectName so mutations can match
  // unambiguously (two projects may share the same basename).
  const projects = json.projects ?? {}
  for (const [projectPath, projCfg] of Object.entries(projects)) {
    const entries = Object.entries(projCfg?.mcpServers ?? {})
    for (const [name, cfg] of entries) {
      servers.push({
        name,
        client: 'claude-code',
        source: 'project',
        path: filePath,
        config: cfg as McpServerConfig,
        projectName: projectPath
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

// ── Discovery aggregator ────────────────────────────────────────────────────

export async function discoverClaudeCode(): Promise<DiscoveredMcpServer[]> {
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
