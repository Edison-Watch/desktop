/**
 * Hook Injection Module
 *
 * Injects hooks into MCP client applications to register project contexts
 * with Edison Watch when tool calls are executed.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser'
import type { McpClientId } from './mcpDiscovery'
import { captureError } from './sentry'

/**
 * Get the path to the Edison Watch pending registrations directory.
 * Hook scripts write JSON files here, and the Electron app watches for new files.
 */
export function getPendingRegistrationsDir(): string {
  return join(homedir(), '.edison-watch', 'pending')
}

/**
 * Get the path to the Edison Watch errors directory.
 * Hook scripts write error JSON here on failure; the Electron app watches and reports to Sentry.
 */
export function getPendingErrorsDir(): string {
  return join(homedir(), '.edison-watch', 'errors')
}

/**
 * Get the path to the Edison Watch hook script.
 * This script is called by the hooks to register the project with Edison Watch.
 */
function getHookScriptPath(): string {
  const scriptName = process.platform === 'win32' ? 'edison-hook.cmd' : 'edison-hook.sh'
  return join(homedir(), '.edison-watch', scriptName)
}

/**
 * Generate the hook script content.
 * This script writes a JSON file to the pending directory instead of making HTTP requests.
 * The Electron app watches this directory and processes new files.
 */
function generateHookScript(): string {
  const pendingDir = getPendingRegistrationsDir()
  const errorsDir = getPendingErrorsDir()

  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Project Registration Hook
REM Writes a registration file for Edison Watch to process

setlocal enabledelayedexpansion

REM Get client name from first argument
set CLIENT=%1
if "%CLIENT%"=="" set CLIENT=unknown

REM Create pending directory if it doesn't exist
if not exist "${pendingDir}" mkdir "${pendingDir}"

REM Generate unique filename using timestamp and random number
set TIMESTAMP=%date:~-4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
set FILENAME=%TIMESTAMP%-%RANDOM%-%CLIENT%.json

REM Write registration file
echo {"projectPath": "%CD%", "registeredBy": "%CLIENT%", "timestamp": "%TIMESTAMP%"} > "${pendingDir}\\%FILENAME%"

exit /b 0
`
  }

  return `#!/bin/bash
# Edison Watch - Project Registration Hook
# Writes a registration file for Edison Watch to process

# Get the client that called this hook (passed as first argument)
CLIENT="\${1:-unknown}"

# Pending registrations and errors directories
PENDING_DIR="${pendingDir}"
ERRORS_DIR="${errorsDir}"

# Create directories if they don't exist
mkdir -p "$PENDING_DIR"
mkdir -p "$ERRORS_DIR"

# Generate unique filename
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RANDOM_ID=$RANDOM
FILENAME="\${TIMESTAMP}-\${RANDOM_ID}-\${CLIENT}.json"

# Get current working directory
CWD="$(pwd)"

# Write registration file (atomic via temp file + mv)
TEMP_FILE="$PENDING_DIR/.\${FILENAME}.tmp"
echo "{\\"projectPath\\": \\"$CWD\\", \\"registeredBy\\": \\"$CLIENT\\", \\"timestamp\\": \\"$TIMESTAMP\\"}" > "$TEMP_FILE"
if ! mv "$TEMP_FILE" "$PENDING_DIR/$FILENAME" 2>/dev/null; then
  echo "{\\"error\\":\\"mv failed\\",\\"client\\":\\"$CLIENT\\",\\"timestamp\\":\\"$(date -Iseconds)\\"}" > "$ERRORS_DIR/\${TIMESTAMP}-\${RANDOM_ID}.json"
fi

# Always exit successfully so we don't block the MCP client
exit 0
`
}

/**
 * Ensure the hook script exists and is executable.
 * Also ensures the pending registrations directory exists.
 */
export async function ensureHookScript(): Promise<string> {
  const scriptPath = getHookScriptPath()
  const scriptDir = dirname(scriptPath)
  const pendingDir = getPendingRegistrationsDir()

  try {
    // Ensure directories exist
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }
    if (!existsSync(pendingDir)) {
      await fs.mkdir(pendingDir, { recursive: true })
    }

    // Write the script
    const content = generateHookScript()
    await fs.writeFile(scriptPath, content, { mode: 0o755 })

    console.log(`[HookInjection] Created hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureHookScript',
      scriptPath,
      pendingDir,
      platform: platform()
    })
    throw err
  }
}

/**
 * Get the path to the Edison Watch session hook script (preToolUse: inject conversation_id).
 */
function getSessionHookScriptPath(): string {
  const scriptName = process.platform === 'win32' ? 'edison-session-hook.cmd' : 'edison-session-hook.py'
  return join(homedir(), '.edison-watch', scriptName)
}

/** Python script content for the session hook (shared by Unix .py and Windows .py). */
const SESSION_HOOK_PYTHON = `#!/usr/bin/env python3
import json
import sys

try:
    data = json.load(sys.stdin)
    conv_id = data.get("conversation_id")
    tool_input = data.get("tool_input", {})
    if conv_id and isinstance(tool_input, dict):
        tool_input["_edison_conversation_id"] = conv_id
        print(json.dumps({"decision": "allow", "updated_input": tool_input}))
    else:
        print(json.dumps({"decision": "allow"}))
except Exception:
    print(json.dumps({"decision": "allow"}))
sys.exit(0)
`

/**
 * Generate the session hook script content for the current platform.
 * Unix: Python script. Windows: .cmd that invokes the .py in the same directory.
 */
function generateSessionHookScript(): string {
  if (process.platform === 'win32') {
    return `@echo off
REM Edison Watch - Session hook: inject conversation_id into MCP tool args
python "%~dp0edison-session-hook.py" 2>nul || python3 "%~dp0edison-session-hook.py"
exit /b 0
`
  }
  return SESSION_HOOK_PYTHON
}

/**
 * Ensure the session hook script exists and is executable.
 * Unix: writes .py. Windows: writes .py and .cmd (cmd invokes the .py).
 */
export async function ensureSessionHookScript(): Promise<string> {
  const scriptPath = getSessionHookScriptPath()
  const scriptDir = dirname(scriptPath)

  try {
    if (!existsSync(scriptDir)) {
      await fs.mkdir(scriptDir, { recursive: true })
    }

    if (process.platform === 'win32') {
      const pyPath = join(scriptDir, 'edison-session-hook.py')
      await fs.writeFile(pyPath, SESSION_HOOK_PYTHON, 'utf-8')
      await fs.writeFile(scriptPath, generateSessionHookScript(), 'utf-8')
    } else {
      await fs.writeFile(scriptPath, generateSessionHookScript(), { mode: 0o755 })
    }

    console.log(`[HookInjection] Created session hook script at ${scriptPath}`)
    return scriptPath
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'ensureSessionHookScript',
      scriptPath,
      platform: platform()
    })
    throw err
  }
}

/**
 * Get Claude Code settings path.
 */
function getClaudeCodeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/**
 * Get Cursor hooks.json path.
 */
function getCursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

/**
 * Get Windsurf hooks.json path.
 */
function getWindsurfHooksPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'hooks.json')
}

/**
 * Claude Code hook configuration structure.
 */
interface ClaudeCodeHook {
  type: 'command'
  command: string
}

interface ClaudeCodeHookGroup {
  matcher: string
  hooks: ClaudeCodeHook[]
}

interface ClaudeCodeHooks {
  UserPromptSubmit?: ClaudeCodeHookGroup[]
  PreToolUse?: ClaudeCodeHookGroup[]
  PostToolUse?: ClaudeCodeHookGroup[]
  [key: string]: ClaudeCodeHookGroup[] | undefined
}

interface ClaudeCodeSettings {
  hooks?: ClaudeCodeHooks
  [key: string]: unknown
}

/**
 * Cursor hook configuration structure.
 * Cursor uses a different format: { version: 1, hooks: { eventName: [{ command, type, timeout? }] } }
 */
interface CursorHookEntry {
  command: string
  type?: 'command' | 'prompt'
  timeout?: number
  matcher?: string
}

interface CursorHooks {
  sessionStart?: CursorHookEntry[]
  preToolUse?: CursorHookEntry[]
  postToolUse?: CursorHookEntry[]
  beforeMCPExecution?: CursorHookEntry[]
  afterMCPExecution?: CursorHookEntry[]
  [key: string]: CursorHookEntry[] | undefined
}

interface CursorHooksFile {
  version: number
  hooks: CursorHooks
}

/**
 * Windsurf hook configuration structure.
 * Windsurf uses: { hooks: { event_name: [{ command, show_output?, working_directory? }] } }
 */
interface WindsurfHookEntry {
  command: string
  show_output?: boolean
  working_directory?: string
}

interface WindsurfHooks {
  pre_user_prompt?: WindsurfHookEntry[]
  pre_mcp_tool_use?: WindsurfHookEntry[]
  post_mcp_tool_use?: WindsurfHookEntry[]
  [key: string]: WindsurfHookEntry[] | undefined
}

interface WindsurfHooksFile {
  hooks: WindsurfHooks
}

/**
 * Inject Edison Watch hook into Claude Code settings.
 * Uses JSONC parser to preserve comments and formatting.
 */
export async function injectClaudeCodeHook(): Promise<boolean> {
  const settingsPath = getClaudeCodeSettingsPath()
  const scriptPath = await ensureHookScript()

  // Create settings directory if needed
  const settingsDir = dirname(settingsPath)
  if (!existsSync(settingsDir)) {
    await fs.mkdir(settingsDir, { recursive: true })
  }

  // Read existing settings or create empty object
  let content = '{}'
  if (existsSync(settingsPath)) {
    content = await fs.readFile(settingsPath, 'utf-8')
  }

  // Parse the JSONC
  const settings = parseJsonc(content) as ClaudeCodeSettings

  // Build our hook configuration
  const edisonHook: ClaudeCodeHookGroup = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `"${scriptPath}" claude-code`
      }
    ]
  }

  // Check if we already have hooks
  const existingHooks = settings.hooks?.UserPromptSubmit ?? []

  // Check if Edison hook already exists
  const hasEdisonHook = existingHooks.some((group) =>
    group.hooks?.some((h) => h.command?.includes('edison-hook'))
  )

  if (hasEdisonHook) {
    console.log('[HookInjection] Edison hook already exists in Claude Code settings')
    return false
  }

  // Use JSONC modify to add our hook while preserving formatting
  let edits = modify(
    content,
    ['hooks', 'UserPromptSubmit'],
    [...existingHooks, edisonHook],
    {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
        eol: '\n'
      }
    }
  )

  // Apply edits
  const newContent = applyEdits(content, edits)

  // Backup existing file
  if (existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.backup.${Date.now()}`
    await fs.copyFile(settingsPath, backupPath)
    console.log(`[HookInjection] Backed up settings to ${backupPath}`)
  }

  // Write updated settings
  await fs.writeFile(settingsPath, newContent, 'utf-8')
  console.log(`[HookInjection] Injected Edison hook into Claude Code settings`)

  return true
}

/**
 * Remove Edison Watch hook from Claude Code settings.
 */
export async function removeClaudeCodeHook(): Promise<boolean> {
  const settingsPath = getClaudeCodeSettingsPath()

  if (!existsSync(settingsPath)) {
    return false
  }

  const content = await fs.readFile(settingsPath, 'utf-8')
  const settings = parseJsonc(content) as ClaudeCodeSettings

  const existingHooks = settings.hooks?.UserPromptSubmit ?? []

  // Filter out Edison hooks
  const filteredHooks = existingHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes('edison-hook'))
  )

  if (filteredHooks.length === existingHooks.length) {
    console.log('[HookInjection] No Edison hook found in Claude Code settings')
    return false
  }

  // Use JSONC modify to update hooks
  let edits = modify(
    content,
    ['hooks', 'UserPromptSubmit'],
    filteredHooks.length > 0 ? filteredHooks : undefined,
    {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
        eol: '\n'
      }
    }
  )

  const newContent = applyEdits(content, edits)
  await fs.writeFile(settingsPath, newContent, 'utf-8')

  console.log('[HookInjection] Removed Edison hook from Claude Code settings')
  return true
}

/**
 * Check if Claude Code is installed.
 */
export function isClaudeCodeInstalled(): boolean {
  // Check if settings directory exists
  const settingsDir = join(homedir(), '.claude')
  return existsSync(settingsDir)
}

/**
 * Check if Cursor is installed.
 */
export function isCursorInstalled(): boolean {
  const cursorDir = join(homedir(), '.cursor')
  return existsSync(cursorDir)
}

/**
 * Check if Windsurf is installed.
 */
export function isWindsurfInstalled(): boolean {
  const windsurfDir = join(homedir(), '.codeium', 'windsurf')
  return existsSync(windsurfDir)
}

/**
 * Inject Edison Watch hook into Cursor hooks.json.
 */
export async function injectCursorHook(): Promise<boolean> {
  const hooksPath = getCursorHooksPath()
  const scriptPath = await ensureHookScript()
  const sessionScriptPath = await ensureSessionHookScript()

  // Create hooks directory if needed
  const hooksDir = dirname(hooksPath)
  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true })
  }

  // Read existing hooks or create new structure
  let hooksFile: CursorHooksFile = { version: 1, hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      hooksFile = JSON.parse(content) as CursorHooksFile
    } catch {
      // Invalid JSON, start fresh
      hooksFile = { version: 1, hooks: {} }
    }
  }

  // Ensure hooks object exists
  if (!hooksFile.hooks) {
    hooksFile.hooks = {}
  }

  let injected = false

  // sessionStart: project registration hook
  const existingSessionStart = hooksFile.hooks.sessionStart ?? []
  const hasEdisonSessionStart = existingSessionStart.some((h) => h.command?.includes('edison-hook'))
  if (!hasEdisonSessionStart) {
    hooksFile.hooks.sessionStart = [
      ...existingSessionStart,
      { command: `"${scriptPath}" cursor`, type: 'command' }
    ]
    injected = true
  }

  // preToolUse: inject conversation_id into MCP tool args
  const existingPreToolUse = hooksFile.hooks.preToolUse ?? []
  const hasEdisonPreToolUse = existingPreToolUse.some((h) => h.command?.includes('edison-session-hook'))
  if (!hasEdisonPreToolUse) {
    hooksFile.hooks.preToolUse = [
      ...existingPreToolUse,
      { command: `"${sessionScriptPath}"`, type: 'command', matcher: 'MCP' }
    ]
    injected = true
  }

  if (!injected) {
    console.log('[HookInjection] Edison hooks already exist in Cursor hooks')
    return false
  }

  // Backup existing file
  if (existsSync(hooksPath)) {
    const backupPath = `${hooksPath}.backup.${Date.now()}`
    await fs.copyFile(hooksPath, backupPath)
    console.log(`[HookInjection] Backed up Cursor hooks to ${backupPath}`)
  }

  // Write updated hooks
  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Cursor hooks')

  return true
}

/**
 * Remove Edison Watch hook from Cursor hooks.json.
 */
export async function removeCursorHook(): Promise<boolean> {
  const hooksPath = getCursorHooksPath()

  if (!existsSync(hooksPath)) {
    return false
  }

  const content = await fs.readFile(hooksPath, 'utf-8')
  const hooksFile = JSON.parse(content) as CursorHooksFile

  let removed = false

  // Remove from sessionStart
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

  // Remove from preToolUse
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

  if (!removed) {
    console.log('[HookInjection] No Edison hook found in Cursor hooks')
    return false
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Cursor hooks')

  return true
}

/**
 * Inject Edison Watch hook into Windsurf hooks.json.
 */
export async function injectWindsurfHook(): Promise<boolean> {
  const hooksPath = getWindsurfHooksPath()
  const scriptPath = await ensureHookScript()

  // Create hooks directory if needed
  const hooksDir = dirname(hooksPath)
  if (!existsSync(hooksDir)) {
    await fs.mkdir(hooksDir, { recursive: true })
  }

  // Read existing hooks or create new structure
  let hooksFile: WindsurfHooksFile = { hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      const content = await fs.readFile(hooksPath, 'utf-8')
      hooksFile = JSON.parse(content) as WindsurfHooksFile
    } catch {
      // Invalid JSON, start fresh
      hooksFile = { hooks: {} }
    }
  }

  // Ensure hooks object exists
  if (!hooksFile.hooks) {
    hooksFile.hooks = {}
  }

  const existingHooks = hooksFile.hooks.pre_user_prompt ?? []

  // Check if Edison hook already exists
  const hasEdisonHook = existingHooks.some((h) => h.command?.includes('edison-hook'))

  if (hasEdisonHook) {
    console.log('[HookInjection] Edison hook already exists in Windsurf hooks')
    return false
  }

  // Add our hook
  const edisonHook: WindsurfHookEntry = {
    command: `"${scriptPath}" windsurf`,
    show_output: false
  }

  hooksFile.hooks.pre_user_prompt = [...existingHooks, edisonHook]

  // Backup existing file
  if (existsSync(hooksPath)) {
    const backupPath = `${hooksPath}.backup.${Date.now()}`
    await fs.copyFile(hooksPath, backupPath)
    console.log(`[HookInjection] Backed up Windsurf hooks to ${backupPath}`)
  }

  // Write updated hooks
  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Injected Edison hook into Windsurf hooks')

  return true
}

/**
 * Remove Edison Watch hook from Windsurf hooks.json.
 */
export async function removeWindsurfHook(): Promise<boolean> {
  const hooksPath = getWindsurfHooksPath()

  if (!existsSync(hooksPath)) {
    return false
  }

  const content = await fs.readFile(hooksPath, 'utf-8')
  const hooksFile = JSON.parse(content) as WindsurfHooksFile

  const existingHooks = hooksFile.hooks?.pre_user_prompt ?? []

  // Filter out Edison hooks
  const filteredHooks = existingHooks.filter((h) => !h.command?.includes('edison-hook'))

  if (filteredHooks.length === existingHooks.length) {
    console.log('[HookInjection] No Edison hook found in Windsurf hooks')
    return false
  }

  // Update hooks
  if (filteredHooks.length > 0) {
    hooksFile.hooks.pre_user_prompt = filteredHooks
  } else {
    delete hooksFile.hooks.pre_user_prompt
  }

  await fs.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8')
  console.log('[HookInjection] Removed Edison hook from Windsurf hooks')

  return true
}

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
      results.push({
        client: 'claude-code',
        installed: injected,
        alreadyExists: !injected
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'claude-code',
        operation: 'injectAllHooks',
        platform: platform()
      })
      results.push({
        client: 'claude-code',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
    }
  }

  // Cursor
  if (isCursorInstalled()) {
    try {
      const injected = await injectCursorHook()
      results.push({
        client: 'cursor',
        installed: injected,
        alreadyExists: !injected
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'cursor',
        operation: 'injectAllHooks',
        platform: platform()
      })
      results.push({
        client: 'cursor',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
    }
  }

  // Windsurf
  if (isWindsurfInstalled()) {
    try {
      const injected = await injectWindsurfHook()
      results.push({
        client: 'windsurf',
        installed: injected,
        alreadyExists: !injected
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'windsurf',
        operation: 'injectAllHooks',
        platform: platform()
      })
      results.push({
        client: 'windsurf',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
    }
  }

  // Note: VS Code, Cline, Antigravity, and Zed do not have native hook systems
  // They would require extensions or other mechanisms to support project registration

  return results
}

/**
 * Remove hooks from all MCP clients.
 */
export async function removeAllHooks(): Promise<HookInjectionResult[]> {
  const results: HookInjectionResult[] = []

  // Claude Code
  if (isClaudeCodeInstalled()) {
    try {
      const removed = await removeClaudeCodeHook()
      results.push({
        client: 'claude-code',
        installed: false,
        alreadyExists: !removed
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'claude-code',
        operation: 'removeAllHooks',
        platform: platform()
      })
      results.push({
        client: 'claude-code',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
    }
  }

  // Cursor
  if (isCursorInstalled()) {
    try {
      const removed = await removeCursorHook()
      results.push({
        client: 'cursor',
        installed: false,
        alreadyExists: !removed
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'cursor',
        operation: 'removeAllHooks',
        platform: platform()
      })
      results.push({
        client: 'cursor',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
    }
  }

  // Windsurf
  if (isWindsurfInstalled()) {
    try {
      const removed = await removeWindsurfHook()
      results.push({
        client: 'windsurf',
        installed: false,
        alreadyExists: !removed
      })
    } catch (err) {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        client: 'windsurf',
        operation: 'removeAllHooks',
        platform: platform()
      })
      results.push({
        client: 'windsurf',
        installed: false,
        alreadyExists: false,
        error: String(err)
      })
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
    } catch {
      // Ignore errors
    }
  }

  results.push({
    client: 'claude-code',
    installed: claudeInstalled,
    hasHook: claudeHasHook
  })

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
    } catch {
      // Ignore errors
    }
  }

  results.push({
    client: 'cursor',
    installed: cursorInstalled,
    hasHook: cursorHasHook
  })

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
    } catch {
      // Ignore errors
    }
  }

  results.push({
    client: 'windsurf',
    installed: windsurfInstalled,
    hasHook: windsurfHasHook
  })

  return results
}
