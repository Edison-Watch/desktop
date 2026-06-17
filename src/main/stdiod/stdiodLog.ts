// Persistent client-side log for the stdiod *controller* (the Electron
// main process), distinct from the Rust daemon's own daemon.log.
//
// Why this exists: every install/login/uninstall/reset spawn used to
// vanish into a string returned to the renderer. When a spawn fails with
// a low-level errno (the intermittent `spawn EBADF` some users hit) there
// was no durable trace to diagnose after the fact. This writes a
// timestamped line to a file next to daemon.log so the tray's "Open logs
// folder" action surfaces both, and so the next occurrence is debuggable.
//
// Best-effort: a logging failure must never break the controller. The
// directory is (re)created on every write because `uninstall --purge`
// deletes the whole log dir out from under us during a reset.

import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Co-located with the daemon log (see controller.getLogPath) so a single
// folder holds the full picture: what the controller asked for (client.log)
// and what the daemon did about it (daemon.log).
export function getClientLogPath(): string {
  // Mirrors the daemon log dir (controller.getLogPath): ~/Library/Logs on macOS,
  // ~/.local/state on Windows (no XDG state dir there).
  const dir =
    process.platform === 'win32'
      ? path.join(os.homedir(), '.local', 'state', 'edison-stdiod')
      : path.join(os.homedir(), 'Library', 'Logs', 'edison-stdiod')
  return path.join(dir, 'client.log')
}

export function stdiodLog(msg: string): void {
  const line = `[${new Date().toISOString()}] [stdiod] ${msg}\n`
  try {
    const filePath = getClientLogPath()
    mkdirSync(path.dirname(filePath), { recursive: true })
    appendFileSync(filePath, line)
  } catch {
    // never break the controller on a logging failure
  }
  // Tee to console so it also lands in the dev terminal during `npm run dev`.
  console.log(`[stdiod] ${msg}`)
}
