#!/usr/bin/env npx tsx
/**
 * CLI tool to test the MCP server discovery pipeline.
 * Usage: npx tsx client_2/scripts/discover-mcp.ts [--json] [--client cursor|vscode|...]
 */
import { discoverMcpServers } from '../src/main/mcpDiscovery'
import type { DiscoveredMcpServer } from '../src/main/mcpDiscovery'

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')
const clientFilter = args.includes('--client')
  ? args[args.indexOf('--client') + 1]
  : undefined

async function main() {
  let servers: DiscoveredMcpServer[]
  try {
    servers = await discoverMcpServers()
  } catch (err) {
    console.error('Discovery failed:', err)
    process.exit(1)
  }

  if (clientFilter) {
    servers = servers.filter((s) => s.client === clientFilter)
  }

  if (jsonOutput) {
    console.log(JSON.stringify(servers, null, 2))
    return
  }

  if (servers.length === 0) {
    console.log('No MCP servers discovered.' + (clientFilter ? ` (filter: ${clientFilter})` : ''))
    return
  }

  console.log(`Discovered ${servers.length} MCP server(s):\n`)
  for (const s of servers) {
    const transport =
      'command' in s.config && s.config.command
        ? `stdio: ${s.config.command} ${(s.config.args ?? []).join(' ')}`
        : 'url' in s.config && s.config.url
          ? `url: ${s.config.url}`
          : 'unknown'
    const project = s.projectName ? ` (project: ${s.projectName})` : ''
    console.log(`  [${s.client}] ${s.name}${project}`)
    console.log(`    source: ${s.source}  path: ${s.path}`)
    console.log(`    ${transport}`)
    console.log()
  }
}

main()
