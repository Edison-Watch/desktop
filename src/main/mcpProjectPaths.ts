/**
 * Async helpers for discovering per-project MCP config paths from IDE workspace
 * state. These are kept separate from mcpDiscovery.ts to stay within line limits.
 */
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname, isAbsolute } from 'path'
import { fileURLToPath } from 'url'

// Cursor workspace storage path — used to discover per-project .cursor/mcp.json files
export function getCursorWorkspaceStoragePath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'workspaceStorage'
      )
    default:
      return join(homedir(), '.config', 'Cursor', 'User', 'workspaceStorage')
  }
}

/**
 * Scan Cursor's workspaceStorage directory for local project folders and return
 * the paths to their per-project .cursor/mcp.json files (whether or not they exist yet).
 * These paths should be monitored so newly-created project configs are caught immediately.
 */
export async function getCursorProjectMcpPaths(): Promise<string[]> {
  const storageDir = getCursorWorkspaceStoragePath()
  const seen = new Set<string>()
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true })
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      const workspaceJsonPath = join(storageDir, dirent.name, 'workspace.json')
      try {
        const raw = await fs.readFile(workspaceJsonPath, 'utf-8')
        const json = JSON.parse(raw) as { folder?: string }
        const folder = json.folder
        // Only handle local file:// URIs — skip SSH remotes, vscode-remote, etc.
        if (folder && folder.startsWith('file://')) {
          // Use fileURLToPath for correct cross-platform handling (avoids leading slash
          // before drive letter on Windows, e.g. file:///C:/... → C:\...)
          const projectPath = fileURLToPath(folder)
          seen.add(join(projectPath, '.cursor', 'mcp.json'))
        }
      } catch {
        // workspace.json missing or unreadable; skip
      }
    }
  } catch {
    // workspaceStorage doesn't exist yet; ignore
  }
  return Array.from(seen)
}

/**
 * Paths to Cursor's plugin registry manifests.
 * Cursor 2.5+ renamed installed.json → installed_plugins.json and also reads
 * from ~/.claude/plugins/installed_plugins.json (shared config surface).
 * Returns all candidate paths; callers should watch all of them.
 */
export function getCursorPluginsInstalledPaths(): string[] {
  return [
    join(homedir(), '.cursor', 'plugins', 'installed_plugins.json'), // Cursor 2.5+
    join(homedir(), '.cursor', 'plugins', 'installed.json'),         // Cursor <2.5 (legacy)
    join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), // shared config surface
  ]
}

/** @deprecated Use getCursorPluginsInstalledPaths() instead. Kept for backward compat. */
export function getCursorPluginsInstalledPath(): string {
  return join(homedir(), '.cursor', 'plugins', 'installed.json')
}

/**
 * Scan installed Cursor plugins for bundled .mcp.json files.
 *
 * Supports two manifest formats:
 * - **Legacy (Cursor <2.5):** installed.json with { user?: string[], projects?: Record, team?: Record, local?: Record }
 *   Cache path: ~/.cursor/plugins/cache/<marketplace>/<plugin>/latest/.mcp.json
 * - **v1+ (Cursor 2.5+):** installed_plugins.json with { version: number, plugins: { "name@marketplace": { installPath, ... } } }
 *   Cache path: taken directly from each plugin's installPath field
 *
 * Also checks ~/.claude/plugins/installed_plugins.json (shared config surface).
 */
export async function getCursorPluginMcpPaths(): Promise<string[]> {
  const seen = new Set<string>()

  // Try all registry files (new and legacy, plus shared config surface)
  const registryPaths = getCursorPluginsInstalledPaths()

  for (const registryPath of registryPaths) {
    try {
      const raw = await fs.readFile(registryPath, 'utf-8')
      const json = JSON.parse(raw) as Record<string, unknown>

      if ('version' in json && 'plugins' in json && json.version === 1) {
        // Cursor 2.5+ format: { version: 1, plugins: { "name@marketplace": { installPath, ... } } }
        parseInstalledPluginsV1(json, seen)
      } else if ('version' in json && 'plugins' in json) {
        // Unknown future format — log so we know when Cursor bumps the version
        console.warn(`[getCursorPluginMcpPaths] Unknown installed_plugins.json version (${json.version}), skipping: ${registryPath}`)
      } else {
        // Legacy format: { user?: string[], projects?: Record, team?: Record, local?: Record }
        // Derive base from registry path so cache paths are correct for each config surface
        const registryBase = dirname(registryPath)
        parseInstalledPluginsLegacy(json, registryBase, seen)
      }
    } catch {
      // Registry file missing or unreadable; try next
    }
  }

  return Array.from(seen)
}

/**
 * Parse Cursor 2.5+ installed_plugins.json format.
 * Each plugin entry has an installPath pointing directly to the plugin directory on disk.
 */
function parseInstalledPluginsV1(json: Record<string, unknown>, seen: Set<string>): void {
  const plugins = json.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return

  for (const [, pluginData] of Object.entries(plugins as Record<string, unknown>)) {
    if (!pluginData || typeof pluginData !== 'object') continue

    const installPath = (pluginData as Record<string, unknown>).installPath
    if (typeof installPath === 'string' && installPath) {
      if (!isAbsolute(installPath)) {
        console.warn(`[parseInstalledPluginsV1] installPath is not absolute, skipping: ${installPath}`)
        continue
      }
      // installPath points directly to the plugin root — .mcp.json lives there
      seen.add(join(installPath, '.mcp.json'))
    }
  }
}

/**
 * Parse legacy Cursor <2.5 installed.json format.
 * Entries are "<plugin>@<marketplace>" strings; cache path is constructed manually.
 */
function parseInstalledPluginsLegacy(
  json: Record<string, unknown>,
  pluginsBase: string,
  seen: Set<string>
): void {
  const user = Array.isArray(json.user)
    ? (json.user as unknown[]).filter((e): e is string => typeof e === 'string')
    : []
  const projects = json.projects && typeof json.projects === 'object' && !Array.isArray(json.projects)
    ? (json.projects as Record<string, unknown>)
    : {}
  const team = json.team && typeof json.team === 'object' && !Array.isArray(json.team)
    ? (json.team as Record<string, unknown>)
    : {}
  const local = json.local && typeof json.local === 'object' && !Array.isArray(json.local)
    ? (json.local as Record<string, unknown>)
    : {}

  // user/team/project plugins: format is "<plugin>@<marketplace>"
  const allEntries: string[] = [
    ...user,
    ...Object.values(projects).flat().filter((e): e is string => typeof e === 'string'),
    ...Object.values(team).flat().filter((e): e is string => typeof e === 'string')
  ]
  for (const entry of allEntries) {
    const atIdx = entry.lastIndexOf('@')
    if (atIdx === -1) continue
    const pluginName = entry.slice(0, atIdx)
    const marketplace = entry.slice(atIdx + 1)
    seen.add(join(pluginsBase, 'cache', marketplace, pluginName, 'latest', '.mcp.json'))
  }

  // local plugins: key is plugin name, value may be a local path
  for (const [name, localPath] of Object.entries(local)) {
    if (typeof localPath === 'string' && localPath) {
      if (!isAbsolute(localPath)) {
        console.warn(`[parseInstalledPluginsLegacy] localPath is not absolute, skipping: ${localPath}`)
      } else {
        seen.add(join(localPath, '.mcp.json'))
      }
    } else {
      seen.add(join(pluginsBase, 'local', name, '.mcp.json'))
    }
  }
}

// VS Code workspace storage paths — used to discover per-project workspace roots
export function getVsCodeWorkspaceStoragePath(): string {
  switch (platform()) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code',
        'User',
        'workspaceStorage'
      )
    default:
      return join(homedir(), '.config', 'Code', 'User', 'workspaceStorage')
  }
}

export function getVsCodeInsidersWorkspaceStoragePath(): string {
  switch (platform()) {
    case 'darwin':
      return join(
        homedir(),
        'Library',
        'Application Support',
        'Code - Insiders',
        'User',
        'workspaceStorage'
      )
    case 'win32':
      return join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'Code - Insiders',
        'User',
        'workspaceStorage'
      )
    default:
      return join(homedir(), '.config', 'Code - Insiders', 'User', 'workspaceStorage')
  }
}

/**
 * Scan VS Code's workspaceStorage for local project folders and return their root paths.
 * These are used for injecting workspace-level hook tasks.
 */
async function getWorkspaceRootsFromStorage(storageDir: string): Promise<string[]> {
  const seen = new Set<string>()
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true })
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      const workspaceJsonPath = join(storageDir, dirent.name, 'workspace.json')
      try {
        const raw = await fs.readFile(workspaceJsonPath, 'utf-8')
        const json = JSON.parse(raw) as { folder?: string }
        const folder = json.folder
        if (folder && folder.startsWith('file://')) {
          seen.add(fileURLToPath(folder))
        }
      } catch {
        // workspace.json missing or unreadable; skip
      }
    }
  } catch {
    // workspaceStorage doesn't exist yet; ignore
  }
  return Array.from(seen)
}

export async function getVsCodeWorkspacePaths(): Promise<string[]> {
  return getWorkspaceRootsFromStorage(getVsCodeWorkspaceStoragePath())
}

export async function getVsCodeInsidersWorkspacePaths(): Promise<string[]> {
  return getWorkspaceRootsFromStorage(getVsCodeInsidersWorkspaceStoragePath())
}

/**
 * Read the projects map from ~/.claude.json and return paths to each project's
 * .mcp.json file (whether or not it exists yet). These represent Claude Code's
 * project-scoped MCP server definitions that are checked into the project repo.
 */
export async function getClaudeCodeProjectMcpPaths(): Promise<string[]> {
  const homeJsonPath = join(homedir(), '.claude.json')
  try {
    const raw = await fs.readFile(homeJsonPath, 'utf-8')
    const json = JSON.parse(raw) as {
      projects?: Record<string, unknown>
    }
    const projectPaths = Object.keys(json.projects ?? {})
    return projectPaths.map((p) => join(p, '.mcp.json'))
  } catch {
    return []
  }
}
