/**
 * JetBrains IDE MCP server discovery (IntelliJ, PyCharm, WebStorm).
 */

import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import type { DiscoveredMcpServer, McpServerConfig } from '../../discovery/types'

// ── Path helpers ─────────────────────────────────────────────────────────────

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

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Scan JetBrains base dir and return which IDEs have a preferences folder present.
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

// ── Config path scanning ────────────────────────────────────────────────────

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

// ── Parser ──────────────────────────────────────────────────────────────────

/** Parse JetBrains mcp/servers.json (shape: { mcpServers?: { [name]: { ... } } }) */
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
