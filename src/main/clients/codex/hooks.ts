/**
 * Codex CLI hook injection - inject/remove Edison Watch hooks from Codex config.toml.
 */

import { promises as fs, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { ensureHookScript, ensureSessionEndHookScript } from '../../runtime/hookInjectionCore'
import { cliBinaryExists } from '../shared'

// ── Path helpers ─────────────────────────────────────────────────────────────

export function getCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml')
}

// ── Detection ───────────────────────────────────────────────────────────────

export function isCodexInstalled(): boolean {
  return existsSync(join(homedir(), '.codex')) && cliBinaryExists('codex')
}

// ── Inject ──────────────────────────────────────────────────────────────────

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
    // Has SessionStart but not Stop - append just the Stop hook
    await fs.writeFile(configPath, existing + `\n[[hooks.Stop]]\ncommand = "${sessionEndScriptPath}"\n`, 'utf-8')
  } else if (!existing.includes('edison-hook') && existing.includes('edison-session-end')) {
    // Has Stop but not SessionStart - append just the SessionStart hook
    await fs.writeFile(configPath, existing + `\n[[hooks.SessionStart]]\ncommand = "${scriptPath} codex"\n`, 'utf-8')
  } else {
    // Neither hook exists - append both
    await fs.writeFile(configPath, existing + buildCodexHookToml(scriptPath, sessionEndScriptPath), 'utf-8')
  }

  console.log('[HookInjection] Injected Edison hooks into Codex config.toml')
  return true
}

// ── Remove ──────────────────────────────────────────────────────────────────

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
