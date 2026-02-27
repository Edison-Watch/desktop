import { promises as fs, existsSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { McpClientId } from './mcpDiscovery'

/**
 * A registered project path that Edison Watch should monitor for MCP configs.
 */
export interface RegisteredProject {
  /** Absolute path to the project root */
  path: string
  /** Which MCP client registered this project */
  registeredBy: McpClientId | 'manual'
  /** ISO timestamp when this project was registered */
  registeredAt: string
  /** Optional human-readable label for the project */
  label?: string
}

/**
 * Persisted store format
 */
interface StoreData {
  version: 1
  projects: Record<string, RegisteredProject>
}

/**
 * Get the known MCP config file paths within a project directory.
 * Returns paths that should be monitored for changes.
 */
export function getProjectConfigPaths(projectPath: string): string[] {
  return [
    // VS Code workspace config
    join(projectPath, '.vscode', 'mcp.json'),
    // Cursor project config
    join(projectPath, '.cursor', 'mcp.json'),
    // Claude Code project config
    join(projectPath, '.mcp.json'),
    // Claude Code project-local settings
    join(projectPath, '.claude', 'settings.local.json')
  ]
}

/**
 * Store for managing registered project paths.
 * Projects can be registered by MCP hooks or manually by the user.
 */
export class RegisteredProjectsStore {
  private storePath: string
  private projects: Map<string, RegisteredProject> = new Map()
  private loaded = false

  constructor(storePath?: string) {
    this.storePath =
      storePath ?? join(app.getPath('userData'), 'registered-projects.json')
  }

  /**
   * Load the store from disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return

    try {
      const raw = await fs.readFile(this.storePath, 'utf-8')
      const data = JSON.parse(raw) as StoreData

      if (data.version === 1) {
        this.projects = new Map(Object.entries(data.projects))
      }
    } catch (err) {
      // File doesn't exist or is invalid - start fresh
      this.projects = new Map()
    }

    this.loaded = true
  }

  /**
   * Save the store to disk.
   */
  private async save(): Promise<void> {
    const data: StoreData = {
      version: 1,
      projects: Object.fromEntries(this.projects)
    }

    // Ensure directory exists
    const dir = dirname(this.storePath)
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true })
    }

    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * Register a project path for monitoring.
   * Returns the config file paths that should be added to the watch list.
   */
  async register(
    projectPath: string,
    registeredBy: McpClientId | 'manual',
    label?: string
  ): Promise<string[]> {
    await this.load()

    // Normalize path
    const normalizedPath = projectPath.replace(/\/$/, '')

    // Check if already registered
    if (this.projects.has(normalizedPath)) {
      console.log(`[RegisteredProjectsStore] Project already registered: ${normalizedPath}`)
      return getProjectConfigPaths(normalizedPath)
    }

    const project: RegisteredProject = {
      path: normalizedPath,
      registeredBy,
      registeredAt: new Date().toISOString(),
      label
    }

    this.projects.set(normalizedPath, project)
    await this.save()

    console.log(`[RegisteredProjectsStore] Registered project: ${normalizedPath} (by ${registeredBy})`)
    return getProjectConfigPaths(normalizedPath)
  }

  /**
   * Unregister a project path.
   */
  async unregister(projectPath: string): Promise<boolean> {
    await this.load()

    const normalizedPath = projectPath.replace(/\/$/, '')
    const existed = this.projects.delete(normalizedPath)

    if (existed) {
      await this.save()
      console.log(`[RegisteredProjectsStore] Unregistered project: ${normalizedPath}`)
    }

    return existed
  }

  /**
   * Check if a project is registered.
   */
  async isRegistered(projectPath: string): Promise<boolean> {
    await this.load()
    const normalizedPath = projectPath.replace(/\/$/, '')
    return this.projects.has(normalizedPath)
  }

  /**
   * Get all registered projects.
   */
  async getAll(): Promise<RegisteredProject[]> {
    await this.load()
    return Array.from(this.projects.values())
  }

  /**
   * Get all config file paths that should be monitored from registered projects.
   */
  async getAllConfigPaths(): Promise<string[]> {
    await this.load()
    const paths: string[] = []

    for (const project of this.projects.values()) {
      paths.push(...getProjectConfigPaths(project.path))
    }

    return paths
  }

  /**
   * Clear all registered projects.
   */
  async clear(): Promise<void> {
    this.projects.clear()
    await this.save()
    console.log('[RegisteredProjectsStore] Cleared all registered projects')
  }

  /**
   * Get the number of registered projects.
   */
  async count(): Promise<number> {
    await this.load()
    return this.projects.size
  }
}
