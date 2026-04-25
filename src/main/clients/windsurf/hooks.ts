/**
 * Windsurf hook injection - inject/remove Edison Watch hooks from Windsurf hooks.json.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { ensureHookScript } from '../../runtime/hookInjectionCore'
import { appInstalled } from '../shared'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getWindsurfHooksPath(): string {
  return join(homedir(), '.codeium', 'windsurf', 'hooks.json')
}

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Detection ───────────────────────────────────────────────────────────────

export function isWindsurfInstalled(): boolean {
  return existsSync(join(homedir(), '.codeium', 'windsurf')) && appInstalled({
    mac: ['Windsurf.app'],
    win: ['Windsurf\\Windsurf.exe'],
    linux: ['windsurf'],
  })
}

// ── Inject ──────────────────────────────────────────────────────────────────

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

// ── Remove ──────────────────────────────────────────────────────────────────

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
