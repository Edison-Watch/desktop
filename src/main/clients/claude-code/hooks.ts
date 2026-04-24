/**
 * Claude Code hook injection - inject/remove Edison Watch hooks from Claude Code settings.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import { ensureHookScript, ensureSessionHookScript, ensureSessionEndHookScript, ensureSessionStartHookScript } from '../../runtime/hookInjectionCore'
import { cliBinaryExists } from '../shared'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getClaudeCodeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaudeCodeHook {
  type: 'command'
  command: string
}

export interface ClaudeCodeHookGroup {
  matcher: string
  hooks: ClaudeCodeHook[]
}

export interface ClaudeCodeHooks {
  UserPromptSubmit?: ClaudeCodeHookGroup[]
  PreToolUse?: ClaudeCodeHookGroup[]
  PostToolUse?: ClaudeCodeHookGroup[]
  SessionStart?: ClaudeCodeHookGroup[]
  SessionEnd?: ClaudeCodeHookGroup[]
  [key: string]: ClaudeCodeHookGroup[] | undefined
}

export interface ClaudeCodeSettings {
  hooks?: ClaudeCodeHooks
  [key: string]: unknown
}

// ── Detection ───────────────────────────────────────────────────────────────

export function isClaudeCodeInstalled(): boolean {
  return existsSync(join(homedir(), '.claude')) && cliBinaryExists('claude')
}

// ── Inject ──────────────────────────────────────────────────────────────────

/**
 * Inject Edison Watch hook into Claude Code settings.
 * Uses JSONC parser to preserve comments and formatting.
 */
export async function injectClaudeCodeHook(): Promise<boolean> {
  const settingsPath = getClaudeCodeSettingsPath()
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()
  const sessionStartScriptPath = await ensureSessionStartHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  const settingsDir = dirname(settingsPath)
  if (!existsSync(settingsDir)) {
    await fs.mkdir(settingsDir, { recursive: true })
  }

  let content = '{}'
  if (existsSync(settingsPath)) {
    content = await fs.readFile(settingsPath, 'utf-8')
  }

  const settings = parseJsonc(content) as ClaudeCodeSettings

  let injected = false

  // UserPromptSubmit hook (project registration)
  const existingPromptHooks = settings.hooks?.UserPromptSubmit ?? []
  const hasPromptHook = existingPromptHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
  )

  if (!hasPromptHook) {
    const edisonHook: ClaudeCodeHookGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: `"${scriptPath}" claude-code` }]
    }
    const edits = modify(content, ['hooks', 'UserPromptSubmit'], [...existingPromptHooks, edisonHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  // PreToolUse hook (session isolation)
  const settingsAfterPrompt = parseJsonc(content) as ClaudeCodeSettings
  const existingToolHooks = settingsAfterPrompt.hooks?.PreToolUse ?? []
  const hasToolHook = existingToolHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
  )

  if (!hasToolHook) {
    const sessionHook: ClaudeCodeHookGroup = {
      matcher: 'mcp__*',
      hooks: [{ type: 'command', command: `"${sessionScriptPath}"` }]
    }
    const edits = modify(content, ['hooks', 'PreToolUse'], [...existingToolHooks, sessionHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  // SessionStart hook (persist authoritative session_id to PID-scoped file)
  const settingsAfterTool = parseJsonc(content) as ClaudeCodeSettings
  const existingStartHooks = settingsAfterTool.hooks?.SessionStart ?? []
  const hasStartHook = existingStartHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-session-start'))
  )

  if (!hasStartHook) {
    const startHook: ClaudeCodeHookGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: `"${sessionStartScriptPath}"` }]
    }
    const edits = modify(content, ['hooks', 'SessionStart'], [...existingStartHooks, startHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  // SessionEnd hook (session completion tracking + cleanup active session file)
  const settingsAfterStart = parseJsonc(content) as ClaudeCodeSettings
  const existingEndHooks = settingsAfterStart.hooks?.SessionEnd ?? []
  const hasEndHook = existingEndHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-session-end'))
  )

  if (!hasEndHook) {
    const endHook: ClaudeCodeHookGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: `"${sessionEndScriptPath}"` }]
    }
    const edits = modify(content, ['hooks', 'SessionEnd'], [...existingEndHooks, endHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  if (!injected) {
    console.log('[HookInjection] Edison hooks already exist in Claude Code settings')
    return false
  }

  if (existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.backup.${Date.now()}`
    await fs.copyFile(settingsPath, backupPath)
    console.log(`[HookInjection] Backed up settings to ${backupPath}`)
  }

  await fs.writeFile(settingsPath, content, 'utf-8')
  console.log('[HookInjection] Injected Edison hooks into Claude Code settings')
  return true
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Remove Edison Watch hook from Claude Code settings.
 */
export async function removeClaudeCodeHook(): Promise<boolean> {
  const settingsPath = getClaudeCodeSettingsPath()
  if (!existsSync(settingsPath)) return false

  let content = await fs.readFile(settingsPath, 'utf-8')
  let removed = false

  // Remove UserPromptSubmit edison hooks
  const settings = parseJsonc(content) as ClaudeCodeSettings
  const existingPromptHooks = settings.hooks?.UserPromptSubmit ?? []
  const filteredPromptHooks = existingPromptHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
  )

  if (filteredPromptHooks.length !== existingPromptHooks.length) {
    const edits = modify(
      content,
      ['hooks', 'UserPromptSubmit'],
      filteredPromptHooks.length > 0 ? filteredPromptHooks : undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
    removed = true
  }

  // Remove PreToolUse edison session hooks
  const settingsAfter = parseJsonc(content) as ClaudeCodeSettings
  const existingToolHooks = settingsAfter.hooks?.PreToolUse ?? []
  const filteredToolHooks = existingToolHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
  )

  if (filteredToolHooks.length !== existingToolHooks.length) {
    const edits = modify(
      content,
      ['hooks', 'PreToolUse'],
      filteredToolHooks.length > 0 ? filteredToolHooks : undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
    removed = true
  }

  // Remove SessionStart edison hooks
  const settingsAfterTool = parseJsonc(content) as ClaudeCodeSettings
  const existingStartHooks = settingsAfterTool.hooks?.SessionStart ?? []
  const filteredStartHooks = existingStartHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-session-start'))
  )

  if (filteredStartHooks.length !== existingStartHooks.length) {
    const edits = modify(
      content,
      ['hooks', 'SessionStart'],
      filteredStartHooks.length > 0 ? filteredStartHooks : undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
    removed = true
  }

  // Remove SessionEnd edison hooks
  const settingsAfterStart = parseJsonc(content) as ClaudeCodeSettings
  const existingEndHooks = settingsAfterStart.hooks?.SessionEnd ?? []
  const filteredEndHooks = existingEndHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-session-end'))
  )

  if (filteredEndHooks.length !== existingEndHooks.length) {
    const edits = modify(
      content,
      ['hooks', 'SessionEnd'],
      filteredEndHooks.length > 0 ? filteredEndHooks : undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
    removed = true
  }

  if (!removed) {
    console.log('[HookInjection] No Edison hook found in Claude Code settings')
    return false
  }

  // Clean up empty hooks object
  const finalSettings = parseJsonc(content) as ClaudeCodeSettings
  if (finalSettings.hooks && Object.keys(finalSettings.hooks).length === 0) {
    const edits = modify(
      content,
      ['hooks'],
      undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
  }

  await fs.writeFile(settingsPath, content, 'utf-8')
  console.log('[HookInjection] Removed Edison hooks from Claude Code settings')
  return true
}
