import type { DiscoveredMcpServer, McpClientId } from '../discovery/mcpDiscovery'

// MCP config monitoring (file watching, detection, and auto-quarantine) has been
// moved into the detectord daemon. This module now only holds the small pure
// helpers that classify Edison Watch's own servers and format client names,
// which are still used by the dialogs and MCP-submit IPC handlers.

/**
 * Check if a server is an Edison Watch server (to avoid acting on our own servers).
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
      return 'Codex'
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
