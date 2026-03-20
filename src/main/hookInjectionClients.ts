/**
 * Per-client hook injection helpers for Claude Code, Cursor, Windsurf, Gemini, and Codex.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import { ensureHookScript, ensureSessionHookScript, ensureSessionEndHookScript } from './hookInjectionCore'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getClaudeCodeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

export function getCursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

export function getWindsurfHooksPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'hooks.json')
}

export function getGeminiSettingsPath(): string {
  return join(homedir(), '.gemini', 'settings.json')
}

export function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

export function getVsCodeCopilotHooksPath(): string {
  return join(homedir(), '.copilot', 'hooks', 'edison-watch.json')
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
  [key: string]: ClaudeCodeHookGroup[] | undefined
}

export interface ClaudeCodeSettings {
  hooks?: ClaudeCodeHooks
  [key: string]: unknown
}

export interface CursorHookEntry {
  command: string
  type?: 'command' | 'prompt'
  timeout?: number
  matcher?: string
}

export interface CursorHooks {
  sessionStart?: CursorHookEntry[]
  sessionEnd?: CursorHookEntry[]
  preToolUse?: CursorHookEntry[]
  postToolUse?: CursorHookEntry[]
  beforeMCPExecution?: CursorHookEntry[]
  afterMCPExecution?: CursorHookEntry[]
  [key: string]: CursorHookEntry[] | undefined
}

export interface CursorHooksFile {
  version: number
  hooks: CursorHooks
}

export interface WindsurfHookEntry {
  command: string
  show_output?: boolean
  working_directory?: string
}

export interface WindsurfHooks {
  pre_user_prompt?: WindsurfHookEntry[]
  pre_mcp_tool_use?: WindsurfHookEntry[]
  post_mcp_tool_use?: WindsurfHookEntry[]
  [key: string]: WindsurfHookEntry[] | undefined
}

export interface WindsurfHooksFile {
  hooks: WindsurfHooks
}

// ── Claude Code ──────────────────────────────────────────────────────────────

export function isClaudeCodeInstalled(): boolean {
  return existsSync(join(homedir(), '.claude'))
}

/**
 * Inject Edison Watch hook into Claude Code settings.
 * Uses JSONC parser to preserve comments and formatting.
 */
export async function injectClaudeCodeHook(): Promise<boolean> {
  const settingsPath = getClaudeCodeSettingsPath()
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()

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

// ── Cursor ───────────────────────────────────────────────────────────────────

export function isCursorInstalled(): boolean {
  return existsSync(join(homedir(), '.cursor'))
}

/**
 * Inject Edison Watch hook into Cursor hooks.json.
 */
export async function injectCursorHook(): Promise<boolean> {
  const hooksPath = getCursorHooksPath()
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  const hooksDir = dirname(hooksPath)
  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true })
  }

  let hooksFile: CursorHooksFile = { version: 1, hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      hooksFile = JSON.parse(content) as CursorHooksFile
    } catch {
      hooksFile = { version: 1, hooks: {} }
    }
  }

  if (!hooksFile.hooks) hooksFile.hooks = {}

  let injected = false

  const existingSessionStart = hooksFile.hooks.sessionStart ?? []
  const hasEdisonSessionStart = existingSessionStart.some((h) => h.command?.includes('edison-hook'))
  if (!hasEdisonSessionStart) {
    hooksFile.hooks.sessionStart = [
      ...existingSessionStart,
      { command: `"${scriptPath}" cursor`, type: 'command' }
    ]
    injected = true
  }

  // beforeMCPExecution: inject conversation_id into MCP tool args
  const existingBeforeMCP = hooksFile.hooks.beforeMCPExecution ?? []
  const hasEdisonBeforeMCP = existingBeforeMCP.some((h) => h.command?.includes('edison-session-hook'))
  if (!hasEdisonBeforeMCP) {
    hooksFile.hooks.beforeMCPExecution = [
      ...existingBeforeMCP,
      { command: `"${sessionScriptPath}"`, type: 'command' }
    ]
    injected = true
  }

  // Migrate: remove old preToolUse entries if present
  const existingPreToolUse = hooksFile.hooks.preToolUse ?? []
  const filteredPreToolUse = existingPreToolUse.filter((h) => !h.command?.includes('edison-session-hook'))
  if (filteredPreToolUse.length !== existingPreToolUse.length) {
    if (filteredPreToolUse.length > 0) {
      hooksFile.hooks.preToolUse = filteredPreToolUse
    } else {
      delete hooksFile.hooks.preToolUse
    }
    injected = true
  }

  // sessionEnd: explicit session completion tracking
  const existingSessionEnd = hooksFile.hooks.sessionEnd ?? []
  const hasEdisonSessionEnd = existingSessionEnd.some((h) => h.command?.includes('edison-session-end'))
  if (!hasEdisonSessionEnd) {
    hooksFile.hooks.sessionEnd = [
      ...existingSessionEnd,
      { command: `"${sessionEndScriptPath}"`, type: 'command' }
    ]
    injected = true
  }

  if (!injected) {
    console.log('[HookInjection] Edison hooks already exist in Cursor hooks')
    return false
  }

  if (existsSync(hooksPath)) {
    const backupPath = `${hooksPath}.backup.${Date.now()}`
    await fs.copyFile(hooksPath, backupPath)
    console.log(`[HookInjection] Backed up Cursor hooks to ${backupPath}`)
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Cursor hooks')
  return true
}

/**
 * Remove Edison Watch hook from Cursor hooks.json.
 */
export async function removeCursorHook(): Promise<boolean> {
  const hooksPath = getCursorHooksPath()
  if (!existsSync(hooksPath)) return false

  const content = await fs.readFile(hooksPath, 'utf-8')
  const hooksFile = JSON.parse(content) as CursorHooksFile

  let removed = false

  const existingSessionStart = hooksFile.hooks?.sessionStart ?? []
  const filteredSessionStart = existingSessionStart.filter((h) => !h.command?.includes('edison-hook'))
  if (filteredSessionStart.length !== existingSessionStart.length) {
    removed = true
    if (filteredSessionStart.length > 0) {
      hooksFile.hooks!.sessionStart = filteredSessionStart
    } else {
      delete hooksFile.hooks!.sessionStart
    }
  }

  // Clean up beforeMCPExecution (current location)
  const existingBeforeMCP = hooksFile.hooks?.beforeMCPExecution ?? []
  const filteredBeforeMCP = existingBeforeMCP.filter((h) => !h.command?.includes('edison-session-hook'))
  if (filteredBeforeMCP.length !== existingBeforeMCP.length) {
    removed = true
    if (filteredBeforeMCP.length > 0) {
      hooksFile.hooks!.beforeMCPExecution = filteredBeforeMCP
    } else {
      delete hooksFile.hooks!.beforeMCPExecution
    }
  }

  // Clean up old preToolUse entries (backward compat for users upgrading)
  const existingPreToolUse = hooksFile.hooks?.preToolUse ?? []
  const filteredPreToolUse = existingPreToolUse.filter((h) => !h.command?.includes('edison-session-hook'))
  if (filteredPreToolUse.length !== existingPreToolUse.length) {
    removed = true
    if (filteredPreToolUse.length > 0) {
      hooksFile.hooks!.preToolUse = filteredPreToolUse
    } else {
      delete hooksFile.hooks!.preToolUse
    }
  }

  // Clean up sessionEnd entries
  const existingSessionEnd = hooksFile.hooks?.sessionEnd ?? []
  const filteredSessionEnd = existingSessionEnd.filter((h) => !h.command?.includes('edison-session-end'))
  if (filteredSessionEnd.length !== existingSessionEnd.length) {
    removed = true
    if (filteredSessionEnd.length > 0) {
      hooksFile.hooks!.sessionEnd = filteredSessionEnd
    } else {
      delete hooksFile.hooks!.sessionEnd
    }
  }

  if (!removed) {
    console.log('[HookInjection] No Edison hook found in Cursor hooks')
    return false
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Cursor hooks')
  return true
}

// ── Windsurf ─────────────────────────────────────────────────────────────────

export function isWindsurfInstalled(): boolean {
  return existsSync(join(homedir(), '.codeium', 'windsurf'))
}

/**
 * Inject Edison Watch hook into Windsurf hooks.json.
 */
export async function injectWindsurfHook(): Promise<boolean> {
  const hooksPath = getWindsurfHooksPath()
  const scriptPath = await ensureHookScript()

  const hooksDir = dirname(hooksPath)
  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true })
  }

  let hooksFile: WindsurfHooksFile = { hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      hooksFile = JSON.parse(content) as WindsurfHooksFile
    } catch {
      hooksFile = { hooks: {} }
    }
  }

  if (!hooksFile.hooks) hooksFile.hooks = {}

  const existingHooks = hooksFile.hooks.pre_user_prompt ?? []
  const hasEdisonHook = existingHooks.some((h) => h.command?.includes('edison-hook'))

  if (hasEdisonHook) {
    console.log('[HookInjection] Edison hook already exists in Windsurf hooks')
    return false
  }

  hooksFile.hooks.pre_user_prompt = [
    ...existingHooks,
    { command: `"${scriptPath}" windsurf`, show_output: false }
  ]

  if (existsSync(hooksPath)) {
    await fs.copyFile(hooksPath, `${hooksPath}.backup.${Date.now()}`)
    console.log('[HookInjection] Backed up Windsurf hooks')
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Windsurf hooks')
  return true
}

/**
 * Remove Edison Watch hook from Windsurf hooks.json.
 */
export async function removeWindsurfHook(): Promise<boolean> {
  const hooksPath = getWindsurfHooksPath()
  if (!existsSync(hooksPath)) return false

  const content = await fs.readFile(hooksPath, 'utf-8')
  const hooksFile = JSON.parse(content) as WindsurfHooksFile

  const existingHooks = hooksFile.hooks?.pre_user_prompt ?? []
  const filteredHooks = existingHooks.filter((h) => !h.command?.includes('edison-hook'))

  if (filteredHooks.length === existingHooks.length) {
    console.log('[HookInjection] No Edison hook found in Windsurf hooks')
    return false
  }

  if (filteredHooks.length > 0) {
    hooksFile.hooks.pre_user_prompt = filteredHooks
  } else {
    delete hooksFile.hooks.pre_user_prompt
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Windsurf hooks')
  return true
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────

export function isGeminiInstalled(): boolean {
  return existsSync(join(homedir(), '.gemini'))
}

/**
 * Inject Edison Watch hook into Gemini CLI settings.json.
 * Uses the same hook group structure as Claude Code (SessionStart event).
 */
export async function injectGeminiHook(): Promise<boolean> {
  const settingsPath = getGeminiSettingsPath()
  const scriptPath = await ensureHookScript()

  const settingsDir = dirname(settingsPath)
  if (!existsSync(settingsDir)) {
    await fs.mkdir(settingsDir, { recursive: true })
  }

  let content = '{}'
  if (existsSync(settingsPath)) {
    content = await fs.readFile(settingsPath, 'utf-8')
  }

  const settings = parseJsonc(content) as ClaudeCodeSettings

  const existingHooks = settings.hooks?.SessionStart ?? []
  const hasEdisonHook = existingHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-hook'))
  )

  if (hasEdisonHook) {
    console.log('[HookInjection] Edison hook already exists in Gemini settings')
    return false
  }

  const edisonHook: ClaudeCodeHookGroup = {
    matcher: '*',
    hooks: [{ type: 'command', command: `"${scriptPath}" gemini` }]
  }

  const edits = modify(content, ['hooks', 'SessionStart'], [...existingHooks, edisonHook], {
    formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' }
  })
  const newContent = applyEdits(content, edits)

  if (existsSync(settingsPath)) {
    await fs.copyFile(settingsPath, `${settingsPath}.backup.${Date.now()}`)
  }

  await fs.writeFile(settingsPath, newContent, 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Gemini settings')
  return true
}

/**
 * Remove Edison Watch hook from Gemini CLI settings.json.
 */
export async function removeGeminiHook(): Promise<boolean> {
  const settingsPath = getGeminiSettingsPath()
  if (!existsSync(settingsPath)) return false

  const content = await fs.readFile(settingsPath, 'utf-8')
  const settings = parseJsonc(content) as ClaudeCodeSettings

  const existingHooks = settings.hooks?.SessionStart ?? []
  const filteredHooks = existingHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-hook'))
  )

  if (filteredHooks.length === existingHooks.length) {
    console.log('[HookInjection] No Edison hook found in Gemini settings')
    return false
  }

  const edits = modify(
    content,
    ['hooks', 'SessionStart'],
    filteredHooks.length > 0 ? filteredHooks : undefined,
    { formattingOptions: { tabSize: 2, insertSpaces: true, eol: '\n' } }
  )
  const newContent = applyEdits(content, edits)
  await fs.writeFile(settingsPath, newContent, 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Gemini settings')
  return true
}

// ── Codex CLI ────────────────────────────────────────────────────────────────

export function isCodexInstalled(): boolean {
  return existsSync(join(homedir(), '.codex'))
}

function buildCodexHookToml(scriptPath: string): string {
  return `\n[[hooks.SessionStart]]\ncommand = "${scriptPath} codex"\n`
}

/**
 * Inject Edison Watch hook into Codex CLI config.toml.
 * Appends a [[hooks.SessionStart]] array-of-tables entry.
 */
export async function injectCodexHook(): Promise<boolean> {
  const configPath = getCodexConfigPath()
  const scriptPath = await ensureHookScript()

  const configDir = dirname(configPath)
  if (!existsSync(configDir)) {
    await fs.mkdir(configDir, { recursive: true })
  }

  let existing = ''
  if (existsSync(configPath)) {
    existing = await fs.readFile(configPath, 'utf-8')
  }

  if (existing.includes('edison-hook')) {
    console.log('[HookInjection] Edison hook already exists in Codex config.toml')
    return false
  }

  if (existsSync(configPath)) {
    await fs.copyFile(configPath, `${configPath}.backup.${Date.now()}`)
  }

  await fs.writeFile(configPath, existing + buildCodexHookToml(scriptPath), 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Codex config.toml')
  return true
}

/**
 * Remove Edison Watch hook from Codex CLI config.toml.
 */
export async function removeCodexHook(): Promise<boolean> {
  const configPath = getCodexConfigPath()
  if (!existsSync(configPath)) return false

  const content = await fs.readFile(configPath, 'utf-8')
  const cleaned = content.replace(
    /\n\[\[hooks\.SessionStart\]\]\ncommand = "[^"]*edison-hook[^"]*"\n/g,
    ''
  )

  if (cleaned === content) {
    console.log('[HookInjection] No Edison hook found in Codex config.toml')
    return false
  }

  await fs.writeFile(configPath, cleaned, 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Codex config.toml')
  return true
}

// ── VSCode Copilot Agent Hooks ──────────────────────────────────────────────

export interface VsCodeCopilotHooksFile {
  hooks: {
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
 * Creates PreToolUse (session ID injection) and Stop (session end) hooks.
 */
export async function injectVsCodeCopilotHook(): Promise<boolean> {
  const hooksPath = getVsCodeCopilotHooksPath()

  // Always ensure scripts exist (guards against manual deletion of ~/.edison-watch/ scripts)
  const sessionScriptPath = await ensureSessionHookScript()
  const sessionEndScriptPath = await ensureSessionEndHookScript()

  // If the file already exists, it's ours — check if it's current
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      const existing = JSON.parse(content) as VsCodeCopilotHooksFile
      const hasPreToolUse = existing.hooks?.PreToolUse?.some((h) => h.command?.includes('edison-session-hook') && !h.command?.includes('edison-session-end'))
      const hasStop = existing.hooks?.Stop?.some((h) => h.command?.includes('edison-session-end'))
      if (hasPreToolUse && hasStop) {
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
      PreToolUse: [{ type: 'command', command: `"${sessionScriptPath}"` }],
      Stop: [{ type: 'command', command: `"${sessionEndScriptPath}"` }]
    }
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
