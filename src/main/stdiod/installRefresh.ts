// Heals app-update version skew for the stdiod daemon.
//
// The daemon runs as an independent launchd unit whose plist points at the
// binary inside the app bundle. electron-updater swaps the bundle in place,
// but launchd keeps the *old* daemon process running (KeepAlive) until
// something restarts it - so after an auto-update the app would be on vN+1
// while the daemon stays on vN until the user logs out or the daemon
// crashes. On startup, when the LaunchAgent is loaded, compare the install
// stamp (app version + binary path recorded at the last successful
// `install`) and the live plist against the current bundle; on any mismatch
// re-run `edison-stdiod install`, whose bootout+bootstrap restarts the
// daemon onto the freshly shipped binary. The plist path comparison also
// heals manual app moves and stale App Translocation paths, not just
// version bumps.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

import { getStdiodBinaryPath, stdiodBinaryExists } from '../runtime/stdiodBinary'

import { install, isLaunchAgentLoaded } from './controller'
import { readInstallStamp, type StdiodInstallStamp } from './installStamp'
import { stdiodLog } from './stdiodLog'

// Written by `edison-stdiod install` - see stdiod/.../platform/macos.rs and
// LAUNCHD_LABEL in controller.ts.
const PLIST_RELATIVE_PATH = 'Library/LaunchAgents/watch.edison.stdiod.plist'

/**
 * Why the launchd unit needs a re-install, or null if it is current.
 * Pure decision logic, separated out for tests.
 */
export function computeRefreshReason(input: {
  stamp: StdiodInstallStamp | null
  appVersion: string
  binaryPath: string
  plistBody: string | null
}): string | null {
  const { stamp, appVersion, binaryPath, plistBody } = input
  if (plistBody === null) return 'LaunchAgent loaded but plist unreadable'
  if (!plistBody.includes(binaryPath)) return 'plist points at a different binary path'
  // No stamp: the daemon was installed by an app version that predates
  // stamping, so we cannot rule out skew - refresh once and stamp.
  if (!stamp) return 'no install stamp recorded'
  if (stamp.appVersion !== appVersion) {
    return `app updated ${stamp.appVersion} -> ${appVersion}`
  }
  if (stamp.binaryPath !== binaryPath) return 'bundle path changed since last install'
  return null
}

async function readPlistBody(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(os.homedir(), PLIST_RELATIVE_PATH), 'utf-8')
  } catch {
    return null
  }
}

/**
 * Re-run `edison-stdiod install` if the running launchd unit predates the
 * current app bundle. No-op unless the LaunchAgent is actually loaded.
 * Call once on startup.
 */
export async function maybeRefreshStdiodInstall(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (process.env.EDISON_DRY_RUN === '1') return
  // In dev the binary lives in the cargo target dir and never moves; only
  // packaged builds can hit update-induced skew. EW_STDIOD_REFRESH_TEST
  // mirrors EW_UPDATE_TEST for exercising this path unpackaged.
  if (!app.isPackaged && !process.env.EW_STDIOD_REFRESH_TEST) return
  if (!stdiodBinaryExists()) return
  if (!(await isLaunchAgentLoaded())) return

  const reason = computeRefreshReason({
    stamp: readInstallStamp(),
    appVersion: app.getVersion(),
    binaryPath: getStdiodBinaryPath(),
    plistBody: await readPlistBody()
  })
  if (!reason) return

  stdiodLog(`install refresh: ${reason}; re-running install to restart the daemon`)
  const result = await install()
  if (result.ok) {
    stdiodLog('install refresh: daemon restarted on current binary')
  } else {
    stdiodLog(
      `install refresh failed: ${result.errorCode ?? 'unknown'} ${result.errorMessage ?? ''}`.trim()
    )
  }
}
