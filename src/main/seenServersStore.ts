import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'

/**
 * Server actions in the new auto-quarantine flow:
 * - 'quarantined': Server was auto-quarantined (moved to disabled file)
 * - 'requested': User requested access from IT admin
 * - 'registered': Admin/owner added server directly (auto-approved)
 * - 'dismissed': User dismissed without requesting (stays quarantined)
 */
export type ServerAction = 'quarantined' | 'requested' | 'registered' | 'dismissed'

export interface SeenServer {
  fingerprint: string
  name: string
  sourceApp: string
  configPath: string
  firstSeenAt: number
  lastSeenAt: number
  action: ServerAction | null
  actionAt: number | null
  // New fields for quarantine tracking
  disabledPath?: string
  quarantinedAt?: string
}

interface StoreData {
  version: number
  servers: Record<string, SeenServer>
}

/**
 * Generate a unique fingerprint for an MCP server configuration.
 * Uses name + command/url + args to create a stable hash.
 */
export function getServerFingerprint(server: DiscoveredMcpServer): string {
  const config = server.config as McpServerConfig
  let identifier: string

  if ('command' in config && config.command) {
    // stdio server - use command + args
    const args = config.args?.join(' ') ?? ''
    identifier = `${server.name}:${config.command}:${args}`
  } else if ('url' in config && config.url) {
    // http/sse server - use url
    identifier = `${server.name}:${config.url}`
  } else {
    // Fallback to just name + client
    identifier = `${server.name}:${server.client}`
  }

  return createHash('sha256').update(identifier).digest('hex').slice(0, 16)
}

/**
 * Persistent store for tracking which MCP servers have been seen and
 * what actions were taken on them.
 */
export class SeenServersStore {
  private storePath: string
  private data: StoreData = { version: 1, servers: {} }
  private loaded = false

  constructor(storePath?: string) {
    this.storePath = storePath ?? join(app.getPath('userData'), 'seen-servers.json')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    try {
      const raw = await fs.readFile(this.storePath, 'utf-8')
      const parsed = JSON.parse(raw) as StoreData
      if (parsed.version === 1 && parsed.servers) {
        this.data = parsed
      }
    } catch {
      // File doesn't exist or is invalid, start fresh
      this.data = { version: 1, servers: {} }
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    try {
      await fs.writeFile(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save seen servers store:', err)
    }
  }

  /**
   * Check if a server has been seen before.
   */
  async hasSeen(server: DiscoveredMcpServer): Promise<boolean> {
    await this.ensureLoaded()
    const fingerprint = getServerFingerprint(server)
    return fingerprint in this.data.servers
  }

  /**
   * Check if a server has been seen and already has an action taken.
   */
  async hasAction(server: DiscoveredMcpServer): Promise<boolean> {
    await this.ensureLoaded()
    const fingerprint = getServerFingerprint(server)
    const seen = this.data.servers[fingerprint]
    return seen?.action !== null && seen?.action !== undefined
  }

  /**
   * Mark a server as seen, optionally with an action and quarantine info.
   */
  async markSeen(
    server: DiscoveredMcpServer,
    action?: ServerAction,
    quarantineInfo?: { disabledPath: string; quarantinedAt: string }
  ): Promise<void> {
    await this.ensureLoaded()
    const fingerprint = getServerFingerprint(server)
    const now = Date.now()

    const existing = this.data.servers[fingerprint]
    this.data.servers[fingerprint] = {
      fingerprint,
      name: server.name,
      sourceApp: server.client,
      configPath: server.path,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      action: action ?? existing?.action ?? null,
      actionAt: action ? now : (existing?.actionAt ?? null),
      disabledPath: quarantineInfo?.disabledPath ?? existing?.disabledPath,
      quarantinedAt: quarantineInfo?.quarantinedAt ?? existing?.quarantinedAt
    }

    await this.save()
  }

  /**
   * Update the action for a previously seen server.
   */
  async markAction(fingerprint: string, action: ServerAction): Promise<void> {
    await this.ensureLoaded()

    if (this.data.servers[fingerprint]) {
      this.data.servers[fingerprint].action = action
      this.data.servers[fingerprint].actionAt = Date.now()
      await this.save()
    }
  }

  /**
   * Upsert an entry from the backend's authoritative list of registered servers.
   *
   * Called by the pre-quarantine sync (seenServersBackendSync.ts) so the local
   * "is this server known?" decision is coherent with the org's actual state on
   * the backend, instead of relying on whatever this particular client happened
   * to write to disk in the past.
   *
   * Backend wins: any existing local action ('quarantined', 'requested',
   * 'dismissed') is overwritten with 'registered' because admin/owner approval
   * server-side is the strongest authority. The user's previous dismissal in
   * this client should not override an org-level approval.
   *
   * The store still owns sourceApp/configPath; if we don't yet have an entry,
   * we synthesize a placeholder using the backend-provided name. The next
   * discovery pass will overwrite those placeholder fields with the real
   * client/path the next time markSeen() runs.
   */
  async markRegisteredFromBackend(fingerprint: string, name: string): Promise<void> {
    await this.ensureLoaded()
    const now = Date.now()
    const existing = this.data.servers[fingerprint]

    this.data.servers[fingerprint] = {
      fingerprint,
      name: existing?.name ?? name,
      sourceApp: existing?.sourceApp ?? '',
      configPath: existing?.configPath ?? '',
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: existing?.lastSeenAt ?? now,
      action: 'registered',
      actionAt: now,
      disabledPath: existing?.disabledPath,
      quarantinedAt: existing?.quarantinedAt
    }

    await this.save()
  }

  /**
   * Get a seen server by fingerprint.
   */
  async get(fingerprint: string): Promise<SeenServer | null> {
    await this.ensureLoaded()
    return this.data.servers[fingerprint] ?? null
  }

  /**
   * Get all seen servers.
   */
  async getAll(): Promise<SeenServer[]> {
    await this.ensureLoaded()
    return Object.values(this.data.servers)
  }

  /**
   * Remove a server from the seen list.
   */
  async remove(fingerprint: string): Promise<void> {
    await this.ensureLoaded()
    delete this.data.servers[fingerprint]
    await this.save()
  }

  /**
   * Clear all seen servers (for debugging/reset).
   */
  async clear(): Promise<void> {
    this.data = { version: 1, servers: {} }
    await this.save()
  }
}

/** Shared singleton instance used by both quarantine and submission flows. */
let sharedInstance: SeenServersStore | null = null

export function getSharedSeenStore(): SeenServersStore {
  if (!sharedInstance) sharedInstance = new SeenServersStore()
  return sharedInstance
}
