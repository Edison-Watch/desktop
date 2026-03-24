/**
 * Per-client hook injection helpers for Gemini CLI, Codex CLI, and VS Code Copilot.
 * Split from hookInjectionClients.ts to stay under line-count limits.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import { ensureHookScript, ensureSessionHookScript, ensureSessionEndHookScript, ensureSessionStartHookScript } from './hookInjectionCore'
import type { ClaudeCodeHook, ClaudeCodeHookGroup } from './hookInjectionClients'
import { getGeminiSettingsPath, getCodexConfigPath, getVsCodeCopilotHooksPath, cliBinaryExists } from './hookInjectionClients'

// ── Gemini hook types ────────────────────────────────────────────────────────

export interface GeminiSettings {
  hooks?: {
    SessionStart?: ClaudeCodeHookGroup[]
    SessionEnd?: ClaudeCodeHookGroup[]
    BeforeTool?: ClaudeCodeHookGroup[]
    AfterTool?: ClaudeCodeHookGroup[]
    [key: string]: ClaudeCodeHookGroup[] | undefined
  }
  [key: string]: unknown
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────

export function isGeminiInstalled(): boolean {
  return existsSync(join(homedir(), '.gemini')) && cliBinaryExists('gemini')
}

/**
 * Inject Edison Watch hooks into Gemini CLI settings.json.
 * Uses the same hook group structure as Claude Code but with Gemini event names
 * (BeforeTool instead of PreToolUse).
 * Hooks: SessionStart (registration), BeforeTool (session isolation), SessionEnd (lifecycle).
 */
export async function injectGeminiHook(): Promise<boolean> {
  const settingsPath = getGeminiSettingsPath()
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  const settingsDir = dirname(settingsPath)
  if (!existsSync(settingsDir)) {
    await fs.mkdir(settingsDir, { recursive: true })
  }

  let content = '{}'
  if (existsSync(settingsPath)) {
    content = await fs.readFile(settingsPath, 'utf-8')
  }

  let injected = false

  // SessionStart hook (project registration)
  const settings = parseJsonc(content) as GeminiSettings
  const existingStartHooks = settings.hooks?.SessionStart ?? []
  const hasStartHook = existingStartHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
  )

  if (!hasStartHook) {
    const edisonHook: ClaudeCodeHookGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: `"${scriptPath}" gemini` }]
    }
    const edits = modify(content, ['hooks', 'SessionStart'], [...existingStartHooks, edisonHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  // BeforeTool hook (session isolation — inject conversation_id into MCP tool args)
  const settingsAfterStart = parseJsonc(content) as GeminiSettings
  const existingToolHooks = settingsAfterStart.hooks?.BeforeTool ?? []
  const hasToolHook = existingToolHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
  )

  if (!hasToolHook) {
    const sessionHook: ClaudeCodeHookGroup = {
      matcher: 'mcp__*',
      hooks: [{ type: 'command', command: `"${sessionScriptPath}"` }]
    }
    const edits = modify(content, ['hooks', 'BeforeTool'], [...existingToolHooks, sessionHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
    })
    content = applyEdits(content, edits)
    injected = true
  }

  // SessionEnd hook (session lifecycle)
  const settingsAfterTool = parseJsonc(content) as GeminiSettings
  const existingEndHooks = settingsAfterTool.hooks?.SessionEnd ?? []
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
    console.log('[HookInjection] Edison hooks already exist in Gemini settings')
    return false
  }

  if (existsSync(settingsPath)) {
    await fs.copyFile(settingsPath, `${settingsPath}.backup.${Date.now()}`)
  }

  await fs.writeFile(settingsPath, content, 'utf-8')
  console.log('[HookInjection] Injected Edison hooks into Gemini settings')
  return true
}

/**
 * Remove Edison Watch hooks from Gemini CLI settings.json.
 */
export async function removeGeminiHook(): Promise<boolean> {
  const settingsPath = getGeminiSettingsPath()
  if (!existsSync(settingsPath)) return false

  let content = await fs.readFile(settingsPath, 'utf-8')
  let removed = false

  // Remove SessionStart edison hooks
  const settings = parseJsonc(content) as GeminiSettings
  const existingStartHooks = settings.hooks?.SessionStart ?? []
  const filteredStartHooks = existingStartHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-hook') && !h.command?.includes('edison-session-hook'))
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

  // Remove BeforeTool edison session hooks
  const settingsAfterStart = parseJsonc(content) as GeminiSettings
  const existingToolHooks = settingsAfterStart.hooks?.BeforeTool ?? []
  const filteredToolHooks = existingToolHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-session-hook'))
  )

  if (filteredToolHooks.length !== existingToolHooks.length) {
    const edits = modify(
      content,
      ['hooks', 'BeforeTool'],
      filteredToolHooks.length > 0 ? filteredToolHooks : undefined,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
    )
    content = applyEdits(content, edits)
    removed = true
  }

  // Remove SessionEnd edison hooks
  const settingsAfterTool = parseJsonc(content) as GeminiSettings
  const existingEndHooks = settingsAfterTool.hooks?.SessionEnd ?? []
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
    console.log('[HookInjection] No Edison hook found in Gemini settings')
    return false
  }

  // Clean up empty hooks object
  const finalSettings = parseJsonc(content) as GeminiSettings
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
  console.log('[HookInjection] Removed Edison hooks from Gemini settings')
  return true
}

// ── Codex CLI ────────────────────────────────────────────────────────────────

export function isCodexInstalled(): boolean {
  return existsSync(join(homedir(), '.codex')) && cliBinaryExists('codex')
}

function buildCodexHookToml(scriptPath: string, sessionEndScriptPath: string): string {
  return `\n[[hooks.SessionStart]]\ncommand = "${scriptPath} codex"\n\n[[hooks.Stop]]\ncommand = "${sessionEndScriptPath}"\n`
}

/**
 * Inject Edison Watch hooks into Codex CLI config.toml.
 * Appends [[hooks.SessionStart]] (registration) and [[hooks.Stop]] (session end) entries.
 * Note: Codex CLI hooks are experimental (v0.114.0+). No PreToolUse/BeforeTool event
 * exists, so session isolation is not possible.
 */
export async function injectCodexHook(): Promise<boolean> {
  const configPath = getCodexConfigPath()
  const scriptPath = await ensureHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  const configDir = dirname(configPath)
  if (!existsSync(configDir)) {
    await fs.mkdir(configDir, { recursive: true })
  }

  let existing = ''
  if (existsSync(configPath)) {
    existing = await fs.readFile(configPath, 'utf-8')
  }

  if (existing.includes('edison-hook') && existing.includes('edison-session-end')) {
    console.log('[HookInjection] Edison hooks already exist in Codex config.toml')
    return false
  }

  if (existsSync(configPath)) {
    await fs.copyFile(configPath, `${configPath}.backup.${Date.now()}`)
  }

  // Handle partial states: only one of the two hooks may already exist
  if (existing.includes('edison-hook') && !existing.includes('edison-session-end')) {
    // Has SessionStart but not Stop — append just the Stop hook
    await fs.writeFile(configPath, existing + `\n[[hooks.Stop]]\ncommand = "${sessionEndScriptPath}"\n`, 'utf-8')
  } else if (!existing.includes('edison-hook') && existing.includes('edison-session-end')) {
    // Has Stop but not SessionStart — append just the SessionStart hook
    await fs.writeFile(configPath, existing + `\n[[hooks.SessionStart]]\ncommand = "${scriptPath} codex"\n`, 'utf-8')
  } else {
    // Neither hook exists — append both
    await fs.writeFile(configPath, existing + buildCodexHookToml(scriptPath, sessionEndScriptPath), 'utf-8')
  }

  console.log('[HookInjection] Injected Edison hooks into Codex config.toml')
  return true
}

/**
 * Remove Edison Watch hooks from Codex CLI config.toml.
 */
export async function removeCodexHook(): Promise<boolean> {
  const configPath = getCodexConfigPath()
  if (!existsSync(configPath)) return false

  const content = await fs.readFile(configPath, 'utf-8')
  let cleaned = content
  // Remove SessionStart edison hooks
  cleaned = cleaned.replace(
    /\n\[\[hooks\.SessionStart\]\]\ncommand = "[^"]*edison-hook[^"]*"\n/g,
    ''
  )
  // Remove Stop edison hooks
  cleaned = cleaned.replace(
    /\n\[\[hooks\.Stop\]\]\ncommand = "[^"]*edison-session-end[^"]*"\n/g,
    ''
  )

  if (cleaned === content) {
    console.log('[HookInjection] No Edison hook found in Codex config.toml')
    return false
  }

  await fs.writeFile(configPath, cleaned, 'utf-8')
  console.log('[HookInjection] Removed Edison hooks from Codex config.toml')
  return true
}

// ── VSCode Copilot Agent Hooks ──────────────────────────────────────────────

export interface VsCodeCopilotHooksFile {
  hooks: {
    SessionStart?: ClaudeCodeHook[]
    UserPromptSubmit?: ClaudeCodeHook[]
    PreToolUse?: ClaudeCodeHook[]
    Stop?: ClaudeCodeHook[]
    [key: string]: ClaudeCodeHook[] | undefined
  }
}

export function isVsCodeCopilotInstalled(): boolean {
  return existsSync(join(homedir(), '.copilot'))
}

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

  // If the file already exists, it's ours — check if it's current
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
