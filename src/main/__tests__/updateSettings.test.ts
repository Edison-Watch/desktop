import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Each test gets a throwaway userData dir so the JSON store is isolated.
let userDataDir: string
let activeEnv = 'demo'

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => userDataDir }
}))

vi.mock('../infra/setupConfig', () => ({
  getActiveEnv: () => activeEnv
}))

import { getUpdateSettings, setUpdateSettings } from '../infra/updateSettings'

describe('updateSettings', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'ew-update-settings-'))
    activeEnv = 'demo'
  })
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('defaults autoDownload off for demo, on for release', () => {
    activeEnv = 'demo'
    expect(getUpdateSettings().autoDownload).toBe(false)
    activeEnv = 'release'
    expect(getUpdateSettings().autoDownload).toBe(true)
  })

  it('defaults autoInstallOnQuit on for every channel', () => {
    activeEnv = 'demo'
    expect(getUpdateSettings().autoInstallOnQuit).toBe(true)
    activeEnv = 'release'
    expect(getUpdateSettings().autoInstallOnQuit).toBe(true)
  })

  it('persists an explicit override over the channel default', () => {
    activeEnv = 'demo'
    const next = setUpdateSettings({ autoDownload: true })
    expect(next.autoDownload).toBe(true)
    expect(getUpdateSettings().autoDownload).toBe(true)
  })

  it('keeps an explicit override even when it matches no default', () => {
    activeEnv = 'release'
    setUpdateSettings({ autoDownload: false })
    expect(getUpdateSettings().autoDownload).toBe(false)
  })

  it('merges partial updates without dropping prior overrides', () => {
    setUpdateSettings({ autoDownload: true })
    setUpdateSettings({ autoInstallOnQuit: false })
    const s = getUpdateSettings()
    expect(s.autoDownload).toBe(true)
    expect(s.autoInstallOnQuit).toBe(false)
  })
})
