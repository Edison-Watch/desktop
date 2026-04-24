import { EventEmitter } from 'events'
import { watch, type FSWatcher } from 'chokidar'
import { promises as fs, appendFileSync } from 'fs'
import { dirname } from 'path'

const MONITOR_LOG = '/tmp/ew-monitor.log'
function mlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(MONITOR_LOG, line) } catch { /* ignore */ }
  console.log(msg)
}
import {
  getAllConfigEntries,
  buildEntryMap,
  getWatchablePaths,
  getCursorWorkspaceStoragePath,
  getCursorPluginCachePath,
  type McpConfigEntry,
} from '../clients/registry'
import {
  discoverMcpServers,
  isOpaqueConfig,
  getCursorProjectMcpPaths,
  getCursorPluginMcpPaths,
  getClaudeCodeProjectMcpPaths,
  getServerFingerprint,
  type DiscoveredMcpServer,
  type McpClientId
} from '../discovery/mcpDiscovery'
import { SeenServersStore } from '../discovery/seenServersStore'
// quarantineServer import removed - quarantine now happens in quarantineManager after dialog

// quarantine retry constants removed - quarantine now happens in quarantineManager
const DEFAULT_RESCAN_INTERVAL_MS = 20_000 // Safety-net rescan every 20s

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

/** Event emitted when new servers are detected and pending quarantine (not yet removed). */
export interface PendingQuarantineEvent {
  server: DiscoveredMcpServer
  fingerprint: string
}

export interface McpConfigMonitorEvents {
  /** Legacy event for other change types (removed, modified) */
  serversChanged: (changes: DetectedServerChange[]) => void
  /** Event when servers are auto-quarantined (already removed from config) */
  serversQuarantined: (events: QuarantinedServerEvent[]) => void
  /** Event when new servers are detected pending quarantine (NOT yet removed - quarantine after user action) */
  serversPendingQuarantine: (events: PendingQuarantineEvent[]) => void
  error: (error: Error) => void
}

/**
 * Monitors MCP configuration files for changes and emits events
 * when servers are added, removed, or modified.
 */
export class McpConfigMonitor extends EventEmitter {
  private watcher: FSWatcher | null = null
  private workspaceStorageWatcher: FSWatcher | null = null
  private pluginCacheWatcher: FSWatcher | null = null
  private lastKnownServers: Map<string, DiscoveredMcpServer> = new Map()
  private debounceTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private debounceMs: number
  private rescanIntervalMs: number
  private isRunning = false
  private isCheckingForChanges = false
  private pendingRescan = false
  private configFiles: Set<string> = new Set()
  /** Lookup map from path → entry metadata (for triggersDynamicRescan etc.) */
  private configEntryByPath: Map<string, McpConfigEntry> = new Map()

  constructor(_seenStore: SeenServersStore, debounceMs = 500, rescanIntervalMs = DEFAULT_RESCAN_INTERVAL_MS) {
    super()
    this.debounceMs = debounceMs
    this.rescanIntervalMs = rescanIntervalMs
  }

  /**
   * Start monitoring MCP config files for changes.
   */
  async start(): Promise<void> {
    mlog('[Monitor] start() called')
    if (this.isRunning) { mlog('[Monitor] Already running, skipping'); return }

    // On startup, quarantine any existing non-Edison servers
    // This ensures all servers are secured even if they existed before the app started
    await this.quarantineExistingServers()

    // Get all config paths from the unified registry (static + dynamically-scanned)
    const entries = await getAllConfigEntries()
    this.configEntryByPath = buildEntryMap(entries)
    // Exclude sqlite-state paths (marketplace DBs) from chokidar - they change frequently
    // for unrelated reasons. The periodic rescan via discoverMcpServers() reads them.
    this.configFiles = new Set(getWatchablePaths(entries))

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

    // Watch Cursor's plugin cache directory so that new plugin installs are detected.
    await this.startPluginCacheWatcher()

    // Set isRunning before starting the rescan timer so the timer's guard
    // doesn't skip the first tick.
    this.isRunning = true

    // Start periodic safety-net rescan to catch MCP registrations that bypass config files
    // (e.g., Cursor's Extension API or deeplink installs).
    this.startRescanTimer()

    mlog(`[Monitor] Started - watching ${existingPaths.length} paths, ${this.configFiles.size} config files, ${this.lastKnownServers.size} known servers`)
  }

  /**
   * Stop monitoring.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (this.rescanTimer) {
      clearInterval(this.rescanTimer)
      this.rescanTimer = null
    }

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    if (this.workspaceStorageWatcher) {
      await this.workspaceStorageWatcher.close()
      this.workspaceStorageWatcher = null
    }

    if (this.pluginCacheWatcher) {
      await this.pluginCacheWatcher.close()
      this.pluginCacheWatcher = null
    }

    this.isRunning = false
    console.log('[McpConfigMonitor] Stopped')
  }

  /**
   * Force a rescan of all config files and emit changes.
   * Note: if a scan is already in progress this returns [] immediately;
   * changes are still propagated via the 'serversQuarantined'/'serversChanged' events.
   */
  async forceRescan(): Promise<DetectedServerChange[]> {
    return this.checkForChanges('forceRescan')
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
      await this.checkForChanges('addConfigPaths')
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
   * Start a periodic rescan timer as a safety net to catch MCP registrations
   * that bypass config file writes (e.g., Cursor Extension API, deeplinks).
   */
  private startRescanTimer(): void {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer)
    }

    this.rescanTimer = setInterval(async () => {
      if (!this.isRunning) return // guard against in-flight calls after stop()
      try {
        await this.checkForChanges('periodicRescan')
      } catch (err) {
        console.error('[McpConfigMonitor] Periodic rescan error:', err)
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }
    }, this.rescanIntervalMs)

    // Don't keep the process alive just for the rescan timer
    this.rescanTimer.unref()
    console.log(`[McpConfigMonitor] Periodic rescan started (every ${this.rescanIntervalMs / 1000}s)`)
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
      // New or updated project in Cursor - rescan and add any new .cursor/mcp.json paths
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
   * Watch Cursor's plugin cache directory so newly-installed plugins are detected.
   * Layout: cache/<marketplace>/<plugin_name>/<sha>/mcp.json
   */
  private async startPluginCacheWatcher(): Promise<void> {
    const cacheDir = getCursorPluginCachePath()
    try {
      await fs.access(cacheDir)
    } catch {
      // Cursor not installed or plugin cache doesn't exist yet; skip
      return
    }

    this.pluginCacheWatcher = watch(cacheDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 3, // marketplace/plugin_name/sha/mcp.json
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    })

    const handlePluginCacheEvent = async (changedPath: string): Promise<void> => {
      if (!changedPath.endsWith('mcp.json')) return
      await this.handleCursorPluginsInstalledChange()
    }

    this.pluginCacheWatcher.on('add', handlePluginCacheEvent)
    this.pluginCacheWatcher.on('change', handlePluginCacheEvent)
    this.pluginCacheWatcher.on('error', (error) => this.emit('error', error))
    console.log('[McpConfigMonitor] Watching Cursor plugin cache:', cacheDir)
  }

  /**
   * When a Cursor plugin registry or cache file changes, rescan plugin MCP paths
   * and register any new ones with the watcher.
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
      mlog(`[Monitor] handleFileChange IGNORED (not in configFiles): ${path}`)
      return
    }

    mlog(`[Monitor] handleFileChange MATCHED: ${path}`)

    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        // Register new paths before scanning so they're included in checkForChanges
        const entry = this.configEntryByPath.get(path)
        if (entry?.triggersDynamicRescan === 'claude-code-projects') {
          await this.handleClaudeHomeJsonChange()
        }
        if (entry?.triggersDynamicRescan === 'cursor-plugins') {
          await this.handleCursorPluginsInstalledChange()
        }
        await this.checkForChanges(`fileChange:${path}`)
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
    mlog('[Monitor] quarantineExistingServers() starting...')
    // Use raw (non-deduped) servers - quarantine handles each server individually,
    // dedup renaming is only for the onboarding UI.
    const { raw: servers } = await discoverMcpServers({ includeRaw: true })
    mlog(`[Monitor] quarantineExistingServers: discovered ${servers.length} servers: ${servers.map(s => `${s.name}@${s.client}`).join(', ')}`)
    const pendingEvents: PendingQuarantineEvent[] = []

    for (const server of servers) {
      const fingerprint = getServerFingerprint(server)
      this.lastKnownServers.set(fingerprint, server)

      // Skip Edison Watch's own servers
      if (isEdisonWatchServer(server)) {
        console.log(`[McpConfigMonitor] Skipping Edison Watch server on startup: ${server.name}`)
        continue
      }

      // Don't quarantine yet - let user submit first, quarantine on success/dismiss
      console.log(`[McpConfigMonitor] Server pending quarantine on startup: ${server.name}`)
      pendingEvents.push({ server, fingerprint })
    }

    if (pendingEvents.length > 0) {
      console.log(
        '[McpConfigMonitor] Servers pending quarantine on startup:',
        pendingEvents.map((e) => e.server.name)
      )
      // Remove pending-quarantine servers from lastKnownServers so that when
      // Cursor reinstalls them (restoring the cache dir), the next scan sees
      // them as NEW and re-quarantines. Without this, they match the stale
      // entry set above and are never re-detected.
      for (const { fingerprint } of pendingEvents) {
        this.lastKnownServers.delete(fingerprint)
      }
      this.emit('serversPendingQuarantine', pendingEvents)
    }
  }

  private async checkForChanges(source: string = 'unknown'): Promise<DetectedServerChange[]> {
    if (this.isCheckingForChanges) {
      // A scan is already in progress - mark that another pass is needed so
      // file-change-triggered rescans aren't silently dropped.
      mlog(`[Monitor] checkForChanges(${source}) - already in progress, marking pendingRescan`)
      this.pendingRescan = true
      return []
    }
    this.isCheckingForChanges = true
    try {
      let result: DetectedServerChange[]
      // Loop until no concurrent caller requested another pass while we were running.
      // In practice this runs at most twice; if the periodic timer fires faster than
      // _checkForChangesImpl completes the loop continues until stop() clears the timer.
      do {
        this.pendingRescan = false
        result = await this._checkForChangesImpl(source)
      } while (this.pendingRescan)
      return result
    } finally {
      this.isCheckingForChanges = false
    }
  }

  private async _checkForChangesImpl(source: string = 'unknown'): Promise<DetectedServerChange[]> {
    // Use raw (non-deduped) servers - quarantine handles each server individually.
    const { raw: currentServers } = await discoverMcpServers({ includeRaw: true })
    const currentMap = new Map<string, DiscoveredMcpServer>()

    for (const server of currentServers) {
      const fingerprint = getServerFingerprint(server)
      currentMap.set(fingerprint, server)
    }

    mlog(`[Monitor] _checkForChangesImpl(${source}): discovered ${currentServers.length} servers, lastKnown=${this.lastKnownServers.size}`)
    mlog(`[Monitor]   current: ${currentServers.map(s => `${s.name}@${s.client}`).join(', ')}`)
    mlog(`[Monitor]   lastKnown fingerprints: ${[...this.lastKnownServers.keys()].join(', ')}`)
    mlog(`[Monitor]   current fingerprints: ${[...currentMap.keys()].join(', ')}`)

    const changes: DetectedServerChange[] = []
    const addedServers: { server: DiscoveredMcpServer; fingerprint: string }[] = []

    // Check for added or modified servers
    for (const [fingerprint, server] of currentMap) {
      const previous = this.lastKnownServers.get(fingerprint)

      if (!previous) {
        // New server added - collect for quarantine
        mlog(`[Monitor]   NEW server: ${server.name} (${fingerprint}) from ${server.path}`)
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
    mlog(`[Monitor] addedServers: ${addedServers.length}, changes: ${changes.length}`)
    const pendingEvents: PendingQuarantineEvent[] = []
    for (const { server, fingerprint } of addedServers) {
      // Skip Edison Watch's own servers
      if (isEdisonWatchServer(server)) {
        mlog(`[Monitor] Skipping Edison Watch server: ${server.name}`)
        continue
      }

      // Skip opaque servers (IDE-managed MCPs with no accessible config - e.g. Cursor marketplace).
      if (isOpaqueConfig(server.config)) {
        console.log(`[McpConfigMonitor] Skipping opaque server (IDE-managed): ${server.name}`)
        continue
      }

      // Don't quarantine yet - let user submit first, quarantine on success/dismiss
      mlog(`[Monitor] Server pending quarantine: ${server.name} from ${server.path}`)
      pendingEvents.push({ server, fingerprint })
    }

    mlog(`[Monitor] ${pendingEvents.length} servers pending quarantine`)

    // Update lastKnownServers to reflect current state so the next scan can
    // correctly detect additions/removals.
    this.lastKnownServers = currentMap

    if (pendingEvents.length > 0) {
      console.log('[McpConfigMonitor] Servers pending quarantine:', pendingEvents.map(e => e.server.name))
      // Remove pending-quarantine servers from lastKnownServers so that when
      // Cursor reinstalls them (restoring the cache dir), the next scan sees
      // them as NEW and re-quarantines. Quarantine happens asynchronously in
      // the listener - if we leave them in the map, the next scan (triggered
      // by Cursor restoring the dir) sees matching fingerprints and does nothing.
      for (const { fingerprint } of pendingEvents) {
        this.lastKnownServers.delete(fingerprint)
      }
      this.emit('serversPendingQuarantine', pendingEvents)
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
  // Filter out any server with "edison-watch" in its name or URL
  if (server.name.includes('edison-watch')) return true

  const config = server.config
  if ('command' in config && config.command) {
    const args = config.args?.join(' ') ?? ''
    const argsList = config.args ?? []
    if (argsList.some((arg) => String(arg).includes('edison-watch'))) return true
    return (
      config.command === 'npx' &&
      args.includes('mcp-remote') &&
      (args.includes('edison.watch') ||
        (args.includes('localhost:') && argsList.some((arg) => /\/mcp(?:\/|$)/.test(String(arg)))))
    )
  }
  if ('url' in config && config.url) {
    if (config.url.includes('edison-watch')) return true
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
    case 'cursor':
      return 'Cursor'
    case 'claude-code':
      return 'Claude Code'
    case 'windsurf':
      return 'Windsurf'
    case 'zed':
      return 'Zed'
    case 'codex':
      return 'Codex CLI'
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
