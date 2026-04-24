/**
 * Hook Injection Module - orchestration layer.
 *
 * Injects hooks into MCP client applications to register project contexts
 * with Edison Watch when tool calls are executed.
 *
 * Re-exports all per-client helpers so existing consumers work unchanged.
 */

import { promises as fs, existsSync } from 'fs'
import { platform } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { McpClientId } from '../discovery/types'
import {
  getVscodeUserMcpPath,
} from '../clients/vscode/discovery'
import {
  getCursorConfigPath,
} from '../clients/cursor/discovery'
import {
  getWindsurfConfigPath,
} from '../clients/windsurf/discovery'
import {
  getClaudeCodeHomeJsonPath,
} from '../clients/claude-code/discovery'
import {
  getZedConfigPath,
} from '../clients/zed/discovery'
import {
  getJetBrainsMcpConfigPaths,
  getInstalledJetBrainsIdes,
} from '../clients/jetbrains/discovery'
import { MAC_APP_NAMES } from '../discovery/mcpDiscovery'
import { captureError } from '../infra/sentry'
import {
  getVsCodeWorkspacePaths,
} from './mcpProjectPaths'
import {
  isClaudeCodeInstalled, injectClaudeCodeHook, removeClaudeCodeHook,
  getClaudeCodeSettingsPath,
  type ClaudeCodeSettings,
} from '../clients/claude-code/hooks'
import {
  isCursorInstalled, injectCursorHook, removeCursorHook,
  getCursorHooksPath,
  type CursorHooksFile,
} from '../clients/cursor/hooks'
import {
  isWindsurfInstalled, injectWindsurfHook, removeWindsurfHook,
  getWindsurfHooksPath,
  type WindsurfHooksFile,
} from '../clients/windsurf/hooks'
import {
  isCodexInstalled, injectCodexHook, removeCodexHook,
  getCodexConfigPath,
} from '../clients/codex/hooks'
import {
  isVsCodeCopilotInstalled, injectVsCodeCopilotHook, removeVsCodeCopilotHook,
  getVsCodeCopilotHooksPath,
  type VsCodeCopilotHooksFile,
  injectVsCodeWorkspaceHook, removeVsCodeWorkspaceHook,
} from '../clients/vscode/hooks'
import { appBundleExists } from '../clients/shared'
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

/**
 * Inject hooks into all supported MCP clients.
 */
export async function injectAllHooks(): Promise<HookInjectionResult[]> {
  const results: HookInjectionResult[] = []

  // Claude Code
  if (isClaudeCodeInstalled()) {
    try {
      const injected = await injectClaudeCodeHook()
      results.push({ client: 'claude-code', installed: injected, alreadyExists: !injected })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'claude-code', operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: 'claude-code', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // Cursor
  if (isCursorInstalled()) {
    try {
      const injected = await injectCursorHook()
      results.push({ client: 'cursor', installed: injected, alreadyExists: !injected })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'cursor', operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: 'cursor', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // Windsurf
  if (isWindsurfInstalled()) {
    try {
      const injected = await injectWindsurfHook()
      results.push({ client: 'windsurf', installed: injected, alreadyExists: !injected })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'windsurf', operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: 'windsurf', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // VS Code - inject workspace task into each known workspace
  try {
    const workspacePaths = await getVsCodeWorkspacePaths()
    let anyInjected = false
    let allExisted = true
    for (const wsPath of workspacePaths) {
      const injected = await injectVsCodeWorkspaceHook(wsPath)
      if (injected) anyInjected = true
      if (injected) allExisted = false
    }

    // Copilot agent hooks: shared ~/.copilot (global, not workspace-specific)
    const copilotInstalled = isVsCodeCopilotInstalled()
    if (copilotInstalled) {
      const copilotInjected = await injectVsCodeCopilotHook()
      if (copilotInjected) anyInjected = true
      if (copilotInjected) allExisted = false
    }

    if (workspacePaths.length > 0 || copilotInstalled) {
      results.push({ client: 'vscode', installed: anyInjected, alreadyExists: allExisted })
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: 'vscode', operation: 'injectAllHooks', platform: platform()
    })
    results.push({ client: 'vscode', installed: false, alreadyExists: false, error: String(err) })
  }

  // Codex CLI
  if (isCodexInstalled()) {
    try {
      const injected = await injectCodexHook()
      results.push({ client: 'codex', installed: injected, alreadyExists: !injected })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'codex', operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: 'codex', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // Note: Zed has no workspace-open hook yet (feature request open upstream).
  // JetBrains IDEs have no scriptable hook system.

  return results
}

/**
 * Remove hooks from all MCP clients.
 */
export async function removeAllHooks(): Promise<HookInjectionResult[]> {
  const results: HookInjectionResult[] = []

  if (isClaudeCodeInstalled()) {
    try {
      const removed = await removeClaudeCodeHook()
      results.push({ client: 'claude-code', installed: false, alreadyExists: !removed })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'claude-code', operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: 'claude-code', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  if (isCursorInstalled()) {
    try {
      const removed = await removeCursorHook()
      results.push({ client: 'cursor', installed: false, alreadyExists: !removed })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'cursor', operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: 'cursor', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  if (isWindsurfInstalled()) {
    try {
      const removed = await removeWindsurfHook()
      results.push({ client: 'windsurf', installed: false, alreadyExists: !removed })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'windsurf', operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: 'windsurf', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // VS Code - remove workspace task + Copilot agent hooks
  try {
    const workspacePaths = await getVsCodeWorkspacePaths()
    for (const wsPath of workspacePaths) {
      await removeVsCodeWorkspaceHook(wsPath)
    }

    const copilotInstalled = isVsCodeCopilotInstalled()
    if (copilotInstalled) {
      await removeVsCodeCopilotHook()
    }

    if (workspacePaths.length > 0 || copilotInstalled) {
      results.push({ client: 'vscode', installed: false, alreadyExists: false })
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: 'vscode', operation: 'removeAllHooks', platform: platform()
    })
    results.push({ client: 'vscode', installed: false, alreadyExists: false, error: String(err) })
  }

  if (isCodexInstalled()) {
    try {
      const removed = await removeCodexHook()
      results.push({ client: 'codex', installed: false, alreadyExists: !removed })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'codex', operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: 'codex', installed: false, alreadyExists: false, error: String(err) })
    }
  }

  return results
}

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
    const servers = json[serversKey] as Record<string, { url?: string }> | undefined
    const entry = servers?.['edison-watch']
    if (!entry?.url) return false
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    return strip(entry.url) === strip(expectedMcpUrl)
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

const VSCODE_TASK_LABEL = 'Edison Watch Registration'

interface VsCodeTasksFile {
  version: string
  tasks: Array<{ label: string; [k: string]: unknown }>
}

export async function getHookStatus(expectedMcpUrl?: string | null, mcpServerAlive = false, claudeCodeMcpStatus?: ClaudeCodeMcpStatus): Promise<HookStatusEntry[]> {
  const results: HookStatusEntry[] = []

  // Claude Code - expects 4 hooks
  const claudeInstalled = isClaudeCodeInstalled()
  let claudeHookCount = 0
  const claudeTotalHooks = 4
  if (claudeInstalled) {
    try {
      const settingsPath = getClaudeCodeSettingsPath()
      if (existsSync(settingsPath)) {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const settings = parseJsonc(content) as ClaudeCodeSettings
        const promptHooks = settings.hooks?.UserPromptSubmit ?? []
        const toolHooks = settings.hooks?.PreToolUse ?? []
        const startHooks = settings.hooks?.SessionStart ?? []
        const endHooks = settings.hooks?.SessionEnd ?? []
        if (promptHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
        )) claudeHookCount++
        if (toolHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
        )) claudeHookCount++
        if (startHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-start'))
        )) claudeHookCount++
        if (endHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-end'))
        )) claudeHookCount++
      }
    } catch { /* ignore */ }
  }
  const claudeMcpConfigured = claudeInstalled
    ? await checkMcpEntry(getClaudeCodeHomeJsonPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  const claudeMcpConnected = claudeCodeMcpStatus && claudeCodeMcpStatus !== 'unknown'
    ? claudeCodeMcpStatus === 'connected'
    : claudeMcpConfigured && mcpServerAlive
  results.push({ client: 'claude-code', installed: claudeInstalled, hasHook: claudeHookCount === claudeTotalHooks, hookCount: claudeHookCount, totalHooks: claudeTotalHooks, mcpConnected: claudeMcpConnected, mcpConfigured: claudeMcpConfigured, mcpApplicable: true, hooksApplicable: true, mcpRuntimeStatus: claudeCodeMcpStatus })

  // Cursor - expects 3 hooks
  const cursorInstalled = isCursorInstalled()
  let cursorHookCount = 0
  const cursorTotalHooks = 3
  if (cursorInstalled) {
    try {
      const hooksPath = getCursorHooksPath()
      if (existsSync(hooksPath)) {
        const content = await fs.readFile(hooksPath, 'utf-8')
        const hooksFile = JSON.parse(content) as CursorHooksFile
        const sessionStart = hooksFile.hooks?.sessionStart ?? []
        const beforeMCP = hooksFile.hooks?.beforeMCPExecution ?? []
        const preToolUse = hooksFile.hooks?.preToolUse ?? []
        const sessionEnd = hooksFile.hooks?.sessionEnd ?? []
        if (sessionStart.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))) cursorHookCount++
        if (beforeMCP.some((h) => h.command?.includes('edison-session-hook')) ||
            preToolUse.some((h) => h.command?.includes('edison-session-hook'))) cursorHookCount++
        if (sessionEnd.some((h) => h.command?.includes('edison-session-end'))) cursorHookCount++
      }
    } catch { /* ignore */ }
  }
  const cursorMcpConfigured = cursorInstalled
    ? await checkMcpEntry(getCursorConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'cursor', installed: cursorInstalled, hasHook: cursorHookCount === cursorTotalHooks, hookCount: cursorHookCount, totalHooks: cursorTotalHooks, mcpConnected: cursorMcpConfigured && mcpServerAlive, mcpConfigured: cursorMcpConfigured, mcpApplicable: true, hooksApplicable: true })

  // Windsurf
  const windsurfInstalled = isWindsurfInstalled()
  let windsurfHasHook = false
  if (windsurfInstalled) {
    try {
      const hooksPath = getWindsurfHooksPath()
      if (existsSync(hooksPath)) {
        const content = await fs.readFile(hooksPath, 'utf-8')
        const hooksFile = JSON.parse(content) as WindsurfHooksFile
        const hooks = hooksFile.hooks?.pre_user_prompt ?? []
        windsurfHasHook = hooks.some((h) => h.command?.includes('edison-hook'))
      }
    } catch { /* ignore */ }
  }
  const windsurfTotal = 1
  const windsurfMcpConfigured = windsurfInstalled
    ? await checkMcpEntry(getWindsurfConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'windsurf', installed: windsurfInstalled, hasHook: windsurfHasHook, hookCount: windsurfHasHook ? 1 : 0, totalHooks: windsurfTotal, mcpConnected: windsurfMcpConfigured && mcpServerAlive, mcpConfigured: windsurfMcpConfigured, mcpApplicable: true, hooksApplicable: true })

  // VS Code
  if (!appBundleExists(['Visual Studio Code.app'])) {
    results.push({ client: 'vscode', installed: false, hasHook: false, hookCount: 0, totalHooks: 1, mcpConnected: false, mcpConfigured: false, mcpApplicable: true, hooksApplicable: true })
  } else {
    let vsHookCount = 0
    let vsTotalHooks = 0
    try {
      const workspacePaths = await getVsCodeWorkspacePaths()
      if (workspacePaths.length > 0) vsTotalHooks++
      for (const wsPath of workspacePaths) {
        const tasksPath = join(wsPath, '.vscode', 'tasks.json')
        if (!existsSync(tasksPath)) continue
        try {
          const content = await fs.readFile(tasksPath, 'utf-8')
          const tasksFile = JSON.parse(content) as VsCodeTasksFile
          if (tasksFile.tasks?.some((t) => t.label === VSCODE_TASK_LABEL)) {
            vsHookCount++
            break
          }
        } catch { /* unreadable; skip */ }
      }

      const copilotInstalled = isVsCodeCopilotInstalled()
      if (copilotInstalled) {
        vsTotalHooks += 4
        try {
          const copilotHooksPath = getVsCodeCopilotHooksPath()
          if (existsSync(copilotHooksPath)) {
            const content = await fs.readFile(copilotHooksPath, 'utf-8')
            const hooksFile = JSON.parse(content) as VsCodeCopilotHooksFile
            if (hooksFile.hooks?.SessionStart?.some((h) => h.command?.includes('edison-session-start'))) vsHookCount++
            if (hooksFile.hooks?.UserPromptSubmit?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))) vsHookCount++
            if (hooksFile.hooks?.PreToolUse?.some((h) => h.command?.includes('edison-session-hook') && !h.command?.includes('edison-session-end'))) vsHookCount++
            if (hooksFile.hooks?.Stop?.some((h) => h.command?.includes('edison-session-end'))) vsHookCount++
          }
        } catch { /* ignore */ }
      }

      const installed = workspacePaths.length > 0 || copilotInstalled
      const vsMcpConfigured = installed
        ? await checkMcpEntry(getVscodeUserMcpPath(), 'servers', expectedMcpUrl ?? null)
        : false
      results.push({ client: 'vscode', installed, hasHook: vsTotalHooks > 0 && vsHookCount === vsTotalHooks, hookCount: vsHookCount, totalHooks: vsTotalHooks, mcpConnected: vsMcpConfigured && mcpServerAlive, mcpConfigured: vsMcpConfigured, mcpApplicable: true, hooksApplicable: true })
    } catch {
      results.push({ client: 'vscode', installed: false, hasHook: false, hookCount: 0, totalHooks: 1, mcpConnected: false, mcpConfigured: false, mcpApplicable: true, hooksApplicable: true })
    }
  }

  // Codex CLI
  const codexInstalled = isCodexInstalled()
  let codexHookCount = 0
  const codexTotalHooks = 2
  if (codexInstalled) {
    try {
      const configPath = getCodexConfigPath()
      if (existsSync(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8')
        if (content.includes('edison-hook')) codexHookCount++
        if (content.includes('edison-session-end')) codexHookCount++
      }
    } catch { /* ignore */ }
  }
  const codexMcpConfigured = codexInstalled
    ? await checkCodexMcpEntry(getCodexConfigPath(), expectedMcpUrl ?? null)
    : false
  results.push({ client: 'codex', installed: codexInstalled, hasHook: codexHookCount === codexTotalHooks, hookCount: codexHookCount, totalHooks: codexTotalHooks, mcpConnected: codexMcpConfigured && mcpServerAlive, mcpConfigured: codexMcpConfigured, mcpApplicable: true, hooksApplicable: true })

  // ── Hookless clients ──────────────────────────────────────────────────────

  // Zed
  const zedConfigPath = getZedConfigPath()
  const zedInstalled = existsSync(dirname(zedConfigPath)) && appBundleExists(['Zed.app'])
  const zedMcpConfigured = zedInstalled
    ? await checkZedMcpEntry(zedConfigPath, expectedMcpUrl ?? null)
    : false
  results.push({ client: 'zed', installed: zedInstalled, hasHook: false, hookCount: 0, totalHooks: 0, mcpConnected: zedMcpConfigured && mcpServerAlive, mcpConfigured: zedMcpConfigured, mcpApplicable: true, hooksApplicable: false })

  // JetBrains IDEs
  const installedJetBrains = await getInstalledJetBrainsIdes()
  const jetbrainsEntries = await getJetBrainsMcpConfigPaths()
  for (const jbClient of ['intellij', 'pycharm', 'webstorm'] as const) {
    const jbInstalled = installedJetBrains.has(jbClient) && appBundleExists(MAC_APP_NAMES[jbClient] ?? [])
    let jbMcpConfigured = false
    if (jbInstalled) {
      const paths = jetbrainsEntries.filter((e) => e.client === jbClient)
      for (const { path } of paths) {
        if (await checkMcpEntry(path, 'mcpServers', expectedMcpUrl ?? null)) {
          jbMcpConfigured = true
          break
        }
      }
    }
    results.push({ client: jbClient, installed: jbInstalled, hasHook: false, hookCount: 0, totalHooks: 0, mcpConnected: jbMcpConfigured && mcpServerAlive, mcpConfigured: jbMcpConfigured, mcpApplicable: true, hooksApplicable: false })
  }

  return results
}
