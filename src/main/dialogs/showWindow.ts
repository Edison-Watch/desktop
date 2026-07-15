import { BrowserWindow } from 'electron'

/**
 * Show an initially hidden (`show: false`) BrowserWindow once its content is
 * ready.
 *
 * Uses `ready-to-show` for anti-flash timing on macOS/Windows, plus a
 * Linux-only `did-finish-load` fallback: on Linux `ready-to-show` is unreliable
 * and may never fire, which would leave a `show: false` window hidden forever
 * (the window and its logic run, but nothing appears). Mirrors the main
 * window's handling in index.ts.
 *
 * Both listeners are `once` and guard `isDestroyed()`. Intended for windows that
 * load their content ONCE and don't navigate/reload (our data: URL dialogs); on
 * a reload-heavy window the `did-finish-load` fallback could re-show a window
 * the user had hidden.
 */
export function showWhenReady(win: BrowserWindow): void {
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  if (process.platform === 'linux') {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.show()
    })
  }
}
