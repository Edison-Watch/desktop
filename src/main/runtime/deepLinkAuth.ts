/**
 * Single-instance lock + `edison-watch://` deep-link auth-callback wiring.
 *
 * Extracted from index.ts (800-line CI limit). The renderer receives SSO/OAuth
 * callbacks either via the loopback server (authLoopbackServer) or, as a
 * fallback, via the custom protocol delivered here: macOS uses 'open-url';
 * Windows/Linux relaunch the app, so the single-instance lock routes the URL to
 * 'second-instance' (or it arrives in argv on a cold start).
 */

import { app, BrowserWindow, Menu, ipcMain } from 'electron'

// Buffers a callback that arrives before the renderer listener is live (cold
// start, window loading/closed-to-tray); renderer also pulls via 'consumePending'.
let pendingAuthCallbackUrl: string | undefined
let getMainWindow: () => BrowserWindow | null = () => null
let log: (msg: string) => void = () => {}

/** Forward an auth callback to the renderer, buffering it if the page isn't ready. */
export function deliverAuthCallback(url: string, source: string): void {
  log(`auth:callback from ${source}`)
  pendingAuthCallbackUrl = url
  const wc = getMainWindow()?.webContents
  if (wc && !wc.isLoading()) {
    wc.send('auth:callback', url)
  } else {
    log(`auth:callback buffered (window ${wc ? 'loading' : 'absent'}) - renderer will pull on mount`)
  }
}

/** Push any buffered callback once the page has loaded (did-finish-load). */
export function flushBufferedAuthCallback(): void {
  if (!pendingAuthCallbackUrl) return
  log('did-finish-load: pushing buffered auth callback')
  getMainWindow()?.webContents.send('auth:callback', pendingAuthCallbackUrl)
}

/**
 * Acquire the single-instance lock and wire the deep-link handlers. Returns false
 * for a doomed second instance (lock not acquired) - the caller must not build a
 * window in that case.
 */
export function initDeepLinkAuth(deps: {
  getMainWindow: () => BrowserWindow | null
  showMainWindow: () => void
  log: (msg: string) => void
}): boolean {
  getMainWindow = deps.getMainWindow
  const showMainWindow = deps.showMainWindow
  log = deps.log

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  // Renderer pulls a buffered callback on mount; clears it so it is not re-run.
  ipcMain.handle('auth:consumePending', () => {
    const url = pendingAuthCallbackUrl
    pendingAuthCallbackUrl = undefined
    if (url) log('auth:consumePending -> delivering buffered callback')
    return url ?? null
  })

  // Drop any buffered callback when the user cancels, so a late callback can't be
  // re-pushed (did-finish-load) or replayed (consumePending) after Cancel.
  ipcMain.handle('auth:clearPending', () => {
    if (pendingAuthCallbackUrl) log('auth:clearPending -> dropping buffered callback')
    pendingAuthCallbackUrl = undefined
  })

  // Windows: renderer requests the app menu as a popup on body right-click (the
  // Alt-toggled menu bar is unreachable in some VMs).
  ipcMain.handle('menu:popupApp', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) Menu.getApplicationMenu()?.popup({ window: win })
  })

  // Cold start via protocol (Win/Linux): the URL is in argv, not 'open-url'.
  if (process.platform !== 'darwin') {
    const argvUrl = process.argv.find((arg) => arg.startsWith('edison-watch://'))
    if (argvUrl) {
      log('cold-start deep link found in argv')
      pendingAuthCallbackUrl = argvUrl
    }
  }

  app.on('open-url', (_event, url) => {
    if (url.startsWith('edison-watch://')) deliverAuthCallback(url, 'open-url')
  })

  app.on('second-instance', (_event, commandLine) => {
    // Relaunching while the app lives in the tray: reopen the GUI, recreating the
    // window if it was destroyed on close (showMainWindow handles both cases).
    showMainWindow()
    const url = commandLine.find((arg) => arg.startsWith('edison-watch://'))
    if (url) deliverAuthCallback(url, 'second-instance')
    else log('second-instance fired with no edison-watch:// url in argv')
  })

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('edison-watch', process.execPath, [process.argv[1]!])
    }
  } else {
    app.setAsDefaultProtocolClient('edison-watch')
  }

  return gotLock
}
