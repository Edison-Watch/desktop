/**
 * Async helpers for discovering per-project MCP config paths from IDE workspace
 * state. These are kept separate from mcpDiscovery.ts to stay within line limits.
 */
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
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

/** Path to Cursor's plugin installed.json manifest */
export function getCursorPluginsInstalledPath(): string {
  return join(homedir(), '.cursor', 'plugins', 'installed.json')
}

/**
 * Scan installed Cursor plugins for bundled .mcp.json files.
 * Plugins are stored under ~/.cursor/plugins/cache/<marketplace>/<plugin>/latest/.mcp.json
 * and local plugins may live in ~/.cursor/plugins/local/<name>/.mcp.json.
 * The installed.json manifest is also returned so it can be watched for new installs.
 */
export async function getCursorPluginMcpPaths(): Promise<string[]> {
  const pluginsBase = join(homedir(), '.cursor', 'plugins')
  const result: string[] = []

  // Read installed.json to get the list of installed plugins
  try {
    const raw = await fs.readFile(join(pluginsBase, 'installed.json'), 'utf-8')
    const json = JSON.parse(raw) as {
      user?: string[]
      projects?: Record<string, string[]>
      team?: Record<string, string[]>
      local?: Record<string, string>
    }

    // user/team/project plugins: format is "<plugin>@<marketplace>"
    const allEntries: string[] = [
      ...(json.user ?? []),
      ...Object.values(json.projects ?? {}).flat(),
      ...Object.values(json.team ?? {}).flat()
    ]
    for (const entry of allEntries) {
      const atIdx = entry.lastIndexOf('@')
      if (atIdx === -1) continue
      const pluginName = entry.slice(0, atIdx)
      const marketplace = entry.slice(atIdx + 1)
      result.push(join(pluginsBase, 'cache', marketplace, pluginName, 'latest', '.mcp.json'))
    }

    // local plugins: key is plugin name, value may be a local path
    for (const [name, localPath] of Object.entries(json.local ?? {})) {
      if (typeof localPath === 'string' && localPath) {
        // absolute local plugin path
        result.push(join(localPath, '.mcp.json'))
      } else {
        // fall back to ~/.cursor/plugins/local/<name>/.mcp.json
        result.push(join(pluginsBase, 'local', name, '.mcp.json'))
      }
    }
  } catch {
    // installed.json missing (Cursor not installed or no plugins); ignore
  }

  return result
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
