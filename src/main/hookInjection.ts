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
import { join } from 'path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { McpClientId } from './mcpDiscovery'
import {
  getVscodeUserMcpPath,
  getVscodeInsidersUserMcpPath,
  getCursorConfigPath,
  getWindsurfConfigPath,
  getClaudeCodeHomeJsonPath,
  getAntigravityConfigPath,
} from './mcpDiscovery'
import { captureError } from './sentry'
import {
  getVsCodeWorkspacePaths,
  getVsCodeInsidersWorkspacePaths
} from './mcpProjectPaths'
import { ensureHookScript } from './hookInjectionCore'
import {
  isClaudeCodeInstalled, injectClaudeCodeHook, removeClaudeCodeHook,
  isCursorInstalled, injectCursorHook, removeCursorHook,
  isWindsurfInstalled, injectWindsurfHook, removeWindsurfHook,
  getClaudeCodeSettingsPath, getCursorHooksPath, getWindsurfHooksPath,
  getGeminiSettingsPath, getCodexConfigPath, getVsCodeCopilotHooksPath,
  appBundleExists,
  type ClaudeCodeSettings, type CursorHooksFile, type WindsurfHooksFile,
} from './hookInjectionClients'
import {
  isGeminiInstalled, injectGeminiHook, removeGeminiHook,
  isCodexInstalled, injectCodexHook, removeCodexHook,
  isVsCodeCopilotInstalled, injectVsCodeCopilotHook, removeVsCodeCopilotHook,
  type VsCodeCopilotHooksFile, type GeminiSettings,
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

  // VS Code — inject workspace task into each known workspace
  let copilotHandled = false
  for (const clientId of ['vscode', 'vscode-insiders'] as const) {
    try {
      const workspacePaths =
        clientId === 'vscode'
          ? await getVsCodeWorkspacePaths()
          : await getVsCodeInsidersWorkspacePaths()
      let anyInjected = false
      let allExisted = true
      for (const wsPath of workspacePaths) {
        const injected = await injectVsCodeWorkspaceHook(wsPath)
        if (injected) anyInjected = true
        if (injected) allExisted = false
      }

      // Copilot agent hooks: shared ~/.copilot, associate with variant that has workspaces
      // (or last variant as fallback for Insiders-only users)
      const isLastVariant = clientId === 'vscode-insiders'
      const copilotInstalled = !copilotHandled && isVsCodeCopilotInstalled() && (workspacePaths.length > 0 || isLastVariant)
      if (copilotInstalled) {
        copilotHandled = true
        const copilotInjected = await injectVsCodeCopilotHook()
        if (copilotInjected) anyInjected = true
        if (copilotInjected) allExisted = false
      }

      if (workspacePaths.length > 0 || copilotInstalled) {
        results.push({ client: clientId, installed: anyInjected, alreadyExists: allExisted })
      }
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: clientId, operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: clientId, installed: false, alreadyExists: false, error: String(err) })
    }
  }

  // Gemini CLI
  if (isGeminiInstalled()) {
    try {
      const injected = await injectGeminiHook()
      results.push({ client: 'antigravity', installed: injected, alreadyExists: !injected })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'antigravity', operation: 'injectAllHooks', platform: platform()
      })
      results.push({ client: 'antigravity', installed: false, alreadyExists: false, error: String(err) })
    }
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

  // VS Code — remove workspace task + Copilot agent hooks
  let copilotRemoveHandled = false
  for (const clientId of ['vscode', 'vscode-insiders'] as const) {
    try {
      const workspacePaths =
        clientId === 'vscode'
          ? await getVsCodeWorkspacePaths()
          : await getVsCodeInsidersWorkspacePaths()
      for (const wsPath of workspacePaths) {
        await removeVsCodeWorkspaceHook(wsPath)
      }

      // Copilot agent hooks: shared ~/.copilot, associate with variant that has workspaces
      const isLastVariant = clientId === 'vscode-insiders'
      const copilotInstalled = !copilotRemoveHandled && isVsCodeCopilotInstalled() && (workspacePaths.length > 0 || isLastVariant)
      if (copilotInstalled) {
        copilotRemoveHandled = true
        await removeVsCodeCopilotHook()
      }

      if (workspacePaths.length > 0 || copilotInstalled) {
        results.push({ client: clientId, installed: false, alreadyExists: false })
      }
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: clientId, operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: clientId, installed: false, alreadyExists: false, error: String(err) })
    }
  }

  if (isGeminiInstalled()) {
    try {
      const removed = await removeGeminiHook()
      results.push({ client: 'antigravity', installed: false, alreadyExists: !removed })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'antigravity', operation: 'removeAllHooks', platform: platform()
      })
      results.push({ client: 'antigravity', installed: false, alreadyExists: false, error: String(err) })
    }
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
  /** Whether the edison-watch MCP server entry is configured with the correct URL */
  mcpConnected: boolean
  /** Whether MCP config is applicable for this client (false for hooks-only clients like Codex) */
  mcpApplicable: boolean
}

/**
 * Check if a client's MCP config contains an edison-watch entry with the expected URL.
 * Returns true if the entry exists and its URL starts with the expected MCP base URL.
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
    // Normalize trailing slashes for comparison
    const normalizedExpected = expectedMcpUrl.replace(/\/+$/, '')
    const normalizedActual = entry.url.replace(/\/+$/, '')
    return normalizedActual === normalizedExpected
  } catch {
    return false
  }
}

export async function getHookStatus(expectedMcpUrl?: string | null): Promise<HookStatusEntry[]> {
  const results: HookStatusEntry[] = []

  // Claude Code — expects 4 hooks
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
  const claudeMcpConnected = claudeInstalled
    ? await checkMcpEntry(getClaudeCodeHomeJsonPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'claude-code', installed: claudeInstalled, hasHook: claudeHookCount === claudeTotalHooks, hookCount: claudeHookCount, totalHooks: claudeTotalHooks, mcpConnected: claudeMcpConnected, mcpApplicable: true })

  // Cursor — expects 3 hooks
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
  const cursorMcpConnected = cursorInstalled
    ? await checkMcpEntry(getCursorConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'cursor', installed: cursorInstalled, hasHook: cursorHookCount === cursorTotalHooks, hookCount: cursorHookCount, totalHooks: cursorTotalHooks, mcpConnected: cursorMcpConnected, mcpApplicable: true })

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
  // Windsurf — expects 1 hook
  const windsurfTotal = 1
  const windsurfMcpConnected = windsurfInstalled
    ? await checkMcpEntry(getWindsurfConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'windsurf', installed: windsurfInstalled, hasHook: windsurfHasHook, hookCount: windsurfHasHook ? 1 : 0, totalHooks: windsurfTotal, mcpConnected: windsurfMcpConnected, mcpApplicable: true })

  // VS Code — report true if any known workspace has the hook OR Copilot hooks exist
  const vsAppNames: Record<string, string[]> = {
    vscode: ['Visual Studio Code.app'],
    'vscode-insiders': ['Visual Studio Code - Insiders.app'],
  }
  let copilotStatusHandled = false
  for (const clientId of ['vscode', 'vscode-insiders'] as const) {
    if (!appBundleExists(vsAppNames[clientId])) {
      results.push({ client: clientId, installed: false, hasHook: false, hookCount: 0, totalHooks: 1, mcpConnected: false, mcpApplicable: true })
      continue
    }
    let vsHookCount = 0
    let vsTotalHooks = 0
    try {
      const workspacePaths =
        clientId === 'vscode'
          ? await getVsCodeWorkspacePaths()
          : await getVsCodeInsidersWorkspacePaths()
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

      // Copilot agent hooks: shared ~/.copilot, associate with variant that has workspaces
      const isLastVariant = clientId === 'vscode-insiders'
      const copilotInstalled = !copilotStatusHandled && isVsCodeCopilotInstalled() && (workspacePaths.length > 0 || isLastVariant)
      if (copilotInstalled) {
        copilotStatusHandled = true
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
      const vsMcpPath = clientId === 'vscode' ? getVscodeUserMcpPath() : getVscodeInsidersUserMcpPath()
      const vsMcpConnected = installed
        ? await checkMcpEntry(vsMcpPath, 'servers', expectedMcpUrl ?? null)
        : false
      results.push({ client: clientId, installed, hasHook: vsTotalHooks > 0 && vsHookCount === vsTotalHooks, hookCount: vsHookCount, totalHooks: vsTotalHooks, mcpConnected: vsMcpConnected, mcpApplicable: true })
    } catch {
      results.push({ client: clientId, installed: false, hasHook: false, hookCount: 0, totalHooks: 1, mcpConnected: false, mcpApplicable: true })
    }
  }

  // Gemini CLI — expects 3 hooks: SessionStart, BeforeTool, SessionEnd
  const geminiInstalled = isGeminiInstalled()
  let geminiHookCount = 0
  const geminiTotalHooks = 3
  if (geminiInstalled) {
    try {
      const settingsPath = getGeminiSettingsPath()
      if (existsSync(settingsPath)) {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const settings = parseJsonc(content) as GeminiSettings
        const startHooks = settings.hooks?.SessionStart ?? []
        const toolHooks = settings.hooks?.BeforeTool ?? []
        const endHooks = settings.hooks?.SessionEnd ?? []
        if (startHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
        )) geminiHookCount++
        if (toolHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
        )) geminiHookCount++
        if (endHooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-session-end'))
        )) geminiHookCount++
      }
    } catch { /* ignore */ }
  }
  const geminiMcpConnected = geminiInstalled
    ? await checkMcpEntry(getAntigravityConfigPath(), 'mcpServers', expectedMcpUrl ?? null)
    : false
  results.push({ client: 'antigravity', installed: geminiInstalled, hasHook: geminiHookCount === geminiTotalHooks, hookCount: geminiHookCount, totalHooks: geminiTotalHooks, mcpConnected: geminiMcpConnected, mcpApplicable: true })

  // Codex CLI — expects 2 hooks: SessionStart + Stop (experimental, no PreToolUse available)
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
  // Codex has no standard MCP config file — MCP check not applicable
  results.push({ client: 'codex', installed: codexInstalled, hasHook: codexHookCount === codexTotalHooks, hookCount: codexHookCount, totalHooks: codexTotalHooks, mcpConnected: false, mcpApplicable: false })

  return results
}
