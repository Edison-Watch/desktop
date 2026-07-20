import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Controller side effects are mocked so the tests never touch launchctl or
// write config.toml. Each mock is a spy we assert against.
let launchAgentLoaded = true
const uninstallMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as const)
const resetMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as const)

vi.mock('../stdiod/controller', () => ({
  isLaunchAgentLoaded: async () => launchAgentLoaded,
  uninstall: (...args: unknown[]) => uninstallMock(...(args as [])),
  resetStdiod: (...args: unknown[]) => resetMock(...(args as []))
}))

vi.mock('../stdiod/stdiodLog', () => ({ stdiodLog: () => {} }))

// Active-account credentials. Overridden per test.
let apiBaseUrl: string | null = 'https://api.testedison.example'
let creds: { apiKey: string; edisonSecretKey?: string } | null = {
  apiKey: 'test-key',
  edisonSecretKey: 'test-secret'
}

vi.mock('../infra/setupConfig', () => ({
  getApiBaseUrl: () => apiBaseUrl,
  getCredentialsForEnv: () => creds
}))

import {
  reprovisionStdiodForActiveAccount,
  teardownStdiodForSignOut
} from '../stdiod/accountSwitch'

describe('teardownStdiodForSignOut', () => {
  beforeEach(() => {
    uninstallMock.mockClear()
    resetMock.mockClear()
    delete process.env.EDISON_DRY_RUN
  })

  it('unloads the daemon but keeps config.toml (purge:false)', async () => {
    await teardownStdiodForSignOut()
    expect(uninstallMock).toHaveBeenCalledTimes(1)
    expect(uninstallMock).toHaveBeenCalledWith({ purge: false })
    expect(resetMock).not.toHaveBeenCalled()
  })

  it('swallows uninstall failures so sign-out never blocks', async () => {
    uninstallMock.mockRejectedValueOnce(new Error('launchctl exploded'))
    await expect(teardownStdiodForSignOut()).resolves.toBeUndefined()
  })
})

describe('reprovisionStdiodForActiveAccount', () => {
  beforeEach(() => {
    uninstallMock.mockClear()
    resetMock.mockClear()
    launchAgentLoaded = true
    apiBaseUrl = 'https://api.testedison.example'
    creds = { apiKey: 'test-key', edisonSecretKey: 'test-secret' }
    delete process.env.EDISON_DRY_RUN
  })
  afterEach(() => {
    delete process.env.EDISON_DRY_RUN
  })

  it('does nothing when the daemon is not installed', async () => {
    launchAgentLoaded = false
    await reprovisionStdiodForActiveAccount()
    expect(resetMock).not.toHaveBeenCalled()
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it('resets the daemon onto the active account when installed', async () => {
    await reprovisionStdiodForActiveAccount()
    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock).toHaveBeenCalledWith({
      backend: 'https://api.testedison.example',
      apiKey: 'test-key',
      edisonSecretKey: 'test-secret'
    })
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it('stops the daemon when installed but the active account has no credentials', async () => {
    creds = null
    await reprovisionStdiodForActiveAccount()
    expect(resetMock).not.toHaveBeenCalled()
    expect(uninstallMock).toHaveBeenCalledWith({ purge: false })
  })

  it('never re-points onto stale credentials when the backend url is missing', async () => {
    apiBaseUrl = null
    await reprovisionStdiodForActiveAccount()
    expect(resetMock).not.toHaveBeenCalled()
    expect(uninstallMock).toHaveBeenCalledWith({ purge: false })
  })

  it('is a no-op under EDISON_DRY_RUN (no launchctl probe in e2e)', async () => {
    process.env.EDISON_DRY_RUN = '1'
    await reprovisionStdiodForActiveAccount()
    expect(resetMock).not.toHaveBeenCalled()
    expect(uninstallMock).not.toHaveBeenCalled()
  })
})
