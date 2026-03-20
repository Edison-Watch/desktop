import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'chokidar'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { getAllConfigPaths } from './mcpConfigPaths'
import {
  discoverMcpServers,
  getJetBrainsMcpConfigPaths,
  getCursorProjectMcpPaths,
  getCursorPluginMcpPaths,
  getCursorPluginsInstalledPaths,
  getClaudeCodeProjectMcpPaths,
  getCursorWorkspaceStoragePath,
  getClaudeCodeHomeJsonPath,
  getServerFingerprint,
  type DiscoveredMcpServer,
  type McpClientId
} from './mcpDiscovery'
import { SeenServersStore } from './seenServersStore'
import { quarantineServer, type QuarantineResult } from './mcpConfigActions'

// Cache static paths that only depend on homedir() (which doesn't change at runtime)
const CURSOR_PLUGINS_INSTALLED_PATHS = getCursorPluginsInstalledPaths()

const QUARANTINE_MAX_ATTEMPTS = 3
const QUARANTINE_RETRY_DELAY_MS = 400

async function quarantineWithRetry(server: DiscoveredMcpServer): Promise<QuarantineResult> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= QUARANTINE_MAX_ATTEMPTS; attempt++) {
    try {
      return await quarantineServer(server)
    } catch (err) {
      lastErr = err
      if (attempt < QUARANTINE_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, QUARANTINE_RETRY_DELAY_MS))
      }
    }
  }
  throw lastErr
}

export interface DetectedServerChange {
  type: 'added' | 'removed' | 'modified'
  server: DiscoveredMcpServer
  fingerprint: string
}

/**
 * Event emitted when a server is auto-quarantined.
 */
export interface QuarantinedServerEvent {
  server: DiscoveredMcpServer
  fingerprint: string
  originalPath: string
  disabledPath: string
  quarantinedAt: string
}

export interface McpConfigMonitorEvents {
  /** Legacy event for other change types (removed, modified) */
  serversChanged: (changes: DetectedServerChange[]) => void
  /** New event when servers are auto-quarantined */
  serversQuarantined: (events: QuarantinedServerEvent[]) => void
  error: (error: Error) => void
}

/**
 * Monitors MCP configuration files for changes and emits events
 * when servers are added, removed, or modified.
 */
export class McpConfigMonitor extends EventEmitter {
  private watcher: FSWatcher | null = null
  private workspaceStorageWatcher: FSWatcher | null = null
  private seenStore: SeenServersStore
  private lastKnownServers: Map<string, DiscoveredMcpServer> = new Map()
  private debounceTimer: NodeJS.Timeout | null = null
  private debounceMs: number
  private isRunning = false
  private configFiles: Set<string> = new Set()

  constructor(seenStore: SeenServersStore, debounceMs = 500) {
    super()
    this.seenStore = seenStore
    this.debounceMs = debounceMs
  }

  /**
   * Start monitoring MCP config files for changes.
   */
  async start(): Promise<void> {
    if (this.isRunning) return

    // On startup, quarantine any existing non-Edison servers
    // This ensures all servers are secured even if they existed before the app started
    await this.quarantineExistingServers()

    // Get all config paths to watch (sync paths + async scans for JetBrains/Cursor projects/Claude Code projects)
    const paths = getAllConfigPaths()
    const [jetbrainsPaths, cursorProjectPaths, cursorPluginPaths, claudeCodeProjectPaths] =
      await Promise.all([
        getJetBrainsMcpConfigPaths(),
        getCursorProjectMcpPaths(),
        getCursorPluginMcpPaths(),
        getClaudeCodeProjectMcpPaths()
      ])
    this.configFiles = new Set([
      paths.vscode,
      paths.vscodeInsiders,
      paths.claudeDesktop,
      paths.cursor,
      ...CURSOR_PLUGINS_INSTALLED_PATHS, // watch all plugin registry files (legacy + v1 + shared)
      ...paths.claudeCode,
      paths.windsurf,
      paths.zed,
      paths.antigravity,
      ...jetbrainsPaths.map((x) => x.path),
      ...cursorProjectPaths,
      ...cursorPluginPaths,
      ...claudeCodeProjectPaths
    ])

    // Build list of paths to watch - files that exist + parent dirs for files that don't
    const existingPaths: string[] = []
    const parentDirs = new Set<string>()

    for (const p of this.configFiles) {
      try {
        await fs.access(p)
        existingPaths.push(p)
      } catch {
        // Track parent directory for non-existing files (we'll watch with depth: 0)
        const parentDir = dirname(p)
        if (parentDir) {
          parentDirs.add(parentDir)
        }
      }
    }

    // Add parent directories that exist
    for (const parentDir of parentDirs) {
      try {
        await fs.access(parentDir)
        existingPaths.push(parentDir)
      } catch {
        // Parent doesn't exist either, skip
      }
    }

    // Start watching
    this.watcher = watch(existingPaths, {
      persistent: true,
      ignoreInitial: true,
      depth: 0, // Don't recurse into subdirectories
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    })

    this.watcher.on('change', (path) => this.handleFileChange(path))
    this.watcher.on('add', (path) => this.handleFileChange(path))
    this.watcher.on('unlink', (path) => this.handleFileChange(path))
    this.watcher.on('error', (error) => this.emit('error', error))

    // Watch Cursor's workspaceStorage directory (depth: 1) so that when the user opens a
    // new project in Cursor, the new workspace.json triggers discovery of its .cursor/mcp.json.
    await this.startWorkspaceStorageWatcher()

    this.isRunning = true
    console.log('[McpConfigMonitor] Started watching:', existingPaths)
  }

  /**
   * Stop monitoring.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    if (this.workspaceStorageWatcher) {
      await this.workspaceStorageWatcher.close()
      this.workspaceStorageWatcher = null
    }

    this.isRunning = false
    console.log('[McpConfigMonitor] Stopped')
  }

  /**
   * Force a rescan of all config files and emit changes.
   */
  async forceRescan(): Promise<DetectedServerChange[]> {
    return this.checkForChanges()
  }

  /**
   * Manually trigger the quarantine workflow on all currently discovered non-Edison servers.
   * This is the same logic as `quarantineExistingServers()` but callable from outside,
   * intended for debug/testing without enabling the tenant-level auto-quarantine setting.
   */
  async runQuarantineWorkflow(): Promise<void> {
    return this.quarantineExistingServers()
  }

  /**
   * Get the current state of all discovered servers.
   */
  getCurrentServers(): DiscoveredMcpServer[] {
    return Array.from(this.lastKnownServers.values())
  }

  /**
   * Add new config file paths to the watch list dynamically.
   * This is used when a new project is registered.
   * @param paths Array of absolute file paths to watch
   * @returns Array of paths that were actually added (new to the watch list)
   */
  async addConfigPaths(paths: string[]): Promise<string[]> {
    if (!this.isRunning || !this.watcher) {
      console.warn('[McpConfigMonitor] Cannot add paths - monitor not running')
      return []
    }

    const addedPaths: string[] = []
    const pathsToWatch: string[] = []
    const parentDirsToWatch = new Set<string>()

    for (const p of paths) {
      // Skip if already watching
      if (this.configFiles.has(p)) {
        continue
      }

      this.configFiles.add(p)
      addedPaths.push(p)

      try {
        await fs.access(p)
        pathsToWatch.push(p)
      } catch {
        // File doesn't exist, watch parent directory
        const parentDir = dirname(p)
        if (parentDir) {
          parentDirsToWatch.add(parentDir)
        }
      }
    }

    // Add parent directories that exist
    for (const parentDir of parentDirsToWatch) {
      try {
        await fs.access(parentDir)
        pathsToWatch.push(parentDir)
      } catch {
        // Parent doesn't exist either, skip
      }
    }

    // Add to watcher
    if (pathsToWatch.length > 0) {
      this.watcher.add(pathsToWatch)
      console.log('[McpConfigMonitor] Added paths to watch:', pathsToWatch)
    }

    // Trigger a rescan to check the new paths
    if (addedPaths.length > 0) {
      await this.checkForChanges()
    }

    return addedPaths
  }

  /**
   * Remove config file paths from the watch list.
   * @param paths Array of absolute file paths to stop watching
   */
  async removeConfigPaths(paths: string[]): Promise<void> {
    if (!this.watcher) return

    for (const p of paths) {
      this.configFiles.delete(p)
    }

    // Note: chokidar doesn't have a simple way to unwatch individual files
    // without restarting the entire watcher. For now, we just remove from our set
    // and ignore events from those paths.
    console.log('[McpConfigMonitor] Removed paths from config set:', paths)
  }

  /**
   * Get the set of currently monitored config file paths.
   */
  getMonitoredPaths(): string[] {
    return Array.from(this.configFiles)
  }

  /**
   * Watch Cursor's workspaceStorage directory (depth: 1) so newly-opened projects
   * are detected. When a workspace.json appears or is updated, we rescan project paths
   * and add any newly-discovered .cursor/mcp.json files to the watch list.
   */
  private async startWorkspaceStorageWatcher(): Promise<void> {
    const storageDir = getCursorWorkspaceStoragePath()
    try {
      await fs.access(storageDir)
    } catch {
      // Cursor not installed or workspaceStorage doesn't exist yet; skip
      return
    }

    this.workspaceStorageWatcher = watch(storageDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1, // Watch workspace.json files inside each subdirectory
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    })

    const handleWorkspaceJsonEvent = async (changedPath: string): Promise<void> => {
      if (!changedPath.endsWith('workspace.json')) return
      // New or updated project in Cursor — rescan and add any new .cursor/mcp.json paths
      try {
        const latestProjectPaths = await getCursorProjectMcpPaths()
        const newPaths = latestProjectPaths.filter((p) => !this.configFiles.has(p))
        if (newPaths.length > 0) {
          console.log('[McpConfigMonitor] New Cursor projects detected, adding paths:', newPaths)
          await this.addConfigPaths(newPaths)
        }
      } catch (err) {
        console.error('[McpConfigMonitor] Error rescanning Cursor project paths:', err)
      }
    }

    this.workspaceStorageWatcher.on('add', handleWorkspaceJsonEvent)
    this.workspaceStorageWatcher.on('change', handleWorkspaceJsonEvent)
    this.workspaceStorageWatcher.on('error', (error) => this.emit('error', error))
    console.log('[McpConfigMonitor] Watching Cursor workspaceStorage:', storageDir)
  }

  /**
   * When a Cursor plugin registry file changes (new plugin installed), register
   * any .mcp.json files bundled by the newly-installed plugin.
   * Handles both legacy installed.json and Cursor 2.5+ installed_plugins.json.
   */
  private async handleCursorPluginsInstalledChange(): Promise<void> {
    try {
      const latestPluginPaths = await getCursorPluginMcpPaths()
      const newPaths = latestPluginPaths.filter((p) => !this.configFiles.has(p))
      if (newPaths.length > 0) {
        console.log('[McpConfigMonitor] New Cursor plugin MCP paths detected, adding:', newPaths)
        await this.addConfigPaths(newPaths)
      }
    } catch (err) {
      console.error('[McpConfigMonitor] Error rescanning Cursor plugin paths:', err)
    }
  }

  /**
   * When ~/.claude.json changes, rescan Claude Code project paths and register any
   * newly-added project .mcp.json files with the watcher so future edits are caught.
   */
  private async handleClaudeHomeJsonChange(): Promise<void> {
    try {
      const latestProjectPaths = await getClaudeCodeProjectMcpPaths()
      const newPaths = latestProjectPaths.filter((p) => !this.configFiles.has(p))
      if (newPaths.length > 0) {
        console.log('[McpConfigMonitor] New Claude Code projects detected, adding paths:', newPaths)
        await this.addConfigPaths(newPaths)
      }
    } catch (err) {
      console.error('[McpConfigMonitor] Error rescanning Claude Code project paths:', err)
    }
  }

  private handleFileChange(path: string): void {
    // Only process changes to actual config files we care about
    if (!this.configFiles.has(path)) {
      return
    }

    console.log('[McpConfigMonitor] Config file changed:', path)

    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        // Register new paths before scanning so they're included in checkForChanges
        if (path === getClaudeCodeHomeJsonPath()) {
          await this.handleClaudeHomeJsonChange()
        }
        if (CURSOR_PLUGINS_INSTALLED_PATHS.includes(path)) {
          await this.handleCursorPluginsInstalledChange()
        }
        await this.checkForChanges()
      } catch (err) {
        console.error('[McpConfigMonitor] Error checking for changes:', err)
        this.emit('error', err)
      }
    }, this.debounceMs)
  }

  /**
   * Quarantine any existing servers on startup.
   * This ensures all non-Edison servers are secured even if they existed before the app started.
   */
  private async quarantineExistingServers(): Promise<void> {
    const servers = await discoverMcpServers()
    const quarantinedEvents: QuarantinedServerEvent[] = []
    const failedFingerprints = new Set<string>()

    for (const server of servers) {
      const fingerprint = getServerFingerprint(server)

      // Skip Edison Watch's own servers
      if (isEdisonWatchServer(server)) {
        console.log(`[McpConfigMonitor] Skipping Edison Watch server on startup: ${server.name}`)
        this.lastKnownServers.set(fingerprint, server)
        continue
      }

      try {
        // Auto-quarantine: move to disabled file, remove from original (with retries for transient I/O)
        console.log(`[McpConfigMonitor] Auto-quarantining existing server: ${server.name}`)
        const result: QuarantineResult = await quarantineWithRetry(server)

        // Mark as seen with quarantine action
        await this.seenStore.markSeen(server, 'quarantined', {
          disabledPath: result.disabledPath,
          quarantinedAt: result.quarantinedAt
        })

        quarantinedEvents.push({
          server,
          fingerprint,
          originalPath: result.originalPath,
          disabledPath: result.disabledPath,
          quarantinedAt: result.quarantinedAt
        })
      } catch (err) {
        failedFingerprints.add(fingerprint)
        console.error(
          `[McpConfigMonitor] Failed to quarantine server "${server.name}" on startup after ${QUARANTINE_MAX_ATTEMPTS} attempts:`,
          err
        )
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
        // Exclude from lastKnownServers so checkForChanges will retry on next cycle.
      }
    }

    // Re-discover to get accurate state after quarantine. Exclude failed fingerprints so we retry later.
    const postQuarantineServers = await discoverMcpServers()
    this.lastKnownServers.clear()
    for (const server of postQuarantineServers) {
      const fingerprint = getServerFingerprint(server)
      if (failedFingerprints.has(fingerprint)) continue
      this.lastKnownServers.set(fingerprint, server)
    }

    // Emit quarantine events for UI notification
    if (quarantinedEvents.length > 0) {
      console.log(
        '[McpConfigMonitor] Quarantined servers on startup:',
        quarantinedEvents.map((e) => e.server.name)
      )
      this.emit('serversQuarantined', quarantinedEvents)
    }
  }

  private async checkForChanges(): Promise<DetectedServerChange[]> {
    const currentServers = await discoverMcpServers()
    const currentMap = new Map<string, DiscoveredMcpServer>()

    for (const server of currentServers) {
      const fingerprint = getServerFingerprint(server)
      currentMap.set(fingerprint, server)
    }

    const changes: DetectedServerChange[] = []
    const addedServers: { server: DiscoveredMcpServer; fingerprint: string }[] = []

    // Check for added or modified servers
    for (const [fingerprint, server] of currentMap) {
      const previous = this.lastKnownServers.get(fingerprint)

      if (!previous) {
        // New server added - collect for quarantine
        addedServers.push({ server, fingerprint })
      } else if (this.hasServerConfigChanged(previous, server)) {
        // Server config modified
        changes.push({
          type: 'modified',
          server,
          fingerprint
        })
      }
    }

    // Check for removed servers
    for (const [fingerprint, server] of this.lastKnownServers) {
      if (!currentMap.has(fingerprint)) {
        changes.push({
          type: 'removed',
          server,
          fingerprint
        })
      }
    }

    // Process added servers - auto-quarantine them
    // Always quarantine ANY newly detected server, regardless of previous actions.
    // This ensures that if someone adds a server to their config, it's immediately
    // quarantined for security review - even if that server was seen before.
    const quarantinedEvents: QuarantinedServerEvent[] = []
    const failedFingerprints = new Set<string>()
    for (const { server, fingerprint } of addedServers) {
      // Skip Edison Watch's own servers
      if (isEdisonWatchServer(server)) {
        console.log(`[McpConfigMonitor] Skipping Edison Watch server: ${server.name}`)
        continue
      }

      try {
        // Auto-quarantine: move to disabled file, remove from original (with retries for transient I/O)
        console.log(`[McpConfigMonitor] Auto-quarantining server: ${server.name}`)
        const result: QuarantineResult = await quarantineWithRetry(server)

        // Mark as seen with quarantine action
        await this.seenStore.markSeen(server, 'quarantined', {
          disabledPath: result.disabledPath,
          quarantinedAt: result.quarantinedAt
        })

        quarantinedEvents.push({
          server,
          fingerprint,
          originalPath: result.originalPath,
          disabledPath: result.disabledPath,
          quarantinedAt: result.quarantinedAt
        })
      } catch (err) {
        failedFingerprints.add(fingerprint)
        console.error(
          `[McpConfigMonitor] Failed to quarantine server "${server.name}" after ${QUARANTINE_MAX_ATTEMPTS} attempts:`,
          err
        )
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
        // Do not mark as quarantined; exclude from lastKnownServers so we retry on next cycle.
      }
    }

    // Update last known state - but clear quarantined servers since they're now in disabled files.
    // Exclude failed fingerprints so they are treated as "added" again next cycle and we retry.
    const postQuarantineServers = await discoverMcpServers()
    this.lastKnownServers.clear()
    for (const server of postQuarantineServers) {
      const fingerprint = getServerFingerprint(server)
      if (failedFingerprints.has(fingerprint)) continue
      this.lastKnownServers.set(fingerprint, server)
    }

    // Emit quarantine events for UI notification
    if (quarantinedEvents.length > 0) {
      console.log('[McpConfigMonitor] Quarantined servers:', quarantinedEvents)
      this.emit('serversQuarantined', quarantinedEvents)
    }

    // Emit other changes (modified, removed) if any
    if (changes.length > 0) {
      console.log('[McpConfigMonitor] Other changes:', changes)
      this.emit('serversChanged', changes)
    }

    return changes
  }

  private hasServerConfigChanged(
    previous: DiscoveredMcpServer,
    current: DiscoveredMcpServer
  ): boolean {
    // Compare config objects
    return JSON.stringify(previous.config) !== JSON.stringify(current.config)
  }
}

/**
 * Check if a server is an Edison Watch server (to avoid monitoring our own servers).
 * Localhost is only treated as Edison when /mcp path is present, so we do not quarantine
 * other localhost dev servers.
 */
export function isEdisonWatchServer(server: DiscoveredMcpServer): boolean {
  // Name we write to configs via mcpConfigWriter
  if (server.name === 'edison-watch') return true

  const config = server.config
  if ('command' in config && config.command) {
    const args = config.args?.join(' ') ?? ''
    const argsList = config.args ?? []
    return (
      config.command === 'npx' &&
      args.includes('mcp-remote') &&
      (args.includes('edison.watch') ||
        (args.includes('localhost:') && argsList.some((arg) => /\/mcp(?:\/|$)/.test(String(arg)))))
    )
  }
  if ('url' in config && config.url) {
    return (
      config.url.includes('edison.watch') ||
      (config.url.includes('localhost') && /\/mcp(?:\/|$)/.test(config.url))
    )
  }
  return false
}

/**
 * Filter out Edison Watch servers from a list.
 */
export function filterOutEdisonWatchServers(servers: DiscoveredMcpServer[]): DiscoveredMcpServer[] {
  return servers.filter((s) => !isEdisonWatchServer(s))
}

/**
 * Get a human-readable name for an MCP client.
 */
export function getClientDisplayName(client: McpClientId): string {
  switch (client) {
    case 'vscode':
      return 'VS Code'
    case 'vscode-insiders':
      return 'VS Code Insiders'
    case 'cursor':
      return 'Cursor'
    case 'claude-desktop':
      return 'Claude Desktop'
    case 'claude-code':
      return 'Claude Code'
    case 'windsurf':
      return 'Windsurf'
    case 'zed':
      return 'Zed'
    case 'antigravity':
      return 'Antigravity'
    case 'intellij':
      return 'IntelliJ IDEA'
    case 'pycharm':
      return 'PyCharm'
    case 'webstorm':
      return 'WebStorm'
    default:
      return client
  }
}
