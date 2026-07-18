/**
 * VS Code hook injection - Copilot agent hooks + workspace task hooks.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { dirname } from 'path'
import { ensureHookScript, ensureSessionHookScript, ensureSessionStartHookScript, ensureSessionEndHookScript } from '../../runtime/hookInjectionCore'
import type { ClaudeCodeHook } from '../claude-code/hooks'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getVsCodeCopilotHooksPath(): string {
  return join(homedir(), '.copilot', 'hooks', 'edison-watch.json')
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface VsCodeCopilotHooksFile {
  hooks: {
    SessionStart?: ClaudeCodeHook[]
    UserPromptSubmit?: ClaudeCodeHook[]
    PreToolUse?: ClaudeCodeHook[]
    Stop?: ClaudeCodeHook[]
    [key: string]: ClaudeCodeHook[] | undefined
  }
}

// ── Detection ───────────────────────────────────────────────────────────────

export function isVsCodeCopilotInstalled(): boolean {
  return existsSync(join(homedir(), '.copilot'))
}

// ── Copilot Agent Hooks ─────────────────────────────────────────────────────

/**
 * Inject Edison Watch hooks into VSCode Copilot's ~/.copilot/hooks/edison-watch.json.
 * Creates SessionStart (session start), UserPromptSubmit (project registration),
 * PreToolUse (session ID injection), and Stop (session end) hooks.
 */
export async function injectVsCodeCopilotHook(): Promise<boolean> {
  const hooksPath = getVsCodeCopilotHooksPath()

  // Always ensure scripts exist (guards against manual deletion of ~/.edison-watch/ scripts)
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()
  const sessionStartScriptPath = await ensureSessionStartHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  // If the file already exists, it's ours - check if it's current
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      const existing = JSON.parse(content) as VsCodeCopilotHooksFile
      const hasSessionStart = existing.hooks?.SessionStart?.some((h) => h.command?.includes('edison-session-start'))
      const hasUserPrompt = existing.hooks?.UserPromptSubmit?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
      const hasPreToolUse = existing.hooks?.PreToolUse?.some((h) => h.command?.includes('edison-session-hook') && !h.command?.includes('edison-session-end'))
      const hasStop = existing.hooks?.Stop?.some((h) => h.command?.includes('edison-session-end'))
      if (hasSessionStart && hasUserPrompt && hasPreToolUse && hasStop) {
        console.log('[HookInjection] Edison hooks already exist in VSCode Copilot hooks')
        return false
      }
    } catch { /* corrupt file, overwrite */ }
  }

  const hooksDir = dirname(hooksPath)
  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true })
  }

  const hooksFile: VsCodeCopilotHooksFile = {
    hooks: {
      SessionStart: [{ type: 'command', command: `"${sessionStartScriptPath}"` }],
      UserPromptSubmit: [{ type: 'command', command: `"${scriptPath}" vscode` }],
      PreToolUse: [{ type: 'command', command: `"${sessionScriptPath}"` }],
      Stop: [{ type: 'command', command: `"${sessionEndScriptPath}"` }]
    }
  }

  if (existsSync(hooksPath)) {
    await fs.copyFile(hooksPath, `${hooksPath}.backup.${Date.now()}`)
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Injected Edison hooks into VSCode Copilot hooks')
  return true
}

/**
 * Remove Edison Watch hooks from VSCode Copilot.
 * Deletes the entire edison-watch.json file since it's Edison-owned.
 */
export async function removeVsCodeCopilotHook(): Promise<boolean> {
  const hooksPath = getVsCodeCopilotHooksPath()
  if (!existsSync(hooksPath)) return false

  await fs.unlink(hooksPath)
  console.log('[HookInjection] Removed Edison hooks from VSCode Copilot')
  return true
}

// ── VS Code Workspace Task (status detection only) ──────────────────────────
// The label + task shape are retained so getStatus() can detect a previously
// injected workspace task. Installing/removing the task is owned by the detector
// daemon; the client no longer writes .vscode/tasks.json.

export const VSCODE_TASK_LABEL = 'Edison Watch Registration'

interface VsCodeTask {
  label: string
  type: string
  command: string
  args?: string[]
  runOptions?: { runOn: string }
  presentation?: { reveal: string; panel: string }
}

export interface VsCodeTasksFile {
  version: string
  tasks: VsCodeTask[]
}
