/**
 * Shared utilities for per-client hook injection.
 * Provides app/CLI detection helpers and path accessors used across multiple clients.
 */

import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

// ── App / CLI detection helpers ─────────────────────────────────────────────

/** Check whether a macOS .app bundle exists in /Applications or ~/Applications. Non-darwin always returns true. */
export function appBundleExists(appNames: string[]): boolean {
  if (platform() !== 'darwin') return true
  return appNames.some(name =>
    existsSync(join('/Applications', name)) ||
    existsSync(join(homedir(), 'Applications', name))
  )
}

/** Check whether a CLI binary is on PATH or at known install locations. */
export function cliBinaryExists(binary: string): boolean {
  const cmd = platform() === 'win32' ? 'where' : 'which'
  try {
    const result = spawnSync(cmd, [binary], { timeout: 2000, stdio: 'pipe' })
    if (result.status === 0) return true
  } catch {
    // fall through to known-path checks
  }
  // Packaged macOS Electron apps get a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
  // so CLI-only tools like `claude` aren't found by `which`. Check known locations.
  if (platform() === 'darwin' || platform() === 'linux') {
    const home = homedir()
    const knownPaths = [
      join(home, '.local', 'bin', binary),
      join('/usr', 'local', 'bin', binary),
      join('/opt', 'homebrew', 'bin', binary),
      ...(binary === 'claude' ? [join('/Applications', 'cmux.app', 'Contents', 'Resources', 'bin', binary)] : []),
    ]
    return knownPaths.some(p => existsSync(p))
  }
  return false
}
