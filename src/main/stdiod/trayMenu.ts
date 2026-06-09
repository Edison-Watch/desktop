// Build the "Local tunnel" subsection of the tray menu. Extracted from
// index.ts so the main entry stays under the project's file-size CI cap.

import { clipboard, Notification, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

import { getCachedStdiodStatus } from './trayCache'

const CONNECTION_LABELS: Record<string, string> = {
  starting: 'starting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  needs_reauth: 'needs reauth (Sign In)',
  needs_upgrade: 'needs upgrade (update Edison Watch)'
}

export function buildStdiodMenuItems(
  trayIconPath: string,
  onReset?: () => void
): MenuItemConstructorOptions[] {
  const status = getCachedStdiodStatus()
  const items: MenuItemConstructorOptions[] = []

  if (!status.binaryAvailable) {
    items.push({ label: 'Local tunnel: binary missing', enabled: false })
    return items
  }

  // Shared "View logs / Reset" footer, appended to whichever status branch
  // we end up in. Reset is the heavy-hammer recovery, so it's offered
  // whenever there's anything to reset (signed in or running) - including
  // the "off" branch below, where a wedged half-install is exactly the
  // case a reset is meant to clear.
  const buildActions = (): MenuItemConstructorOptions[] => {
    const actions: MenuItemConstructorOptions[] = [
      {
        label: 'Open logs folder',
        click: () => {
          const logDir = `${process.env.HOME}/Library/Logs/edison-stdiod`
          shell.openPath(logDir).catch(() => {})
        }
      }
    ]
    if (onReset && (status.installed || status.loggedIn)) {
      actions.push({ label: 'Reset Local Tunnel…', click: onReset })
    }
    return actions
  }

  // installed (launchctl) is the source of truth for "is the daemon on".
  // loggedIn (config.toml present) is sticky across Disable so re-enable is
  // one click - checking it first would mislead users into seeing
  // "starting" forever after they toggled the daemon off.
  if (!status.installed) {
    items.push({
      label: status.loggedIn ? 'Local tunnel: off' : 'Local tunnel: not signed in',
      enabled: false
    })
    if (status.loggedIn) items.push(...buildActions())
    return items
  }

  const conn = status.state?.connection_state ?? 'starting'
  items.push({
    label: `Local tunnel: ${CONNECTION_LABELS[conn] ?? conn}`,
    enabled: false
  })

  if (status.state?.device_id) {
    const deviceId = status.state.device_id
    const label = status.state.device_label
      ? `${deviceId} (${status.state.device_label})`
      : deviceId
    items.push({
      label: `Device: ${label}`,
      click: () => {
        clipboard.writeText(deviceId)
        if (Notification.isSupported()) {
          new Notification({
            title: 'Edison Watch',
            body: 'Device ID copied to clipboard',
            ...(process.platform !== 'darwin' && { icon: trayIconPath })
          }).show()
        }
      }
    })
  }

  const servers = status.state?.servers ?? []
  if (servers.length > 0) {
    const running = servers.filter((s) => s.state === 'running').length
    items.push({
      label: `Tunneled servers: ${running}/${servers.length} running`,
      enabled: false
    })
  }

  if (status.state?.last_error) {
    items.push({ label: `Last error: ${status.state.last_error}`, enabled: false })
  }

  items.push(...buildActions())

  return items
}
