// Route onboarding's "register these servers" actions through the daemon.
//
// In primary mode the daemon owns submit (templatize secrets, send to EW, mark
// seen, remove locally) and handles stdio servers the client's own http-only
// submit path can't. Onboarding's bulk submit + rename-resubmit map cleanly onto
// per-server `disposition(send_to_ew[, rename])` calls.

import type { DiscoveredMcpServer, McpServerConfig } from '../discovery/types'
import type { TemplateOverride } from '../discovery/mcpServerSubmit'

import { getDetectordClient } from './lifecycle'
import type { ServerConfig } from './protocol'

// Client ids use dashes (`claude-code`); daemon agent names use underscores.
const toAgent = (client: string): string => client.replace(/-/g, '_')

/**
 * Apply the credential-review overrides to a config, replacing each user-selected
 * span with a `{varName}` placeholder. Mirrors submitServerWithOverrides so the
 * daemon submit honors the same manual redactions the http path used to.
 */
function applyTemplateOverrides(
  config: McpServerConfig,
  overrides: TemplateOverride[]
): McpServerConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  for (const ov of overrides) {
    const [context, key] = ov.entryId.split(':', 2)
    if (context === undefined || key === undefined) continue
    const replaceInValue = (raw: string): string =>
      raw.slice(0, ov.start) + `{${ov.varName}}` + raw.slice(ov.end)
    if (context === 'args') {
      const idx = parseInt(key.match(/\d+/)?.[0] ?? '0', 10)
      const args = cloned.args as string[] | undefined
      if (args && args[idx] !== undefined) args[idx] = replaceInValue(args[idx])
    } else if (context === 'env') {
      const env = cloned.env as Record<string, string> | undefined
      if (env && env[key] !== undefined) env[key] = replaceInValue(env[key])
    } else if (context === 'url') {
      cloned.url = replaceInValue(String(cloned.url))
    } else if (context === 'headers') {
      const headers = cloned.headers as Record<string, string> | undefined
      if (headers && headers[key] !== undefined) headers[key] = replaceInValue(headers[key])
    }
  }
  return cloned as McpServerConfig
}

/** Map a client config into the daemon's wire ServerConfig, or null if unmappable (opaque). */
function toDaemonSubmitConfig(config: McpServerConfig): ServerConfig | null {
  if ('command' in config && config.command) {
    return { Stdio: { command: config.command, args: config.args ?? [], env: config.env ?? {} } }
  }
  if ('url' in config && config.url) {
    return {
      Http: { url: config.url, headers: config.headers ?? {}, kind: config.type === 'sse' ? 'Sse' : 'Http' }
    }
  }
  return null
}

export interface DetectordSubmitFailure {
  name: string
  client: string
  reason: 'conflict' | 'error' | 'already-on-backend'
  message: string
  config?: Record<string, unknown>
  configPath?: string
  backendStatus?: 'registered' | 'requested'
}

export interface DetectordSubmitSummary {
  submitted: number
  autoApproved: number
  skipped: number
  alreadyOnBackend: number
  total: number
  servers: Array<{ name: string; client: string; clients?: string[]; source: string }>
  failures: DetectordSubmitFailure[]
}

/**
 * Submit each server via the daemon. Success => submitted (autoApproved when the
 * user is admin/owner, since the daemon registers directly for those roles). A
 * backend 409 comes back as a `conflict:` error, surfaced as a conflict failure
 * carrying the config so onboarding can offer the rename-resubmit flow.
 */
export async function submitServersViaDetectord(
  servers: DiscoveredMcpServer[],
  overrides?: Record<string, TemplateOverride[]>
): Promise<DetectordSubmitSummary> {
  const client = getDetectordClient()
  const serverList = servers.map((s) => ({
    name: s.name,
    client: s.client,
    clients: s.clients,
    source: s.source
  }))
  try {
    // connect() before status/disposition. On an unreachable daemon, return a
    // summary with every server marked failed rather than throwing to the IPC
    // handler; the caller renders per-server failures.
    await client.connect()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      submitted: 0,
      autoApproved: 0,
      skipped: 0,
      alreadyOnBackend: 0,
      total: servers.length,
      servers: serverList,
      failures: servers.map((s) => ({
        name: s.name,
        client: s.client,
        reason: 'error' as const,
        message
      }))
    }
  }
  const status = await client.status().catch(() => null)
  const isAdminOrOwner = status?.role === 'admin' || status?.role === 'owner'

  let submitted = 0
  let autoApproved = 0
  const failures: DetectordSubmitFailure[] = []
  for (const s of servers) {
    // Client-side dedup renames name-conflicting servers (e.g. name "sqlite_cursor",
    // originalName "sqlite"). The daemon only knows the discovered (original) name,
    // so submit under that and pass the deduped name as the disposition rename -
    // mirroring resubmitServerViaDetectord. Non-conflicting servers have no
    // originalName, so daemonName === s.name and rename stays undefined.
    const daemonName = s.originalName ?? s.name
    const rename = s.originalName ? s.name : undefined
    // An explicitly provided overrides array is the user's complete, authoritative
    // redaction set from credential review (even an empty array means "nothing
    // here is a secret" - the daemon must submit it verbatim, not auto-templatize).
    // Absent (undefined) => no review for this server => let the daemon
    // auto-templatize its discovered config.
    const ov = overrides?.[s.name]
    const submitConfig =
      ov !== undefined ? (toDaemonSubmitConfig(applyTemplateOverrides(s.config, ov)) ?? undefined) : undefined
    try {
      await client.disposition(daemonName, 'send_to_ew', toAgent(s.client), rename, submitConfig)
      submitted++
      if (isAdminOrOwner) autoApproved++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/conflict/i.test(message)) {
        failures.push({
          name: s.name,
          client: s.client,
          reason: 'conflict',
          message,
          config: s.config as unknown as Record<string, unknown>,
          configPath: s.path
        })
      } else {
        failures.push({ name: s.name, client: s.client, reason: 'error', message })
      }
    }
  }
  return {
    submitted,
    autoApproved,
    skipped: 0,
    alreadyOnBackend: 0,
    total: servers.length,
    servers: serverList,
    failures
  }
}

/** Resubmit a name-conflicting server under a new name via the daemon. */
export async function resubmitServerViaDetectord(
  name: string,
  newName: string,
  client?: string
): Promise<{ success: boolean; error?: string }> {
  const c = getDetectordClient()
  try {
    // connect() inside the try so an unreachable daemon fulfills the
    // {success:false, error} contract instead of throwing to the IPC handler.
    await c.connect()
    // No client → leave agent unspecified so the daemon matches by name alone
    // (matches the pre-primary cache path). An empty string would match nothing.
    await c.disposition(name, 'send_to_ew', client ? toAgent(client) : undefined, newName)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
