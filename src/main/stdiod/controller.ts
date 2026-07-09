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

import { execFileSync, spawn } from 'node:child_process'
import { promises as fs, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getStdiodBinaryPath, stdiodBinaryExists } from '../runtime/stdiodBinary'

import { writeInstallStamp } from './installStamp'
import { configFileExists, readStateFile } from './state'
import { stdiodLog } from './stdiodLog'
import type { StdiodErrorCode, StdiodLoginInput, StdiodResult, StdiodStatus } from './types'

// LaunchAgent label matches stdiod/crates/edison-stdiod/src/platform/macos.rs.
// Hardcoded so we can ask launchctl directly without spawning the daemon
// binary just to read a string.
const LAUNCHD_LABEL = 'watch.edison.stdiod'
// systemd user unit name matches stdiod/crates/edison-stdiod/src/platform/linux.rs
// (UNIT_NAME). Used to query `systemctl --user is-active` directly.
const SYSTEMD_UNIT = 'edison-stdiod.service'
// Scheduled Task name matches platform/windows.rs task_name(): the base name
// plus the current user's SID, so accounts on a shared machine don't collide.
// Derived once (the user is fixed for the process) and cached; falls back to the
// bare base name if the SID can't be resolved - matching the daemon's fallback.
const WIN_TASK_BASENAME = 'Edison Watch stdiod'
let cachedWinTaskName: string | null = null

function winTaskName(): string {
  if (cachedWinTaskName) return cachedWinTaskName
  let name = WIN_TASK_BASENAME
  try {
    // `whoami /user /fo csv /nh` -> "DOMAIN\user","S-1-5-21-..."; take the SID.
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true
    }).toString()
    const sid = out.trim().split(',').pop()?.trim().replace(/^"|"$/g, '')
    if (sid && sid.startsWith('S-')) name = `${WIN_TASK_BASENAME} ${sid}`
  } catch {
    // keep the bare base name
  }
  cachedWinTaskName = name
  return name
}

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
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

// A snapshot of file-descriptor pressure, logged alongside a spawn
// failure. `spawn EBADF` is, in practice, almost always fd exhaustion:
// launchd-launched GUI apps on macOS start with a low soft RLIMIT_NOFILE
// (historically 256), and a slow fd leak elsewhere in the app eventually
// makes *every* spawn - including the stdiod one - fail with EBADF. A
// count near the limit in the log is the tell-tale. Best-effort: returns
// null if /dev/fd isn't readable.
function fdDiagnostics(): string | null {
  try {
    const openFds = readdirSync('/dev/fd').length
    return `openFds=${openFds}`
  } catch {
    return null
  }
}

// Turn a thrown spawn error into a typed result with a message rich enough
// to diagnose later: the errno code (e.g. EBADF), the failing syscall, and
// the fd snapshot. Also writes the same detail to client.log so there's a
// durable trace even though the renderer only shows a short hint.
function describeSpawnError(op: string, err: unknown): StdiodResult {
  const e = err as NodeJS.ErrnoException
  const parts: string[] = []
  if (e?.code) parts.push(e.code)
  if (e?.syscall) parts.push(`syscall=${e.syscall}`)
  const fds = fdDiagnostics()
  if (fds) parts.push(fds)
  const detail = parts.length ? ` (${parts.join(', ')})` : ''
  const message = `${e?.message ?? String(err)}${detail}`
  stdiodLog(`${op}: spawn failed: ${message}`)
  return { ok: false, errorCode: 'spawn_failed', errorMessage: message }
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
export async function isLaunchAgentLoaded(): Promise<boolean> {
  const now = Date.now()
  if (cachedInstalled && now - cachedInstalled.at < INSTALLED_CACHE_TTL_MS) {
    return cachedInstalled.value
  }
  const value = await new Promise<boolean>((resolve) => {
    if (process.platform === 'win32') {
      // `schtasks /query /tn <name>` exits 0 if the task exists.
      const child = spawn('schtasks', ['/query', '/tn', winTaskName()], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true
      })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
      return
    }
    if (process.platform === 'linux') {
      // `is-enabled` (registration), not `is-active` (runtime), to match the
      // macOS launchctl / Windows schtasks checks - so a restarting daemon
      // still reports installed. Live health comes from state.json separately.
      const child = spawn('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT], {
        stdio: ['ignore', 'ignore', 'ignore']
      })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
      return
    }
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
    const path = getStdiodBinaryPath()
    stdiodLog(`binary missing at ${path}`)
    return {
      ok: false,
      errorCode: 'binary_missing',
      errorMessage: `edison-stdiod binary not found at ${path}`
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
  stdiodLog(`install: binary=${getStdiodBinaryPath()}`)
  try {
    const result = await runStdiod(['install'])
    stdiodLog(
      `install: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ''}`
    )
    if (result.code === 0) {
      // Record what was installed so installRefresh.ts can detect a stale
      // launchd unit after the next app auto-update or bundle move.
      writeInstallStamp()
      return { ok: true }
    }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return describeSpawnError('install', err)
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
  // Never log args: they carry the api key + edison_secret_key. Log only
  // the non-secret shape so client.log stays safe to share.
  stdiodLog(`login: backend=${input.backend} deviceId=${input.deviceId ?? '(default)'}`)
  try {
    const result = await runStdiod(args)
    stdiodLog(
      `login: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ''}`
    )
    if (result.code === 0) return { ok: true }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return describeSpawnError('login', err)
  }
}

export async function uninstall(opts: { purge?: boolean } = {}): Promise<StdiodResult> {
  if (dryRun()) return { ok: true }
  const missing = await ensureBinary()
  if (missing) return missing
  invalidateInstalledCache()
  const args = ['uninstall']
  if (opts.purge) args.push('--purge')
  stdiodLog(`uninstall: purge=${Boolean(opts.purge)}`)
  try {
    const result = await runStdiod(args)
    stdiodLog(
      `uninstall: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ''}`
    )
    if (result.code === 0) return { ok: true }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    }
  } catch (err) {
    return describeSpawnError('uninstall', err)
  }
}

// Full reset of the local tunnel: tear the daemon down completely (stop
// the launchd unit, wipe config.toml, state.json, and logs), then rebuild
// it from scratch with the current credentials. This is the heavy-hammer
// recovery for a wedged or half-installed daemon - e.g. a `spawn EBADF`
// that left the unit unloaded, or a stale state.json the tray keeps
// reporting from a dead supervisor.
//
// Device identity is preserved across the purge: we read the existing
// device_id/device_label from state.json first and re-supply them to
// `login`, so the dashboard keeps the same device entry instead of
// registering a fresh one. (The daemon would otherwise fall back to the
// machine hostname, which is usually - but not always - the same value.)
export async function resetStdiod(input: StdiodLoginInput): Promise<StdiodResult> {
  if (dryRun()) return { ok: true }
  const missing = await ensureBinary()
  if (missing) return missing

  const { state } = await readStateFile()
  const deviceId = input.deviceId ?? state?.device_id ?? undefined
  const deviceLabel = input.deviceLabel ?? state?.device_label ?? undefined
  stdiodLog(`reset: starting (preserving deviceId=${deviceId ?? '(default)'})`)

  // 1. Stop + wipe everything stdiod-related. --purge also deletes the log
  //    dir, so any client.log lines above are lost; the steps below run
  //    after the purge and re-create the file, capturing the reset outcome.
  const torn = await uninstall({ purge: true })
  if (!torn.ok) {
    stdiodLog(`reset: teardown failed: ${torn.errorCode ?? ''} ${torn.errorMessage ?? ''}`)
    return torn
  }

  // 2. Re-write config.toml with current credentials + the prior identity.
  const signedIn = await login({ ...input, deviceId, deviceLabel })
  if (!signedIn.ok) {
    stdiodLog(`reset: login failed: ${signedIn.errorCode ?? ''} ${signedIn.errorMessage ?? ''}`)
    return signedIn
  }

  // 3. Re-register + (re)start the launchd unit.
  const installed = await install()
  if (!installed.ok) {
    stdiodLog(`reset: install failed: ${installed.errorCode ?? ''} ${installed.errorMessage ?? ''}`)
    return installed
  }

  invalidateInstalledCache()
  stdiodLog('reset: complete')
  return { ok: true }
}

// Tail of the daemon log, surfaced in the tray "View logs" action. We
// resolve the path through the binary's own `logs --path` rather than
// reimplementing the per-platform layout in TS so the source of truth
// stays in one place. Returns null if no log exists yet.
export async function getLogPath(): Promise<string | null> {
  if (dryRun()) return null
  // Matches paths::daemon_log_file() in the daemon: macOS uses ~/Library/Logs;
  // Windows has no XDG state dir so it falls back to ~/.local/state.
  const logPath =
    process.platform === 'win32'
      ? join(homedir(), '.local', 'state', 'edison-stdiod', 'daemon.log')
      : `${process.env.HOME}/Library/Logs/edison-stdiod/daemon.log`
  try {
    await fs.access(logPath)
    return logPath
  } catch {
    return null
  }
}
