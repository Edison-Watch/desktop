import { describe, it, expect } from 'vitest'
import { platform } from 'os'
import { appInstalled } from '../clients/shared'

describe('appInstalled (#609)', () => {
  it('returns false when no hints are provided', () => {
    // Pre-fix, appBundleExists([]) returned true on Linux/Windows regardless
    // of whether the app was installed, causing stale config directories to
    // make uninstalled clients look installed.
    expect(appInstalled({})).toBe(false)
  })

  it('returns false on the current platform when hints only cover other platforms', () => {
    const current = platform()
    const hints =
      current === 'darwin'
        ? { win: ['C:\\nope\\nope.exe'], linux: ['__definitely_not_a_binary__'] }
        : current === 'win32'
          ? { mac: ['NotAnApp.app'], linux: ['__definitely_not_a_binary__'] }
          : { mac: ['NotAnApp.app'], win: ['C:\\nope\\nope.exe'] }
    expect(appInstalled(hints)).toBe(false)
  })

  it('returns false for a clearly-nonexistent binary on the current platform', () => {
    const hints = {
      mac: ['__edison_watch_nonexistent.app'],
      win: ['__edison_watch_nonexistent\\nope.exe'],
      linux: ['__edison_watch_nonexistent_binary_xyz'],
    }
    expect(appInstalled(hints)).toBe(false)
  })
})
