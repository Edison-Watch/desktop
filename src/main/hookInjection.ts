/**
 * Hook Injection Module
 *
 * Injects hooks into MCP client applications to register project contexts
 * with Edison Watch when tool calls are executed.
 *
 * Re-exports all per-client helpers and provides the orchestration functions
 * (injectAllHooks, removeAllHooks, getHookStatus) plus VS Code workspace hooks.
 */

import { promises as fs, existsSync } from 'fs'
import { platform } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { McpClientId } from './mcpDiscovery'
import {
  getVscodeUserMcpPath,
  getCursorConfigPath,
  getWindsurfConfigPath,
  getClaudeCodeHomeJsonPath,
  getClaudeDesktopConfigPath,
  getZedConfigPath,
  getJetBrainsMcpConfigPaths,
  getInstalledJetBrainsIdes,
  MAC_APP_NAMES,
} from './mcpDiscovery'
import { getClaudeCoworkConfigPath } from './mcpDiscoveryCowork'
import { captureError } from './sentry'
import {
  getVsCodeWorkspacePaths,
} from './mcpProjectPaths'
import { ensureHookScript } from './hookInjectionCore'
import {
  isClaudeCodeInstalled, injectClaudeCodeHook, removeClaudeCodeHook,
  isCursorInstalled, injectCursorHook, removeCursorHook,
  isWindsurfInstalled, injectWindsurfHook, removeWindsurfHook,
  getClaudeCodeSettingsPath, getCursorHooksPath, getWindsurfHooksPath,
  getCodexConfigPath, getVsCodeCopilotHooksPath,
  appBundleExists,
  type ClaudeCodeSettings, type CursorHooksFile, type WindsurfHooksFile,
} from './hookInjectionClients'
import {
  isCodexInstalled, injectCodexHook, removeCodexHook,
  isVsCodeCopilotInstalled, injectVsCodeCopilotHook, removeVsCodeCopilotHook,
  type VsCodeCopilotHooksFile,
} from './hookInjectionClientsExtra'

// Re-export all helpers so existing imports of hookInjection still work.
export * from './hookInjectionCore'
export * from './hookInjectionClients'
export * from './hookInjectionClientsExtra'

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
  // JetBrains and Claude Desktop have no scriptable hook system.

  return results
}

// ── VS Code workspace hook ───────────────────────────────────────────────────

const VSCODE_TASK_LABEL = 'Edison Watch Registration'

interface VsCodeTask {
  label: string
  type: string
  command: string
  args?: string[]
  runOptions?: { runOn: string }
  presentation?: { reveal: string; panel: string }
}

interface VsCodeTasksFile {
  version: string
  tasks: VsCodeTask[]
}

/**
 * Inject an Edison Watch registration task into a VS Code workspace's .vscode/tasks.json.
 * The task runs the hook script on folder open, discovering the workspace's MCP config
 * for quarantine monitoring.
 */
export async function injectVsCodeWorkspaceHook(workspacePath: string): Promise<boolean> {
  const vscodePath = join(workspacePath, '.vscode')
  const tasksPath = join(vscodePath, 'tasks.json')
  const scriptPath = await ensureHookScript()

  let tasksFile: VsCodeTasksFile = { version: '2.0.0', tasks: [] }

  if (existsSync(tasksPath)) {
    try {
      const content = await fs.readFile(tasksPath, 'utf-8')
      tasksFile = JSON.parse(content) as VsCodeTasksFile
    } catch {
      tasksFile = { version: '2.0.0', tasks: [] }
    }
  }

  if (!Array.isArray(tasksFile.tasks)) tasksFile.tasks = []

  const alreadyExists = tasksFile.tasks.some((t) => t.label === VSCODE_TASK_LABEL)
  if (alreadyExists) return false

  if (existsSync(tasksPath)) {
    await fs.copyFile(tasksPath, `${tasksPath}.backup.${Date.now()}`)
  }

  await fs.mkdir(vscodePath, { recursive: true })

  tasksFile.tasks.push({
    label: VSCODE_TASK_LABEL,
    type: 'shell',
    command: `"${scriptPath}"`,
    args: ['vscode'],
    runOptions: { runOn: 'folderOpen' },
    presentation: { reveal: 'never', panel: 'shared' },
  })

  await fs.writeFile(tasksPath, JSON.stringify(tasksFile, null, 2), 'utf-8')
  console.log(`[HookInjection] Injected VS Code workspace hook into ${tasksPath}`)
  return true
}

/**
 * Remove the Edison Watch registration task from a VS Code workspace's .vscode/tasks.json.
 */
export async function removeVsCodeWorkspaceHook(workspacePath: string): Promise<boolean> {
  const tasksPath = join(workspacePath, '.vscode', 'tasks.json')
  if (!existsSync(tasksPath)) return false

  let tasksFile: VsCodeTasksFile
  try {
    const content = await fs.readFile(tasksPath, 'utf-8')
    tasksFile = JSON.parse(content) as VsCodeTasksFile
  } catch {
    return false
  }

  const before = tasksFile.tasks?.length ?? 0
  tasksFile.tasks = (tasksFile.tasks ?? []).filter((t) => t.label !== VSCODE_TASK_LABEL)
  if (tasksFile.tasks.length === before) return false

  await fs.writeFile(tasksPath, JSON.stringify(tasksFile, null, 2), 'utf-8')
  console.log(`[HookInjection] Removed VS Code workspace hook from ${tasksPath}`)
  return true
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

    // Copilot agent hooks: shared ~/.copilot (global, not workspace-specific)
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
  /** Number of Edison hooks found in this client's config */
  hookCount: number
  /** Total number of hooks expected for full integration */
  totalHooks: number
  /** Whether the edison-watch MCP entry is configured AND the server is reachable */
  mcpConnected: boolean
  /** Whether the edison-watch MCP entry exists with the correct URL in the client's config */
  mcpConfigured: boolean
  /** Whether MCP config is applicable for this client (false for hooks-only clients like Codex) */
  mcpApplicable: boolean
  /** Whether hooks are applicable for this client (false for hookless clients like Claude Desktop, Zed, JetBrains) */
  hooksApplicable: boolean
  /** Actual runtime MCP connection status from the client CLI (only set for clients that support it) */
  mcpRuntimeStatus?: import('../main/setupConfig').ClaudeCodeMcpStatus
}

/**
 * Check if a client's MCP config contains an edison-watch entry with the expected URL.
 * Returns true if the entry exists and its URL matches the expected MCP URL.
 */
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
    // Strip query string (?client= tag) and trailing slashes for comparison
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    const normalizedExpected = strip(expectedMcpUrl)
    const normalizedActual = strip(entry.url)
    return normalizedActual === normalizedExpected
  } catch {
    return false
  }
}

/**
 * Check if Codex CLI's TOML config contains an edison-watch MCP entry with the expected URL.
 */
async function checkCodexMcpEntry(
  configPath: string,
  expectedMcpUrl: string | null,
): Promise<boolean> {
  if (!expectedMcpUrl) return false
  try {
    if (!existsSync(configPath)) return false
    const content = await fs.readFile(configPath, 'utf-8')
    // Look for [mcp_servers.edison-watch] section and extract its url value
    // Use negative lookahead to match section body (handles URLs with '[' e.g. IPv6)
    const sectionMatch = content.match(/\[mcp_servers\.edison-watch\][^\n]*\n((?:(?!\n\[)[\s\S])*?)(?=\n\[|\s*$)/)
    if (!sectionMatch) return false
    const sectionBody = sectionMatch[1]
    const urlMatch = sectionBody.match(/url\s*=\s*"([^"]*)"/)
    if (!urlMatch) return false
    // Unescape TOML basic string sequences to match the raw URL that was escaped on write
    const unescaped = urlMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    // Strip query string (?client= tag) and trailing slashes for comparison
    const strip = (u: string) => u.replace(/\?.*$/, '').replace(/\/+$/, '')
    const normalizedExpected = strip(expectedMcpUrl)
    const normalizedActual = strip(unescaped)
    return normalizedActual === normalizedExpected
  } catch {
    return false
  }
}

/**
 * Check if Zed's settings.json contains an edison-watch entry under assistant.mcp_servers.
 */
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

export async function getHookStatus(expectedMcpUrl?: string | null, mcpServerAlive = false, claudeCodeMcpStatus?: import('../main/setupConfig').ClaudeCodeMcpStatus): Promise<HookStatusEntry[]> {
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
  // Use runtime status from `claude mcp get` when available; fall back to config+health heuristic
  // "unknown" means the CLI was unavailable or produced unrecognised output - use the fallback
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
  // Windsurf - expects 1 hook
  const windsurfTotal = 1
  const windsurfMcpConfigured = windsurfInstalled
    ? await checkMcpEntry(getWindsurfConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'windsurf', installed: windsurfInstalled, hasHook: windsurfHasHook, hookCount: windsurfHasHook ? 1 : 0, totalHooks: windsurfTotal, mcpConnected: windsurfMcpConfigured && mcpServerAlive, mcpConfigured: windsurfMcpConfigured, mcpApplicable: true, hooksApplicable: true })

  // VS Code - report true if any known workspace has the hook OR Copilot hooks exist
  if (!appBundleExists(['Visual Studio Code.app'])) {
    results.push({ client: 'vscode', installed: false, hasHook: false, hookCount: 0, totalHooks: 1, mcpConnected: false, mcpConfigured: false, mcpApplicable: true, hooksApplicable: true })
  } else {
    let vsHookCount = 0
    let vsTotalHooks = 0
    try {
      const workspacePaths = await getVsCodeWorkspacePaths()
      if (workspacePaths.length > 0) vsTotalHooks++ // workspace task expected only if workspaces exist
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

      // Copilot agent hooks: shared ~/.copilot (global, not workspace-specific)
      const copilotInstalled = isVsCodeCopilotInstalled()
      if (copilotInstalled) {
        vsTotalHooks += 4 // copilot hooks: SessionStart, UserPromptSubmit, PreToolUse, Stop
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

  // Codex CLI - expects 2 hooks: SessionStart + Stop (experimental, no PreToolUse available)
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

  // ── Hookless clients (MCP-only, no hook support) ──────────────────────────
  // These clients have MCP config written during onboarding but no scriptable
  // hook system, so hooksApplicable is false.

  // Claude Desktop
  const claudeDesktopConfigPath = getClaudeDesktopConfigPath()
  const claudeDesktopInstalled = existsSync(dirname(claudeDesktopConfigPath)) && appBundleExists(['Claude.app'])
  const claudeDesktopMcpConfigured = claudeDesktopInstalled
    ? await checkMcpEntry(claudeDesktopConfigPath, 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'claude-desktop', installed: claudeDesktopInstalled, hasHook: true, hookCount: 0, totalHooks: 0, mcpConnected: claudeDesktopMcpConfigured && mcpServerAlive, mcpConfigured: claudeDesktopMcpConfigured, mcpApplicable: true, hooksApplicable: false })

  // Claude Cowork (shares config file with Desktop; detected by vm_bundles/ dir)
  const claudeCoworkConfigPath = getClaudeCoworkConfigPath()
  const coworkVmBundlesDir = join(dirname(claudeCoworkConfigPath), 'vm_bundles')
  const claudeCoworkInstalled = existsSync(coworkVmBundlesDir) && appBundleExists(['Claude.app'])
  const claudeCoworkMcpConfigured = claudeCoworkInstalled
    ? await checkMcpEntry(claudeCoworkConfigPath, 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'claude-cowork', installed: claudeCoworkInstalled, hasHook: true, hookCount: 0, totalHooks: 0, mcpConnected: claudeCoworkMcpConfigured && mcpServerAlive, mcpConfigured: claudeCoworkMcpConfigured, mcpApplicable: true, hooksApplicable: false })

  // Zed (MCP servers live under assistant.mcp_servers in settings.json)
  const zedConfigPath = getZedConfigPath()
  const zedInstalled = existsSync(dirname(zedConfigPath)) && appBundleExists(['Zed.app'])
  const zedMcpConfigured = zedInstalled
    ? await checkZedMcpEntry(zedConfigPath, expectedMcpUrl ?? null)
    : false
  results.push({ client: 'zed', installed: zedInstalled, hasHook: true, hookCount: 0, totalHooks: 0, mcpConnected: zedMcpConfigured && mcpServerAlive, mcpConfigured: zedMcpConfigured, mcpApplicable: true, hooksApplicable: false })

  // JetBrains IDEs (IntelliJ, PyCharm, WebStorm) - scan for version-specific config dirs
  // Installation is detected by IDE preferences folder existence + app bundle check;
  // MCP config is detected separately by servers.json content.
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
    results.push({ client: jbClient, installed: jbInstalled, hasHook: true, hookCount: 0, totalHooks: 0, mcpConnected: jbMcpConfigured && mcpServerAlive, mcpConfigured: jbMcpConfigured, mcpApplicable: true, hooksApplicable: false })
  }

  return results
}
