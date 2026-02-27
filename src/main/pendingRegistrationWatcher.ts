/**
 * Pending Registration Watcher
 *
 * Watches the ~/.edison-watch/pending/ directory for new registration files
 * created by the hook scripts injected into MCP clients.
 */

import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'chokidar'
import { promises as fs, existsSync } from 'fs'
import { join, basename } from 'path'
import type { McpClientId } from './mcpDiscovery'
import { getPendingRegistrationsDir } from './hookInjection'

/**
 * Structure of a pending registration file written by hook scripts.
 */
export interface PendingRegistration {
  projectPath: string
  registeredBy: McpClientId | string
  timestamp?: string
}

/**
 * Event emitted when a new project registration is detected.
 */
export interface RegistrationEvent {
  projectPath: string
  registeredBy: McpClientId | 'manual'
  filename: string
}

export interface PendingRegistrationWatcherEvents {
  registration: (event: RegistrationEvent) => void
  error: (error: Error) => void
}

/**
 * Watches for new registration files and emits events when projects are registered.
 */
export class PendingRegistrationWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private pendingDir: string
  private isRunning = false
  private processedFiles = new Set<string>()

  constructor() {
    super()
    this.pendingDir = getPendingRegistrationsDir()
  }

  /**
   * Start watching for new registration files.
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    // Ensure directory exists
    if (!existsSync(this.pendingDir)) {
      await fs.mkdir(this.pendingDir, { recursive: true })
    }

    // Process any existing files first
    await this.processExistingFiles()

    // Start watching
    this.watcher = watch(this.pendingDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      // Only watch for JSON files
      ignored: (path) => !path.endsWith('.json') && path !== this.pendingDir
    })

    this.watcher.on('add', (path) => this.handleNewFile(path))
    this.watcher.on('error', (error) => this.emit('error', error))

    this.isRunning = true
    console.log(`[PendingRegistrationWatcher] Started watching ${this.pendingDir}`)
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.isRunning = false
    console.log('[PendingRegistrationWatcher] Stopped')
  }

  /**
   * Process any existing files in the pending directory.
   */
  private async processExistingFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.pendingDir)
      for (const file of files) {
        if (file.endsWith('.json') && !file.startsWith('.')) {
          await this.handleNewFile(join(this.pendingDir, file))
        }
      }
    } catch (err) {
      // Directory might not exist yet
      console.log('[PendingRegistrationWatcher] No existing files to process')
    }
  }

  /**
   * Handle a new registration file.
   */
  private async handleNewFile(filePath: string): Promise<void> {
    const filename = basename(filePath)

    // Skip if already processed (can happen with rapid file operations)
    if (this.processedFiles.has(filename)) {
      return
    }

    try {
      // Read and parse the file
      const content = await fs.readFile(filePath, 'utf-8')
      const registration = JSON.parse(content) as PendingRegistration

      if (!registration.projectPath) {
        console.warn(`[PendingRegistrationWatcher] Invalid registration file (no projectPath): ${filename}`)
        await this.deleteFile(filePath)
        return
      }

      // Normalize the registeredBy field to a valid McpClientId
      const registeredBy = this.normalizeClient(registration.registeredBy)

      console.log(`[PendingRegistrationWatcher] New registration: ${registration.projectPath} (${registeredBy})`)

      // Emit the registration event
      this.emit('registration', {
        projectPath: registration.projectPath,
        registeredBy,
        filename
      } as RegistrationEvent)

      // Mark as processed and delete the file
      this.processedFiles.add(filename)
      await this.deleteFile(filePath)

      // Clean up processed set periodically to avoid memory growth
      if (this.processedFiles.size > 1000) {
        this.processedFiles.clear()
      }
    } catch (err) {
      console.error(`[PendingRegistrationWatcher] Error processing ${filename}:`, err)
      // Try to delete the file anyway to avoid reprocessing
      await this.deleteFile(filePath)
    }
  }

  /**
   * Delete a processed file.
   */
  private async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch {
      // File might already be deleted
    }
  }

  /**
   * Normalize client string to McpClientId.
   */
  private normalizeClient(client: string): McpClientId | 'manual' {
    const normalized = client?.toLowerCase().trim()
    switch (normalized) {
      case 'claude-code':
      case 'claudecode':
        return 'claude-code'
      case 'cursor':
        return 'cursor'
      case 'windsurf':
        return 'windsurf'
      case 'vscode':
      case 'vs-code':
        return 'vscode'
      case 'vscode-insiders':
      case 'vs-code-insiders':
        return 'vscode-insiders'
      case 'claude-desktop':
      case 'claudedesktop':
        return 'claude-desktop'
      case 'zed':
        return 'zed'
      case 'antigravity':
        return 'antigravity'
      case 'intellij':
      case 'intellij-idea':
        return 'intellij'
      case 'pycharm':
        return 'pycharm'
      case 'webstorm':
        return 'webstorm'
      default:
        return 'manual'
    }
  }
}
