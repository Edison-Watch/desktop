// Main-process controller for the bundled detector daemon.
//
// Like stdiod/controller.ts, this only orchestrates one-shot CLI subcommands
// (`service install|uninstall|status`). The LaunchAgent registered by
// `edison-detectord service install` is what actually keeps the daemon running;
// live operations go through the socket (see socket.ts), not this controller.

import { spawn } from 'node:child_process'

import { detectordBinaryExists, getDetectordBinaryPath } from './binary'

export interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  socket: string
}

// EDISON_DRY_RUN (Playwright/Storybook) short-circuits subprocess calls so test
// runs don't touch launchctl on the host, matching stdiod's controller.
function dryRun(): boolean {
  return process.env.EDISON_DRY_RUN === '1'
}

function runDetectord(args: string[]): Promise<SpawnResult> {
  const binary = getDetectordBinaryPath()
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** True once `scripts/build-detectord.sh` (or a dev `cargo build`) has run. */
export function detectordAvailable(): boolean {
  return detectordBinaryExists()
}

/**
 * Install + start the LaunchAgent. `enforce=false` (default) runs the daemon
 * report-only: safe for first install; flip to true once wired up and trusted.
 */
export async function installService(enforce = false): Promise<SpawnResult> {
  if (dryRun()) return { code: 0, stdout: '', stderr: '' }
  const args = ['service', 'install']
  if (enforce) args.push('--enforce')
  return runDetectord(args)
}

export async function uninstallService(opts?: { purge?: boolean }): Promise<SpawnResult> {
  if (dryRun()) return { code: 0, stdout: '', stderr: '' }
  const args = ['service', 'uninstall']
  if (opts?.purge) args.push('--purge')
  return runDetectord(args)
}

export async function serviceStatus(): Promise<ServiceStatus> {
  if (dryRun() || !detectordBinaryExists()) {
    return { installed: false, running: false, socket: '' }
  }
  const { stdout } = await runDetectord(['service', 'status'])
  const field = (k: string): string => stdout.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
  return {
    installed: field('installed') === 'true',
    running: field('running') === 'true',
    socket: field('socket')
  }
}
