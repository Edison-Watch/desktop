import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { ConnectionState, StdiodStatus } from '../stdiod/types'

// trayCache reads the live daemon status via controller.getStatus(); mock it
// so we can drive the change-gate deterministically without spawning launchctl.
const getStatusMock = vi.fn<() => Promise<StdiodStatus>>()
vi.mock('../stdiod/controller', () => ({
  getStatus: () => getStatusMock()
}))

function makeStatus(overrides: Partial<StdiodStatus> = {}): StdiodStatus {
  return {
    binaryAvailable: true,
    installed: true,
    loggedIn: true,
    state: {
      connection_state: 'connected',
      backend_url: null,
      device_id: 'device-1',
      device_label: null,
      last_connected_at: null,
      last_error: null,
      servers: [],
      generation: 1
    },
    stateAgeMs: 1000,
    ...overrides
  }
}

describe('startStdiodStatusCacheRefresh change-gate', () => {
  beforeEach(() => {
    // Fresh module per test so the module-level refreshTimer/cached reset.
    vi.resetModules()
    vi.useFakeTimers()
    getStatusMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onUpdate once on the initial kick, then skips ticks where only stateAgeMs changes', async () => {
    let age = 1000
    getStatusMock.mockImplementation(async () => makeStatus({ stateAgeMs: age }))

    const { startStdiodStatusCacheRefresh } = await import('../stdiod/trayCache')
    const onUpdate = vi.fn()
    startStdiodStatusCacheRefresh(10_000, onUpdate)

    // Initial kick is unconditional so the menu reflects status at startup.
    await vi.advanceTimersByTimeAsync(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // Only the wall-clock age advances on subsequent ticks - no rebuild.
    age = 2000
    await vi.advanceTimersByTimeAsync(10_000)
    age = 3000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('fires onUpdate when a menu-relevant field changes', async () => {
    let conn: ConnectionState = 'connected'
    getStatusMock.mockImplementation(async () =>
      makeStatus({ state: { ...makeStatus().state!, connection_state: conn } })
    )

    const { startStdiodStatusCacheRefresh } = await import('../stdiod/trayCache')
    const onUpdate = vi.fn()
    startStdiodStatusCacheRefresh(10_000, onUpdate)

    await vi.advanceTimersByTimeAsync(1)
    expect(onUpdate).toHaveBeenCalledTimes(1)

    conn = 'reconnecting'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })
})
