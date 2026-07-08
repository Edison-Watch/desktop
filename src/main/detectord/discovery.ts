// Source MCP-server discovery from the daemon instead of re-scanning locally.
//
// In primary mode the daemon is the single source of truth for what's on the
// machine — and, unlike the client's own scan, it sees stdio servers. This maps
// the daemon's `list_servers` into the client's DiscoveredMcpServer shape so the
// existing onboarding/dedup/submit pipeline runs unchanged on the daemon's view.

import type {
  DiscoveredMcpServer,
  McpClientId,
  McpServerConfig,
  McpServerTransport
} from '../discovery/types'

import { getDetectordClient } from './lifecycle'
import type { ServerConfig, ServerView } from './protocol'

// Daemon agent ids use underscores (`claude_code`); client ids use dashes.
const toClientId = (agent: string): McpClientId => agent.replace(/_/g, '-') as McpClientId

function mapConfig(cfg: ServerConfig): McpServerConfig | null {
  if ('Stdio' in cfg) {
    const { command, args, env } = cfg.Stdio
    return { command, args, env }
  }
  if ('Http' in cfg) {
    const { url, headers, kind } = cfg.Http
    // The client transport union has no "streamable-http"; fold it into http.
    const type: McpServerTransport = kind === 'Sse' ? 'sse' : 'http'
    return { type, url, headers }
  }
  if ('Opaque' in cfg) {
    return { type: 'opaque' }
  }
  return null
}

function toDiscovered(v: ServerView): DiscoveredMcpServer | null {
  if (v.state === 'edison') return null // never surface our own entries
  if (!v.config) return null
  const config = mapConfig(v.config)
  if (!config) return null
  return {
    name: v.name,
    client: toClientId(v.agent),
    // The daemon doesn't classify source; default to 'user'. It only affects
    // display grouping/metadata, not the supported/unsupported split (which is
    // by config shape) or submission.
    source: 'user',
    path: v.path,
    config
  }
}

/**
 * The daemon's discovered servers as DiscoveredMcpServer[], or `null` to signal
 * "fall back to local discovery" — when the daemon is unreachable or not yet
 * enrolled (e.g. before login, when it has nothing to report anyway).
 */
export async function discoverViaDetectord(): Promise<DiscoveredMcpServer[] | null> {
  const client = getDetectordClient()
  try {
    await client.connect()
    const status = await client.status()
    if (!status.enrolled) return null
    const servers = await client.listServers()
    return servers.map(toDiscovered).filter((s): s is DiscoveredMcpServer => s !== null)
  } catch (err) {
    console.warn(`[detectord] discovery via daemon failed; using local scan: ${String(err)}`)
    return null
  }
}
