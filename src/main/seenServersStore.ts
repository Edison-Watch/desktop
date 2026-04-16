import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { app } from 'electron'
import type { DiscoveredMcpServer, McpServerConfig } from './mcpDiscovery'

/**
 * Server actions in the auto-quarantine flow:
 * - 'quarantined': Server was auto-quarantined (moved to disabled file)
 * - 'requested': User requested access from IT admin
 * - 'registered': Admin/owner added server directly (auto-approved)
 * - 'dismissed': User dismissed without requesting (stays quarantined)
 */
export type ServerAction = 'quarantined' | 'requested' | 'registered' | 'dismissed'

export interface SeenServer {
  /** UUID of the org the user was signed into when this entry was recorded. */
  org_id: string
  fingerprint: string
  name: string
  sourceApp: string
  configPath: string
  firstSeenAt: number
  lastSeenAt: number
  action: ServerAction | null
  actionAt: number | null
  disabledPath?: string
  quarantinedAt?: string
}

interface StoreData {
  /**
   * Compound key "<org_id>:<fingerprint>" so the same MCP fingerprint can
   * coexist as separate entries across different orgs when the user switches
   * logins. Entries missing `org_id` or whose key doesn't match this shape
   * are dropped on load.
   */
  servers: Record<string, SeenServer>
}

function composeKey(orgId: string, fingerprint: string): string {
  return `${orgId}:${fingerprint}`
}

/**
 * Generate a unique fingerprint for an MCP server configuration.
 * Uses name + command/url + args to create a stable hash.
 */
export function getServerFingerprint(server: DiscoveredMcpServer): string {
  const config = server.config as McpServerConfig
  let identifier: string

  if ('command' in config && config.command) {
    const args = config.args?.join(' ') ?? ''
    identifier = `${server.name}:${config.command}:${args}`
  } else if ('url' in config && config.url) {
    identifier = `${server.name}:${config.url}`
  } else {
    identifier = `${server.name}:${server.client}`
  }

  return createHash('sha256').update(identifier).digest('hex').slice(0, 16)
}

/**
 * Persistent store for tracking which MCP servers have been seen and
 * what actions were taken on them. Entries are partitioned by org_id so
 * state from a previous login session cannot influence decisions made
 * while signed in as a different org.
 */
export class SeenServersStore {
  private storePath: string
  private data: StoreData = { servers: {} }
  private loaded = false

  constructor(storePath?: string) {
    this.storePath = storePath ?? join(app.getPath('userData'), 'seen-servers.json')
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return

    try {
      const raw = await fs.readFile(this.storePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && 'servers' in parsed) {
        const rawServers = (parsed as { servers: unknown }).servers
        if (rawServers && typeof rawServers === 'object') {
          const filtered: Record<string, SeenServer> = {}
          for (const [key, value] of Object.entries(rawServers as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue
            const entry = value as Partial<SeenServer>
            // Reject legacy (un-scoped) entries and malformed rows.
            if (
              typeof entry.org_id !== 'string' ||
              !entry.org_id ||
              typeof entry.fingerprint !== 'string' ||
              !entry.fingerprint ||
              key !== composeKey(entry.org_id, entry.fingerprint)
            ) {
              continue
            }
            filtered[key] = entry as SeenServer
          }
          this.data = { servers: filtered }
        }
      }
    } catch {
      this.data = { servers: {} }
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

  async hasSeen(orgId: string, server: DiscoveredMcpServer): Promise<boolean> {
    await this.ensureLoaded()
    return composeKey(orgId, getServerFingerprint(server)) in this.data.servers
  }

  async hasAction(orgId: string, server: DiscoveredMcpServer): Promise<boolean> {
    await this.ensureLoaded()
    const seen = this.data.servers[composeKey(orgId, getServerFingerprint(server))]
    return seen?.action !== null && seen?.action !== undefined
  }

  /**
   * Mark a server as seen under the given org, optionally with an action and
   * quarantine info.
   */
  async markSeen(
    orgId: string,
    server: DiscoveredMcpServer,
    action?: ServerAction,
    quarantineInfo?: { disabledPath: string; quarantinedAt: string },
  ): Promise<void> {
    await this.ensureLoaded()
    const fingerprint = getServerFingerprint(server)
    const key = composeKey(orgId, fingerprint)
    const now = Date.now()

    const existing = this.data.servers[key]
    const finalAction = action ?? existing?.action ?? null
    this.data.servers[key] = {
      org_id: orgId,
      fingerprint,
      name: server.name,
      sourceApp: server.client,
      configPath: server.path,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      action: finalAction,
      actionAt: action ? now : (existing?.actionAt ?? null),
      disabledPath: quarantineInfo?.disabledPath ?? existing?.disabledPath,
      quarantinedAt: quarantineInfo?.quarantinedAt ?? existing?.quarantinedAt,
    }
    console.log(
      `[SeenStore] markSeen org=${orgId} name=${server.name} fp=${fingerprint} action=${finalAction ?? 'null'} (${existing ? 'update' : 'insert'})`,
    )

    await this.save()
  }

  async markAction(orgId: string, fingerprint: string, action: ServerAction): Promise<void> {
    await this.ensureLoaded()
    const key = composeKey(orgId, fingerprint)
    if (this.data.servers[key]) {
      this.data.servers[key].action = action
      this.data.servers[key].actionAt = Date.now()
      await this.save()
    }
  }

  /**
   * Upsert an entry from the backend's authoritative server list.
   * Backend wins: any existing local action is overwritten with the
   * backend-supplied action because the server-side view (approved or
   * pending admin review) is the strongest authority.
   *
   * `action` is 'registered' for approved TemplateMcpServerDefinitions rows
   * and 'requested' for pending mcp_server_requests rows - see
   * src/api/v1/routes/servers_fingerprints.py for the classification.
   */
  async markFromBackend(
    orgId: string,
    fingerprint: string,
    name: string,
    action: 'registered' | 'requested',
  ): Promise<void> {
    await this.ensureLoaded()
    const key = composeKey(orgId, fingerprint)
    const now = Date.now()
    const existing = this.data.servers[key]

    this.data.servers[key] = {
      org_id: orgId,
      fingerprint,
      name: existing?.name ?? name,
      sourceApp: existing?.sourceApp ?? '',
      configPath: existing?.configPath ?? '',
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: existing?.lastSeenAt ?? now,
      action,
      actionAt: now,
      disabledPath: existing?.disabledPath,
      quarantinedAt: existing?.quarantinedAt,
    }
    console.log(
      `[SeenStore] markFromBackend org=${orgId} name=${name} fp=${fingerprint} action=${action} (${existing ? `update, was action=${existing.action}` : 'insert'})`,
    )

    await this.save()
  }

  async get(orgId: string, fingerprint: string): Promise<SeenServer | null> {
    await this.ensureLoaded()
    return this.data.servers[composeKey(orgId, fingerprint)] ?? null
  }

  async getAll(): Promise<SeenServer[]> {
    await this.ensureLoaded()
    return Object.values(this.data.servers)
  }

  /** Return all entries for a specific org. */
  async getAllForOrg(orgId: string): Promise<SeenServer[]> {
    await this.ensureLoaded()
    return Object.values(this.data.servers).filter((s) => s.org_id === orgId)
  }

  async remove(orgId: string, fingerprint: string): Promise<void> {
    await this.ensureLoaded()
    delete this.data.servers[composeKey(orgId, fingerprint)]
    await this.save()
  }

  /**
   * Delete any entries for the given org whose fingerprint is NOT in
   * `keepFingerprints`. Entries for other orgs are untouched.
   *
   * Used by the backend sync to reconcile the local store against the org's
   * authoritative server list after a fetch.
   */
  async pruneForOrg(orgId: string, keepFingerprints: Set<string>): Promise<void> {
    await this.ensureLoaded()
    const removed: string[] = []
    for (const [key, entry] of Object.entries(this.data.servers)) {
      if (entry.org_id !== orgId) continue
      if (keepFingerprints.has(entry.fingerprint)) continue
      removed.push(`${entry.name}(fp=${entry.fingerprint} action=${entry.action})`)
      delete this.data.servers[key]
    }
    if (removed.length > 0) {
      console.log(`[SeenStore] pruneForOrg org=${orgId} removed ${removed.length} stale: ${removed.join(', ')}`)
      await this.save()
    } else {
      console.log(`[SeenStore] pruneForOrg org=${orgId} - nothing to prune (kept=${keepFingerprints.size})`)
    }
  }

  /** Clear all seen servers (for debugging/reset). */
  async clear(): Promise<void> {
    this.data = { servers: {} }
    await this.save()
  }
}

/** Shared singleton instance used by both quarantine and submission flows. */
let sharedInstance: SeenServersStore | null = null

export function getSharedSeenStore(): SeenServersStore {
  if (!sharedInstance) sharedInstance = new SeenServersStore()
  return sharedInstance
}
