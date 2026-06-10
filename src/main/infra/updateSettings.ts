/**
 * Persisted, channel-aware preferences for the auto-updater.
 *
 * Stored as JSON in userData (mirrors setupConfig.ts / seenServersStore.ts).
 * Only explicit user overrides are written; anything unset falls back to a
 * per-channel default:
 *   - autoDownload:      release rides updates silently (true); demo downloads
 *                        only on demand (false) but still installs once fetched.
 *   - autoInstallOnQuit: true everywhere ("update on startup" - a downloaded
 *                        update is applied on quit and live on next launch).
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { getActiveEnv } from './setupConfig'

export interface UpdateSettings {
  autoDownload: boolean
  autoInstallOnQuit: boolean
}

type StoredUpdateSettings = Partial<UpdateSettings>

function settingsPath(): string {
  return join(app.getPath('userData'), 'update-settings.json')
}

function channelDefaults(): UpdateSettings {
  return {
    autoDownload: getActiveEnv() === 'release',
    autoInstallOnQuit: true
  }
}

function readStored(): StoredUpdateSettings {
  try {
    const p = settingsPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as StoredUpdateSettings
  } catch {
    return {}
  }
}

/** Effective settings: stored overrides merged over per-channel defaults. */
export function getUpdateSettings(): UpdateSettings {
  const stored = readStored()
  const defaults = channelDefaults()
  return {
    autoDownload: stored.autoDownload ?? defaults.autoDownload,
    autoInstallOnQuit: stored.autoInstallOnQuit ?? defaults.autoInstallOnQuit
  }
}

/** Persist a partial override and return the new effective settings. */
export function setUpdateSettings(patch: StoredUpdateSettings): UpdateSettings {
  const next: StoredUpdateSettings = { ...readStored(), ...patch }
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.error('[update] failed to persist settings:', err)
  }
  return getUpdateSettings()
}
