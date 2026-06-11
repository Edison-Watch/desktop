/**
 * Records which app version + binary path last ran a successful
 * `edison-stdiod install`, so startup can detect when the daemon launchd
 * unit is stale (app auto-updated, bundle moved) and needs a re-install.
 *
 * Stored as JSON in userData (mirrors updateSettings.ts). Written by
 * controller.install() on success; read by installRefresh.ts on startup.
 */

import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

import { getStdiodBinaryPath } from '../runtime/stdiodBinary'

export interface StdiodInstallStamp {
  /** app.getVersion() at the time install succeeded. */
  appVersion: string
  /** Bundled daemon binary path the launchd plist was written for. */
  binaryPath: string
}

function stampPath(): string {
  return join(app.getPath('userData'), 'stdiod-install-stamp.json')
}

export function readInstallStamp(): StdiodInstallStamp | null {
  try {
    const p = stampPath()
    if (!existsSync(p)) return null
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<StdiodInstallStamp>
    if (typeof parsed.appVersion !== 'string' || typeof parsed.binaryPath !== 'string') {
      return null
    }
    return { appVersion: parsed.appVersion, binaryPath: parsed.binaryPath }
  } catch {
    return null
  }
}

export function writeInstallStamp(): void {
  const stamp: StdiodInstallStamp = {
    appVersion: app.getVersion(),
    binaryPath: getStdiodBinaryPath()
  }
  try {
    writeFileSync(stampPath(), JSON.stringify(stamp, null, 2), 'utf-8')
  } catch (err) {
    console.error('[stdiod] failed to persist install stamp:', err)
  }
}
