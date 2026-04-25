/**
 * Shared utilities for per-client hook injection.
 * Provides app/CLI detection helpers and path accessors used across multiple clients.
 */

import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { isAbsolute, join } from 'path'
import { spawnSync } from 'child_process'

// ── App / CLI detection helpers ─────────────────────────────────────────────

/**
 * Per-platform hints describing where a GUI application is installed.
 *
 * Callers must provide hints for every platform on which they want the app
 * to be considered installable. When no hint matches the current platform,
 * `appInstalled` returns `false` - this is intentional, so that callers
 * can't accidentally treat unsupported platforms as "installed" (#609).
 */
export interface AppInstalledHints {
  /** macOS: `.app` bundle names probed under `/Applications` and `~/Applications`. */
  mac?: string[]
  /**
   * Windows: `.exe` paths. Absolute paths are checked directly; relative
   * paths are probed under `%LOCALAPPDATA%\Programs`, `%ProgramFiles%`, and
   * `%ProgramFiles(x86)%`. Bare exe basenames additionally fall back to
   * `where.exe` PATH lookup.
   */
  win?: string[]
  /**
   * Linux: names matched against (a) `PATH` via `which`, (b) common install
   * dirs like `/usr/bin`, `/snap/bin`, `/opt/<name>/...`, `~/.local/bin`,
   * and (c) desktop entries under `~/.local/share/applications`,
   * `/usr/share/applications`, and flatpak export dirs.
   */
  linux?: string[]
}

/**
 * Whether a GUI application is installed on the current platform.
 *
 * Historically `appBundleExists` only implemented macOS detection and
 * returned `true` on every other platform, so uninstalled clients looked
 * installed whenever a stale config directory remained on disk (#609).
 * This function requires explicit per-platform hints and returns `false`
 * when the current platform has no matching hint.
 */
export function appInstalled(hints: AppInstalledHints): boolean {
  const p = platform()
  if (p === 'darwin') return (hints.mac ?? []).some(macAppBundleExists)
  if (p === 'win32') return (hints.win ?? []).some(winExeExists)
  if (p === 'linux') return (hints.linux ?? []).some(linuxAppExists)
  return false
}

function macAppBundleExists(name: string): boolean {
  return (
    existsSync(join('/Applications', name)) ||
    existsSync(join(homedir(), 'Applications', name))
  )
}

function winExeExists(exe: string): boolean {
  if (isAbsolute(exe)) return existsSync(exe)
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.env.LOCALAPPDATA ?? null,
    process.env.ProgramFiles ?? null,
    process.env['ProgramFiles(x86)'] ?? null,
  ].filter((r): r is string => !!r)
  if (roots.some((root) => existsSync(join(root, exe)))) return true
  const base = exe.split(/[\\/]/).pop()
  if (base) {
    const bin = base.replace(/\.exe$/i, '')
    if (cliBinaryExists(bin)) return true
  }
  return false
}

function linuxAppExists(name: string): boolean {
  if (cliBinaryExists(name)) return true
  const home = homedir()
  const candidatePaths = [
    `/snap/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/${name}/${name}`,
    `/opt/${name}/bin/${name}`,
    join(home, '.local', 'share', 'applications', `${name}.desktop`),
    '/usr/share/applications/' + name + '.desktop',
    '/var/lib/flatpak/exports/share/applications/' + name + '.desktop',
    join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications', `${name}.desktop`),
  ]
  return candidatePaths.some(existsSync)
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
