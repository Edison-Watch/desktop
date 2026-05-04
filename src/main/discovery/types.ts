/**
 * Shared types for MCP server discovery across all clients.
 */

export type McpClientId =
  | 'vscode'
  | 'cursor'
  | 'claude-code'
  | 'claude-desktop'
  | 'claude-cowork'
  | 'windsurf'
  | 'zed'
  | 'codex'
  | 'intellij'
  | 'pycharm'
  | 'webstorm'

export type McpServerTransport = 'stdio' | 'http' | 'sse'

export type McpServerConfig =
  | {
      // stdio server
      type?: undefined
      command: string
      args?: string[]
      env?: Record<string, string>
      envFile?: string
    }
  | {
      // http/sse server (with explicit type)
      type: McpServerTransport
      url: string
      headers?: Record<string, string>
    }
  | {
      // http server (bare url, no type - used by Cursor and others)
      type?: undefined
      command?: undefined
      url: string
      headers?: Record<string, string>
    }
  | {
      // IDE-managed server with no accessible launch config (e.g. Cursor marketplace MCPs)
      type: 'opaque'
    }

export interface DiscoveredMcpServer {
  name: string
  /** Original key in the config file (before deduplication suffix). Falls back to `name` when absent. */
  originalName?: string
  client: McpClientId
  /** All clients where this server was found (populated by deduplication). */
  clients?: McpClientId[]
  source: 'user' | 'workspace' | 'remote' | 'unknown' | 'enterprise' | 'project' | 'marketplace' | 'plugin'
  path: string
  config: McpServerConfig
  projectName?: string
  /** Claude Code profile name (when discovered inside a profiles.{name} block). */
  profileName?: string
}

export interface DiscoveryResult {
  servers: DiscoveredMcpServer[]
  raw: DiscoveredMcpServer[]
  unsupported: DiscoveredMcpServer[]
}

/** Check whether a server config is opaque (IDE-managed, no accessible launch config). */
export function isOpaqueConfig(config: McpServerConfig): boolean {
  return 'type' in config && config.type === 'opaque'
}

/**
 * True iff `headers` is present on the config but is not a plain JSON object
 * mapping name → value. Hand-edited mcp.json files sometimes carry the dict
 * stringified (e.g. `"headers": "Authorization: Bearer x"`); when that hits
 * the credential-review screen, JS iterates the string by character index
 * and renders the headers as `0=A 1=u 2=t ...` rows.
 *
 * The accept criterion is intentionally tight: a plain object whose values
 * are all strings. Arrays, scalars, and nested objects are rejected.
 */
export function hasMalformedHeaders(config: McpServerConfig): boolean {
  if (!('headers' in config)) return false
  const headers = (config as { headers?: unknown }).headers
  if (headers === undefined || headers === null) return false
  if (
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.getPrototypeOf(headers) !== Object.prototype
  ) {
    return true
  }
  for (const v of Object.values(headers as Record<string, unknown>)) {
    if (typeof v !== 'string') return true
  }
  return false
}

/**
 * Human-readable explanation of why a server was classified as unsupported.
 * Returns null for supported servers.
 */
export function describeUnsupportedReason(server: DiscoveredMcpServer): string | null {
  if (isOpaqueConfig(server.config)) {
    if (server.client === 'cursor' && server.source === 'marketplace') {
      return 'Cursor marketplace plugin: only SERVER_METADATA.json is exposed (no launch config)'
    }
    if (server.client === 'vscode' && server.source === 'marketplace') {
      return 'VS Code-style extension-managed server: state DB exposes no launch URL or command'
    }
    if (server.source === 'marketplace') {
      return `${server.client} marketplace install exposes no launch config`
    }
    return 'Opaque config (no launch command or URL surfaced by the host)'
  }
  if (hasMalformedHeaders(server.config)) {
    return 'Invalid `headers`: expected a JSON object mapping name → value (e.g. {"Authorization": "Bearer ..."})'
  }
  if ('command' in server.config && server.config.command) {
    return 'Local stdio servers are not yet supported'
  }
  return null
}
