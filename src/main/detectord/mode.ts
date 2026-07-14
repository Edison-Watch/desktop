// The single cutover switch.
//
//   primary: the detector daemon owns install + hooks + quarantine (runs
//              --enforce, enrolls install:true); the TS pipeline stands down.
//   shadow: the daemon runs detect-only + logs; the TS pipeline stays primary.
//
// Reversible at any time: set EW_DETECTORD_PRIMARY=0 (or false/off) to fall back
// to the TS pipeline, then restart the app. Default is primary (cutover active).

export function detectordPrimary(): boolean {
  // The daemon ships for macOS (launchd), Windows (Task Scheduler), and Linux
  // (systemd user service). Other platforms have no supervisor integration, so
  // the TS pipeline stays primary there.
  if (
    process.platform !== 'darwin' &&
    process.platform !== 'win32' &&
    process.platform !== 'linux'
  ) {
    return false
  }
  const v = (process.env.EW_DETECTORD_PRIMARY ?? '').toLowerCase()
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return true
}
