// Tray/menu "Reset Local Tunnel" orchestration. Extracted from index.ts so
// the main entry stays under the project's file-size CI cap.
//
// Fully resets the local stdio tunnel daemon: confirms, tears it down
// (uninstall --purge), rebuilds it with the current credentials, then waits
// for it to actually reconnect before confirming success. This is the
// user-facing recovery for a wedged daemon - e.g. the intermittent
// `spawn EBADF` that leaves the launchd unit unloaded.

import { dialog, Notification } from 'electron'
import type { BrowserWindow } from 'electron'

import { getApiBaseUrl, getCredentialsForEnv } from '../infra/setupConfig'

import { resetStdiod } from './controller'
import { refreshStdiodStatusCache } from './trayCache'

export interface StdiodResetDeps {
  getMainWindow: () => BrowserWindow | null
  updateTrayMenu: () => void
  trayIconPath: string
}

function notify(body: string, trayIconPath: string): void {
  if (!Notification.isSupported()) return
  new Notification({
    title: 'Edison Watch',
    body,
    ...(process.platform !== 'darwin' && { icon: trayIconPath })
  }).show()
}

// Tell an open config card the daemon state changed so it refreshes now
// instead of waiting for its next poll tick.
function notifyChanged(deps: StdiodResetDeps): void {
  deps.getMainWindow()?.webContents.send('stdiod:changed')
}

// After a reset, the launchd unit is back but the daemon still has to dial
// the backend (a few seconds). Poll state.json until it reports `connected`
// so we can fire a real "reconnected" confirmation rather than an optimistic
// "reconnecting…" the instant install() returns. Refreshes the tray cache
// and nudges the card on each tick. Returns false on timeout.
async function waitForConnected(deps: StdiodResetDeps, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const status = await refreshStdiodStatusCache().catch(() => null)
    deps.updateTrayMenu()
    notifyChanged(deps)
    if (status?.state?.connection_state === 'connected') return true
  }
  return false
}

export async function handleStdiodReset(deps: StdiodResetDeps): Promise<void> {
  const { trayIconPath } = deps
  const apiBaseUrl = getApiBaseUrl()
  const creds = getCredentialsForEnv()
  if (!apiBaseUrl || !creds?.apiKey) {
    notify('Sign in to Edison Watch before resetting the local tunnel.', trayIconPath)
    return
  }

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['Reset', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Reset Local Tunnel',
    message: 'Reset the local stdio tunnel daemon?',
    detail:
      'This stops the daemon, wipes its local config, state, and logs, then ' +
      're-registers and restarts it with your current credentials. Tunneled ' +
      'servers reconnect automatically. Use this if the tunnel is stuck or ' +
      'failed to start.'
  })
  if (choice !== 0) return

  notify('Resetting local tunnel…', trayIconPath)
  // Let an open config card show a "Resetting…" state for the whole
  // teardown+rebuild+reconnect window (otherwise it's invisible to a 3s poll).
  deps.getMainWindow()?.webContents.send('stdiod:resetting')
  try {
    const result = await resetStdiod({
      backend: apiBaseUrl,
      apiKey: creds.apiKey,
      edisonSecretKey: creds.edisonSecretKey
    })
    await refreshStdiodStatusCache().catch(() => {})
    deps.updateTrayMenu()
    notifyChanged(deps)
    if (!result.ok) {
      notify(
        `Local tunnel reset failed: ${result.errorMessage ?? result.errorCode ?? 'unknown error'}`,
        trayIconPath
      )
      return
    }
    // Wait for the daemon to actually reconnect before confirming, so the
    // user gets a real success signal (not just "reconnecting…").
    const connected = await waitForConnected(deps, 25_000)
    notify(
      connected
        ? 'Local tunnel reconnected.'
        : 'Local tunnel reset. Still reconnecting in the background…',
      trayIconPath
    )
  } catch (err) {
    notifyChanged(deps)
    notify(
      `Local tunnel reset failed: ${err instanceof Error ? err.message : String(err)}`,
      trayIconPath
    )
  }
}
