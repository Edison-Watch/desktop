import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Each test gets a throwaway dir serving as both userData (install stamp)
// and home (launchd plist) so the JSON store and plist are isolated.
let userDataDir: string
let homeDir: string
let appVersion = '1.0.0'
let binaryPath = '/Applications/Edison Watch.app/Contents/Resources/bin/edison-stdiod'
let launchAgentLoaded = true
const installMock = vi.fn(async () => ({ ok: true }) as const)

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => userDataDir,
    getVersion: () => appVersion,
    isPackaged: false // EW_STDIOD_REFRESH_TEST is set below instead
  }
}))

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>()
  return { ...original, default: { ...original, homedir: () => homeDir } }
})

vi.mock('../runtime/stdiodBinary', () => ({
  getStdiodBinaryPath: () => binaryPath,
  stdiodBinaryExists: () => true
}))

vi.mock('../stdiod/controller', () => ({
  install: (...args: unknown[]) => installMock(...(args as [])),
  isLaunchAgentLoaded: async () => launchAgentLoaded
}))

vi.mock('../stdiod/stdiodLog', () => ({ stdiodLog: () => {} }))

import { computeRefreshReason, maybeRefreshStdiodInstall } from '../stdiod/installRefresh'
import { readInstallStamp, writeInstallStamp } from '../stdiod/installStamp'

const PLIST_DIR = 'Library/LaunchAgents'
const PLIST_NAME = 'watch.edison.stdiod.plist'

function writePlist(binary: string): void {
  mkdirSync(join(homeDir, PLIST_DIR), { recursive: true })
  writeFileSync(
    join(homeDir, PLIST_DIR, PLIST_NAME),
    `<plist><key>ProgramArguments</key><array><string>${binary}</string></array></plist>`,
    'utf-8'
  )
}

describe('computeRefreshReason', () => {
  const current = {
    appVersion: '1.2.0',
    binaryPath: '/Applications/EW.app/Contents/Resources/bin/edison-stdiod'
  }
  const freshStamp = { appVersion: '1.2.0', binaryPath: current.binaryPath }
  const plistFor = (p: string): string => `<string>${p}</string>`

  it('is null when stamp and plist both match the current bundle', () => {
    expect(
      computeRefreshReason({
        ...current,
        stamp: freshStamp,
        plistBody: plistFor(current.binaryPath)
      })
    ).toBeNull()
  })

  it('refreshes when the plist is unreadable', () => {
    expect(computeRefreshReason({ ...current, stamp: freshStamp, plistBody: null })).toMatch(
      /unreadable/
    )
  })

  it('refreshes when the plist points elsewhere (app moved / translocated)', () => {
    expect(
      computeRefreshReason({
        ...current,
        stamp: freshStamp,
        plistBody: plistFor('/private/var/folders/xy/AppTranslocation/EW.app/bin/edison-stdiod')
      })
    ).toMatch(/different binary path/)
  })

  it('refreshes when no stamp exists (install predates stamping)', () => {
    expect(
      computeRefreshReason({ ...current, stamp: null, plistBody: plistFor(current.binaryPath) })
    ).toMatch(/no install stamp/)
  })

  it('refreshes when the app version changed since the last install', () => {
    expect(
      computeRefreshReason({
        ...current,
        stamp: { ...freshStamp, appVersion: '1.1.0' },
        plistBody: plistFor(current.binaryPath)
      })
    ).toMatch(/1\.1\.0 -> 1\.2\.0/)
  })
})

describe('maybeRefreshStdiodInstall', () => {
  const realPlatform = process.platform
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'ew-stdiod-refresh-'))
    homeDir = userDataDir
    appVersion = '1.0.0'
    launchAgentLoaded = true
    installMock.mockClear()
    process.env.EW_STDIOD_REFRESH_TEST = '1'
    delete process.env.EDISON_DRY_RUN
    // The refresh is darwin-only (launchd); keep the suite green on Linux CI.
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    rmSync(userDataDir, { recursive: true, force: true })
    delete process.env.EW_STDIOD_REFRESH_TEST
  })

  it('does nothing when the LaunchAgent is not loaded', async () => {
    launchAgentLoaded = false
    await maybeRefreshStdiodInstall()
    expect(installMock).not.toHaveBeenCalled()
  })

  it('re-installs after an app update (stamp version differs)', async () => {
    writePlist(binaryPath)
    writeInstallStamp()
    appVersion = '1.1.0'
    await maybeRefreshStdiodInstall()
    expect(installMock).toHaveBeenCalledTimes(1)
  })

  it('skips the re-install when stamp and plist are current', async () => {
    writePlist(binaryPath)
    writeInstallStamp()
    await maybeRefreshStdiodInstall()
    expect(installMock).not.toHaveBeenCalled()
  })

  it('re-installs when the plist points at a stale bundle path', async () => {
    writePlist('/old/location/Edison Watch.app/Contents/Resources/bin/edison-stdiod')
    writeInstallStamp()
    await maybeRefreshStdiodInstall()
    expect(installMock).toHaveBeenCalledTimes(1)
  })
})

describe('install stamp store', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'ew-stdiod-stamp-'))
    appVersion = '2.0.0'
  })
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('round-trips the current version and binary path', () => {
    expect(readInstallStamp()).toBeNull()
    writeInstallStamp()
    expect(readInstallStamp()).toEqual({ appVersion: '2.0.0', binaryPath })
  })

  it('returns null for a malformed stamp file', () => {
    writeFileSync(join(userDataDir, 'stdiod-install-stamp.json'), '{"appVersion": 7}', 'utf-8')
    expect(readInstallStamp()).toBeNull()
  })
})
