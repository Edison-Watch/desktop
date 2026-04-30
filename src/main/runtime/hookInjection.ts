/**
 * Hook Injection Module - orchestration layer.
 *
 * Injects hooks into MCP client applications to register project contexts
 * with Edison Watch when tool calls are executed.
 *
 * The three public functions iterate `CLIENT_LIST` from
 * `../clients/registry.ts` and delegate per-client work to each integration's
 * `hooks` sub-object. Clients without a hook system (Zed, JetBrains) have
 * `hooks === undefined` and are skipped by inject/remove but still surface an
 * MCP-only status entry in `getHookStatus`.
 *
 * MCP-configured probing still lives here; it moves into each integration's
 * `edisonMcp` sub-object in a separate PR.
 *
 * Re-exports all per-client helpers so existing consumers work unchanged.
 */

import { promises as fs, existsSync } from 'fs'
import { platform } from 'os'
import { parse as parseJsonc } from 'jsonc-parser'
import type { McpClientId } from '../discovery/types'
import { CLIENT_LIST } from '../clients/registry'
import type { ClientIntegration } from '../clients/types'
import { getVscodeUserMcpPath } from '../clients/vscode/discovery'
import { getCursorConfigPath } from '../clients/cursor/discovery'
import { getWindsurfConfigPath } from '../clients/windsurf/discovery'
import { getClaudeCodeHomeJsonPath } from '../clients/claude-code/discovery'
import { getClaudeDesktopConfigPath } from '../clients/claude-desktop/discovery'
import { getClaudeCoworkConfigPath } from '../clients/claude-cowork/discovery'
import { extractEdisonUrl } from './mcpConfigWriter'
import { getZedConfigPath } from '../clients/zed/discovery'
import {
  getJetBrainsMcpConfigPaths,
  getInstalledJetBrainsIdes,
} from '../clients/jetbrains/discovery'
import { captureError } from '../infra/sentry'
import { getVsCodeWorkspacePaths } from './mcpProjectPaths'
import { getCodexConfigPath } from '../clients/codex/hooks'
import {
  injectVsCodeWorkspaceHook,
  removeVsCodeWorkspaceHook,
} from '../clients/vscode/hooks'
import type { ClaudeCodeMcpStatus } from '../infra/setupConfig'

// Re-export all helpers so existing imports of hookInjection still work.
export * from './hookInjectionCore'
export * from '../clients/shared'
export * from '../clients/claude-code/hooks'
export * from '../clients/cursor/hooks'
export * from '../clients/windsurf/hooks'
export * from '../clients/codex/hooks'
export * from '../clients/vscode/hooks'

/**
 * Result of hook injection for a client.
 */
export interface HookInjectionResult {
  client: McpClientId
  installed: boolean
  alreadyExists: boolean
  error?: string
}

// ── Inject / Remove ─────────────────────────────────────────────────────────

async function runHookOp(
  client: ClientIntegration,
  op: 'inject' | 'remove',
  operation: 'injectAllHooks' | 'removeAllHooks',
): Promise<HookInjectionResult> {
  const hooks = client.hooks!
  try {
    const changed = op === 'inject' ? await hooks.inject() : await hooks.remove()
    const installed = op === 'inject' ? changed : false
    return { client: client.id, installed, alreadyExists: !changed }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: client.id, operation, platform: platform()
    })
    return { client: client.id, installed: false, alreadyExists: false, error: String(err) }
  }
}

/**
 * Inject hooks into all supported MCP clients.
 */
export async function injectAllHooks(): Promise<HookInjectionResult[]> {
  const results: HookInjectionResult[] = []

  for (const client of CLIENT_LIST) {
    if (!client.hooks) continue
    if (!client.isInstalled()) continue
    results.push(await runHookOp(client, 'inject', 'injectAllHooks'))
  }

  // VS Code workspace tasks: per-workspace, orchestrated separately from the
  // client-level hook registry. Kept out of the loop because these call sites
  // are also reused from ipcHandlers.
  try {
    const workspacePaths = await getVsCodeWorkspacePaths()
    for (const wsPath of workspacePaths) {
      await injectVsCodeWorkspaceHook(wsPath)
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: 'vscode', operation: 'injectAllHooks', platform: platform()
    })
  }

  return results
}

/**
 * Remove hooks from all MCP clients.
 */
export async function removeAllHooks(): Promise<HookInjectionResult[]> {
  const results: HookInjectionResult[] = []

  for (const client of CLIENT_LIST) {
    if (!client.hooks) continue
    if (!client.isInstalled()) continue
    results.push(await runHookOp(client, 'remove', 'removeAllHooks'))
  }

  // VS Code workspace tasks removal (see note in injectAllHooks).
  try {
    const workspacePaths = await getVsCodeWorkspacePaths()
    for (const wsPath of workspacePaths) {
      await removeVsCodeWorkspaceHook(wsPath)
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: 'vscode', operation: 'removeAllHooks', platform: platform()
    })
  }

  return results
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Get the status of Edison Watch hooks for all clients.
 */
export interface HookStatusEntry {
  client: McpClientId
  installed: boolean
  hasHook: boolean
  hookCount: number
  totalHooks: number
  mcpConnected: boolean
  mcpConfigured: boolean
  mcpApplicable: boolean
  hooksApplicable: boolean
  mcpRuntimeStatus?: ClaudeCodeMcpStatus
}

async function checkMcpEntry(
  configPath: string,
  serversKey: 'servers' | 'mcpServers',
  expectedMcpUrl: string | null,
): Promise<boolean> {
  if (!expectedMcpUrl) return false
  try {
    if (!existsSync(configPath)) return false
    const raw = await fs.readFile(configPath, 'utf-8')
    const json = parseJsonc(raw) as Record<string, unknown>
    const servers = json[serversKey] as Record<string, Record<string, unknown>> | undefined
    const entry = servers?.['edison-watch']
    // Pull the URL using the shape-aware extractor so the stdio-shim entry
    // shape used for Claude Desktop / Cowork (npx mcp-remote <url> ...) is
    // recognised, not just the plain Streamable HTTP shape.
    const entryUrl = extractEdisonUrl(entry)
    if (!entryUrl) return false
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    return strip(entryUrl) === strip(expectedMcpUrl)
  } catch {
    return false
  }
}

async function checkCodexMcpEntry(
  configPath: string,
  expectedMcpUrl: string | null,
): Promise<boolean> {
  if (!expectedMcpUrl) return false
  try {
    if (!existsSync(configPath)) return false
    const content = await fs.readFile(configPath, 'utf-8')
    const sectionMatch = content.match(/\[mcp_servers\.edison-watch\][^\n]*\n((?:(?!\n\[)[\s\S])*?)(?=\n\[|\s*$)/)
    if (!sectionMatch) return false
    const sectionBody = sectionMatch[1]
    const urlMatch = sectionBody.match(/url\s*=\s*"([^"]*)"/)
    if (!urlMatch) return false
    const unescaped = urlMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    return strip(unescaped) === strip(expectedMcpUrl)
  } catch {
    return false
  }
}

async function checkZedMcpEntry(
  configPath: string,
  expectedMcpUrl: string | null,
): Promise<boolean> {
  if (!expectedMcpUrl) return false
  try {
    if (!existsSync(configPath)) return false
    const raw = await fs.readFile(configPath, 'utf-8')
    const json = parseJsonc(raw) as { assistant?: { mcp_servers?: Record<string, { url?: string }> }; [k: string]: unknown }
    const entry = json.assistant?.mcp_servers?.['edison-watch']
    if (!entry?.url) return false
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    return strip(entry.url) === strip(expectedMcpUrl)
  } catch {
    return false
  }
}

async function probeMcpConfigured(
  clientId: McpClientId,
  installed: boolean,
  expectedMcpUrl: string | null,
): Promise<boolean> {
  if (!installed) return false
  switch (clientId) {
    case 'claude-code':
      return checkMcpEntry(getClaudeCodeHomeJsonPath(), 'mcpServers', expectedMcpUrl)
    case 'claude-desktop':
      return checkMcpEntry(getClaudeDesktopConfigPath(), 'mcpServers', expectedMcpUrl)
    case 'claude-cowork':
      return checkMcpEntry(getClaudeCoworkConfigPath(), 'mcpServers', expectedMcpUrl)
    case 'cursor':
      return checkMcpEntry(getCursorConfigPath(), 'mcpServers', expectedMcpUrl)
    case 'windsurf':
      return checkMcpEntry(getWindsurfConfigPath(), 'mcpServers', expectedMcpUrl)
    case 'vscode':
      return checkMcpEntry(getVscodeUserMcpPath(), 'servers', expectedMcpUrl)
    case 'codex':
      return checkCodexMcpEntry(getCodexConfigPath(), expectedMcpUrl)
    case 'zed':
      return checkZedMcpEntry(getZedConfigPath(), expectedMcpUrl)
    case 'intellij':
    case 'pycharm':
    case 'webstorm': {
      const entries = await getJetBrainsMcpConfigPaths()
      for (const { client, path } of entries) {
        if (client !== clientId) continue
        if (await checkMcpEntry(path, 'mcpServers', expectedMcpUrl)) return true
      }
      return false
    }
  }
}

export async function getHookStatus(
  expectedMcpUrl?: string | null,
  mcpServerAlive = false,
  claudeCodeMcpStatus?: ClaudeCodeMcpStatus,
): Promise<HookStatusEntry[]> {
  const results: HookStatusEntry[] = []
  const url = expectedMcpUrl ?? null

  // JetBrains installed-state probe reuses the filesystem check so we can
  // AND it with bundle existence before the per-client loop.
  const installedJetBrains = await getInstalledJetBrainsIdes()

  for (const client of CLIENT_LIST) {
    const hooksApplicable = client.hooks !== undefined

    let base: { installed: boolean; hasHook: boolean; hookCount: number; totalHooks: number }
    if (client.hooks) {
      base = await client.hooks.getStatus()
    } else if (client.id === 'intellij' || client.id === 'pycharm' || client.id === 'webstorm') {
      // JetBrains isInstalled() is a sync .app-bundle probe; also require the
      // preferences-folder scan to match the legacy strict check.
      const installed = installedJetBrains.has(client.id) && client.isInstalled()
      base = { installed, hasHook: false, hookCount: 0, totalHooks: 0 }
    } else {
      base = { installed: client.isInstalled(), hasHook: false, hookCount: 0, totalHooks: 0 }
    }

    const mcpConfigured = await probeMcpConfigured(client.id, base.installed, url)

    let mcpConnected = mcpConfigured && mcpServerAlive
    let mcpRuntimeStatus: ClaudeCodeMcpStatus | undefined
    if (client.id === 'claude-code') {
      mcpRuntimeStatus = claudeCodeMcpStatus
      if (claudeCodeMcpStatus && claudeCodeMcpStatus !== 'unknown') {
        mcpConnected = claudeCodeMcpStatus === 'connected'
      }
    }

    results.push({
      client: client.id,
      installed: base.installed,
      hasHook: base.hasHook,
      hookCount: base.hookCount,
      totalHooks: base.totalHooks,
      mcpConnected,
      mcpConfigured,
      mcpApplicable: true,
      hooksApplicable,
      ...(mcpRuntimeStatus !== undefined ? { mcpRuntimeStatus } : {}),
    })
  }

  return results
}
