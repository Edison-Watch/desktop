import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

// Self-install a freedesktop `.desktop` entry + icon for the AppImage so GNOME
// (and other shells) show the Edison icon in the dock/taskbar and can pin the
// app. An AppImage is a single file with no installed metadata, so without this
// the running window falls back to the generic icon and isn't pinnable.
//
// GNOME maps a *running* window to a desktop entry by matching the window's
// X11 WM_CLASS against the entry's StartupWMClass. Electron sets WM_CLASS from
// app.getName() on Linux, so we use that same value here - guaranteeing the
// match without hardcoding a guess.
//
// Best-effort and idempotent: the dock icon is cosmetic, so any failure is
// swallowed. Only runs for the packaged AppImage (APPIMAGE is set by the
// AppImage runtime); skipped in dev and for extracted/--appimage-extract runs
// where there's no stable launcher path to point Exec at.
export function integrateDesktopEntry(iconSourcePath: string): void {
  if (process.platform !== 'linux' || !app.isPackaged) return
  const appImagePath = process.env.APPIMAGE
  if (!appImagePath || !existsSync(appImagePath)) return

  try {
    const home = os.homedir()

    // Stable icon location (absolute Icon= avoids depending on an icon-theme
    // cache refresh).
    const dataDir = path.join(home, '.local', 'share', 'edison-watch')
    mkdirSync(dataDir, { recursive: true })
    const iconDest = path.join(dataDir, 'icon.png')
    copyFileSync(iconSourcePath, iconDest)

    const appsDir = path.join(home, '.local', 'share', 'applications')
    mkdirSync(appsDir, { recursive: true })
    const desktop =
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Edison Watch',
        // Quote the AppImage path (it can contain spaces); %U lets the app
        // receive edison-watch:// callback URLs via the desktop entry.
        `Exec="${appImagePath}" %U`,
        `Icon=${iconDest}`,
        'Terminal=false',
        'Categories=Development;Utility;',
        `StartupWMClass=${app.getName()}`,
        // Register the custom protocol so the SSO callback can route here.
        'MimeType=x-scheme-handler/edison-watch;',
        // Tell appimaged not to also auto-integrate (avoids a duplicate entry).
        'X-AppImage-Integrate=false'
      ].join('\n') + '\n'
    writeFileSync(path.join(appsDir, 'edison-watch.desktop'), desktop, { mode: 0o644 })
  } catch {
    // Cosmetic; never block startup on it.
  }
}
