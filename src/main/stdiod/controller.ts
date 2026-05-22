// Main-process controller for the bundled edison-stdiod daemon.
//
// Responsibilities:
//   - spawn the daemon binary for one-shot operations (install, login,
//     uninstall) and capture stdout/stderr/exit code
//   - read state.json directly for live status (no subprocess)
//   - return typed results so the renderer can map errors to UX
//
// The daemon binary is bundled by client_2/scripts/build-stdiod.sh and
// resolved by getStdiodBinaryPath(). The launchd unit (registered by
// `edison-stdiod install`) is what actually keeps the daemon running -
// this controller only orchestrates the one-shot CLI subcommands.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'

import { getStdiodBinaryPath, stdiodBinaryExists } from '../runtime/stdiodBinary'

import { configFileExists, readStateFile } from './state'
import type { StdiodErrorCode, StdiodLoginInput, StdiodResult, StdiodStatus } from './types'

// LaunchAgent label matches stdiod/crates/edison-stdiod/src/platform/macos.rs.
// Hardcoded so we can ask launchctl directly without spawning the daemon
// binary just to read a string.
const LAUNCHD_LABEL = 'watch.edison.stdiod'

let cachedInstalled: { value: boolean; at: number } | null = null
const INSTALLED_CACHE_TTL_MS = 5_000

// EDISON_DRY_RUN is set by Playwright/Storybook/etc. - short-circuit
// every subprocess call so test runs don't actually touch launchctl or
// write config.toml on the host. Status reads still go through (they
// return null gracefully if no state.json exists).
function dryRun(): boolean {
  return process.env.EDISON_DRY_RUN === '1'
}

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

async function runStdiod(args: string[]): Promise<SpawnResult> {
  const binary = getStdiodBinaryPath()
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function classifyError(stderr: string): StdiodErrorCode {
  const s = stderr.toLowerCase()
  if (s.includes('permission denied') || s.includes('eacces')) {
    return 'permission_denied'
  }
  if (s.includes('not installed')) return 'not_installed'
  if (s.includes('missing api key') || s.includes('missing backend url')) {
    return 'not_logged_in'
  }
  return 'unknown'
}

// Authoritative check: ask launchctl whether the per-user LaunchAgent
// is loaded. Cached for INSTALLED_CACHE_TTL_MS so the 3s poller doesn't
// hammer it. Invalidated explicitly after install/uninstall calls so
// the UI reflects the change immediately instead of waiting for the
// next cache window.
async function isLaunchAgentLoaded(): Promise<boolean> {
  const now = Date.now()
  if (cachedInstalled && now - cachedInstalled.at < INSTALLED_CACHE_TTL_MS) {
    return cachedInstalled.value
  }
  const value = await new Promise<boolean>((resolve) => {
    const uid = process.getuid?.() ?? -1
    if (uid < 0) {
      resolve(false)
      return
    }
    // `launchctl print gui/$UID/<label>` exits 0 if loaded, non-zero
    // otherwise. Single cheap spawn - milliseconds.
    const child = spawn('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
  cachedInstalled = { value, at: Date.now() }
  return value
}

function invalidateInstalledCache(): void {
  cachedInstalled = null
}

async function ensureBinary(): Promise<StdiodResult | null> {
  if (!stdiodBinaryExists()) {
    return {
      ok: false,
      errorCode: 'binary_missing',
      errorMessage: `edison-stdiod binary not found at ${getStdiodBinaryPath()}`
    }
  }
  return null
}

export async function getStatus(): Promise<StdiodStatus> {
  if (dryRun()) {
    return {
      binaryAvailable: true,
      installed: false,
      loggedIn: false,
      state: null,
      stateAgeMs: null
    }
  }
  const binaryAvailable = stdiodBinaryExists()
  const loggedIn = await configFileExists()
  const { state, ageMs } = await readStateFile()
  // Authoritative "is the daemon registered with launchd right now":
  // loggedIn (config.toml present) is sticky after uninstall because we
  // keep credentials around for a one-click re-enable, and state.json
  // can briefly disappear between sleep/wake cycles. Ask launchctl
  // directly - see isLaunchAgentLoaded() for cache details.
  const installed = await isLaunchAgentLoaded()
  return { binaryAvailable, installed, loggedIn, state, stateAgeMs: ageMs }
}

export async function install(): Promise<StdiodResult> {
  if (dryRun()) return { ok: true }
  const missing = await ensureBinary()
  if (missing) return missing
  invalidateInstalledCache()
  try {
    const result = await runStdiod(['install'])
    if (result.code === 0) return { ok: true }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'spawn_failed',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function login(input: StdiodLoginInput): Promise<StdiodResult> {
  if (dryRun()) return { ok: true }
  const missing = await ensureBinary()
  if (missing) return missing
  // The daemon's `login` subcommand takes secrets via flags. argv is
  // observable via `ps`; v1 accepts that tradeoff because the alternative
  // (stdin) requires a daemon-side change and the window is short-lived.
  // A future hardening item is to teach the daemon to read from stdin.
  const args = ['login', '--backend', input.backend, '--api-key', input.apiKey]
  if (input.edisonSecretKey) args.push('--edison-secret-key', input.edisonSecretKey)
  if (input.deviceId) args.push('--device-id', input.deviceId)
  if (input.deviceLabel) args.push('--device-label', input.deviceLabel)
  try {
    const result = await runStdiod(args)
    if (result.code === 0) return { ok: true }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'spawn_failed',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function uninstall(opts: { purge?: boolean } = {}): Promise<StdiodResult> {
  if (dryRun()) return { ok: true }
  const missing = await ensureBinary()
  if (missing) return missing
  invalidateInstalledCache()
  const args = ['uninstall']
  if (opts.purge) args.push('--purge')
  try {
    const result = await runStdiod(args)
    if (result.code === 0) return { ok: true }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return {
      ok: false,
      errorCode: 'spawn_failed',
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

// Tail of the daemon log, surfaced in the tray "View logs" action. We
// resolve the path through the binary's own `logs --path` rather than
// reimplementing the per-platform layout in TS so the source of truth
// stays in one place. Returns null if no log exists yet.
export async function getLogPath(): Promise<string | null> {
  if (dryRun()) return null
  const macLog = `${process.env.HOME}/Library/Logs/edison-stdiod/daemon.log`
  try {
    await fs.access(macLog)
    return macLog
  } catch {
    return null
  }
}
