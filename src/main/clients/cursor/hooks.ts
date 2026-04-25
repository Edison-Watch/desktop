/**
 * Cursor hook injection - inject/remove Edison Watch hooks from Cursor hooks.json.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { ensureHookScript, ensureSessionHookScript, ensureSessionEndHookScript } from '../../runtime/hookInjectionCore'
import { appInstalled } from '../shared'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getCursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Detection ───────────────────────────────────────────────────────────────

export function isCursorInstalled(): boolean {
  return existsSync(join(homedir(), '.cursor')) && appInstalled({
    mac: ['Cursor.app'],
    win: ['cursor\\Cursor.exe'],
    linux: ['cursor'],
  })
}

// ── Inject ──────────────────────────────────────────────────────────────────

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

// ── Remove ──────────────────────────────────────────────────────────────────

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
