// Read the daemon's atomically-written state.json without spawning a
// subprocess. This is the cheap path the tray uses to poll live status.
//
// The daemon (see stdiod/crates/edison-stdiod/src/state.rs) rewrites
// the file on every connection-state transition and every child spawn /
// death, using write-then-rename so a reader never observes a torn file.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { StdiodLiveState } from './types'

// Mirrors crate::paths::state_file - kept hardcoded rather than spawned
// from `edison-stdiod` so polling stays subprocess-free.
export function getStateFilePath(): string {
  return path.join(os.homedir(), '.config', 'edison-stdiod', 'state.json')
}

export function getConfigFilePath(): string {
  return path.join(os.homedir(), '.config', 'edison-stdiod', 'config.toml')
}

export interface StateFileSnapshot {
  state: StdiodLiveState | null
  ageMs: number | null
}

export async function readStateFile(): Promise<StateFileSnapshot> {
  const filePath = getStateFilePath()
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: null, ageMs: null }
    }
    throw err
  }
  const raw = await fs.readFile(filePath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as StdiodLiveState
    return { state: parsed, ageMs: Date.now() - stat.mtimeMs }
  } catch {
    // A torn read shouldn't happen given the daemon's atomic rename, but
    // a half-written file from a non-daemon writer (or a corrupted disk)
    // shouldn't bring down the tray.
    return { state: null, ageMs: null }
  }
}

export async function configFileExists(): Promise<boolean> {
  try {
    await fs.access(getConfigFilePath())
    return true
  } catch {
    return false
  }
}
