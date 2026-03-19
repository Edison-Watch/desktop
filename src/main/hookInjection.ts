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
  isGeminiInstalled, injectGeminiHook, removeGeminiHook,
  isCodexInstalled, injectCodexHook, removeCodexHook,
  getClaudeCodeSettingsPath, getCursorHooksPath, getWindsurfHooksPath,
  getGeminiSettingsPath, getCodexConfigPath,
  type ClaudeCodeSettings, type CursorHooksFile, type WindsurfHooksFile,
} from './hookInjectionClients'

// Re-export all helpers so existing imports of hookInjection still work.
export * from './hookInjectionCore'
export * from './hookInjectionClients'

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
      if (workspacePaths.length > 0) {
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

  // VS Code — remove workspace task from each known workspace
  for (const clientId of ['vscode', 'vscode-insiders'] as const) {
    try {
      const workspacePaths =
        clientId === 'vscode'
          ? await getVsCodeWorkspacePaths()
          : await getVsCodeInsidersWorkspacePaths()
      for (const wsPath of workspacePaths) {
        await removeVsCodeWorkspaceHook(wsPath)
      }
      if (workspacePaths.length > 0) {
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
export async function getHookStatus(): Promise<
  Array<{ client: McpClientId; installed: boolean; hasHook: boolean }>
> {
  const results: Array<{ client: McpClientId; installed: boolean; hasHook: boolean }> = []

  // Claude Code
  const claudeInstalled = isClaudeCodeInstalled()
  let claudeHasHook = false
  if (claudeInstalled) {
    try {
      const settingsPath = getClaudeCodeSettingsPath()
      if (existsSync(settingsPath)) {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const settings = parseJsonc(content) as ClaudeCodeSettings
        const hooks = settings.hooks?.UserPromptSubmit ?? []
        claudeHasHook = hooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-hook'))
        )
      }
    } catch { /* ignore */ }
  }
  results.push({ client: 'claude-code', installed: claudeInstalled, hasHook: claudeHasHook })

  // Cursor
  const cursorInstalled = isCursorInstalled()
  let cursorHasHook = false
  if (cursorInstalled) {
    try {
      const hooksPath = getCursorHooksPath()
      if (existsSync(hooksPath)) {
        const content = await fs.readFile(hooksPath, 'utf-8')
        const hooksFile = JSON.parse(content) as CursorHooksFile
        const sessionStart = hooksFile.hooks?.sessionStart ?? []
        const preToolUse = hooksFile.hooks?.preToolUse ?? []
        cursorHasHook =
          sessionStart.some((h) => h.command?.includes('edison-hook')) ||
          preToolUse.some((h) => h.command?.includes('edison-session-hook'))
      }
    } catch { /* ignore */ }
  }
  results.push({ client: 'cursor', installed: cursorInstalled, hasHook: cursorHasHook })

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
  results.push({ client: 'windsurf', installed: windsurfInstalled, hasHook: windsurfHasHook })

  // VS Code — report true if any known workspace has the hook
  for (const clientId of ['vscode', 'vscode-insiders'] as const) {
    let hasHook = false
    try {
      const workspacePaths =
        clientId === 'vscode'
          ? await getVsCodeWorkspacePaths()
          : await getVsCodeInsidersWorkspacePaths()
      for (const wsPath of workspacePaths) {
        const tasksPath = join(wsPath, '.vscode', 'tasks.json')
        if (!existsSync(tasksPath)) continue
        try {
          const content = await fs.readFile(tasksPath, 'utf-8')
          const tasksFile = JSON.parse(content) as VsCodeTasksFile
          if (tasksFile.tasks?.some((t) => t.label === VSCODE_TASK_LABEL)) {
            hasHook = true
            break
          }
        } catch { /* unreadable; skip */ }
      }
      const installed = workspacePaths.length > 0
      results.push({ client: clientId, installed, hasHook })
    } catch {
      results.push({ client: clientId, installed: false, hasHook: false })
    }
  }

  // Gemini CLI
  const geminiInstalled = isGeminiInstalled()
  let geminiHasHook = false
  if (geminiInstalled) {
    try {
      const settingsPath = getGeminiSettingsPath()
      if (existsSync(settingsPath)) {
        const content = await fs.readFile(settingsPath, 'utf-8')
        const settings = parseJsonc(content) as ClaudeCodeSettings
        const hooks = settings.hooks?.SessionStart ?? []
        geminiHasHook = hooks.some((group) =>
          group.hooks?.some((h) => h.command?.includes('edison-hook'))
        )
      }
    } catch { /* ignore */ }
  }
  results.push({ client: 'antigravity', installed: geminiInstalled, hasHook: geminiHasHook })

  // Codex CLI
  const codexInstalled = isCodexInstalled()
  let codexHasHook = false
  if (codexInstalled) {
    try {
      const configPath = getCodexConfigPath()
      if (existsSync(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8')
        codexHasHook = content.includes('edison-hook')
      }
    } catch { /* ignore */ }
  }
  results.push({ client: 'codex', installed: codexInstalled, hasHook: codexHasHook })

  return results
}
