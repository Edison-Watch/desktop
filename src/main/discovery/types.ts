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
 * Human-readable explanation of why a server was classified as unsupported.
 * Returns null for supported servers.
 */
export function describeUnsupportedReason(server: DiscoveredMcpServer): string | null {
  if (!isOpaqueConfig(server.config)) return null
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
