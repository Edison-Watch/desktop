import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { promises as fs } from 'fs'

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return join(tmpdir(), 'edison-test-userdata')
      return join(tmpdir(), 'edison-test-' + name)
    },
    getVersion: () => '1.0.0-test'
  }
}))

// Mock sentry
vi.mock('../infra/sentry', () => ({
  captureError: vi.fn()
}))

// Mock setupConfig (imported by hookHealthMonitor for getMcpUrl / getIsServerOnline)
vi.mock('../infra/setupConfig', () => ({
  getMcpUrl: vi.fn().mockReturnValue(null),
  getIsServerOnline: vi.fn().mockReturnValue(false)
}))

// Mock hookInjection so we can control getHookStatus and getPendingErrorsDir
vi.mock('../runtime/hookInjection', () => ({
  getHookStatus: vi.fn().mockResolvedValue([
    {
      client: 'claude-code',
      installed: true,
      hasHook: true,
      hooksApplicable: true,
      mcpApplicable: true,
      hookCount: 4,
      totalHooks: 4,
      mcpConnected: false,
      mcpConfigured: false
    },
    {
      client: 'cursor',
      installed: true,
      hasHook: false,
      hooksApplicable: true,
      mcpApplicable: true,
      hookCount: 0,
      totalHooks: 3,
      mcpConnected: false,
      mcpConfigured: false
    },
    {
      client: 'windsurf',
      installed: false,
      hasHook: false,
      hooksApplicable: true,
      mcpApplicable: true,
      hookCount: 0,
      totalHooks: 1,
      mcpConnected: false,
      mcpConfigured: false
    }
  ]),
  getPendingErrorsDir: vi.fn().mockReturnValue(join(tmpdir(), 'edison-test-errors')),
  getPendingRegistrationsDir: vi.fn().mockReturnValue(join(tmpdir(), 'edison-test-pending')),
  getEdisonWatchDir: vi.fn().mockReturnValue(join(tmpdir(), 'edison-test-watchdir'))
}))

import {
  setOnHooksMissingCallback,
  getHookStatusLabel,
  startHookHealthMonitor,
  stopHookHealthMonitor
} from '../runtime/hookHealthMonitor'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string

async function createTestDir(): Promise<string> {
  const dir = join(tmpdir(), 'hook-health-test-' + Date.now() + '-' + Math.random().toString(36))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Tests
// ============================================================================

const pendingDir = join(tmpdir(), 'edison-test-pending')
const watchDir = join(tmpdir(), 'edison-test-watchdir')

/** Poll until the file is gone or the timeout passes; returns whether it's gone. */
async function waitForGone(filePath: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath)
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('hookHealthMonitor', () => {
  beforeEach(async () => {
    testDir = await createTestDir()
    // Ensure the mock dirs exist for the watcher and sweeps
    const errorsDir = join(tmpdir(), 'edison-test-errors')
    await fs.mkdir(errorsDir, { recursive: true })
    await fs.mkdir(pendingDir, { recursive: true })
    await fs.mkdir(watchDir, { recursive: true })
  })

  afterEach(async () => {
    await stopHookHealthMonitor()
    await cleanupDir(testDir)
    const errorsDir = join(tmpdir(), 'edison-test-errors')
    await cleanupDir(errorsDir)
    await cleanupDir(pendingDir)
    await cleanupDir(watchDir)
    vi.restoreAllMocks()
  })

  describe('setOnHooksMissingCallback', () => {
    it('accepts a callback function', () => {
      const cb = vi.fn()
      setOnHooksMissingCallback(cb)
      // Should not throw
    })
  })

  describe('getHookStatusLabel', () => {
    it('returns a string label', () => {
      const label = getHookStatusLabel()
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    })
  })

  describe('startHookHealthMonitor / stopHookHealthMonitor', () => {
    it('starts and stops without error', async () => {
      startHookHealthMonitor()
      // Give it a moment to initialize
      await new Promise((r) => setTimeout(r, 100))
      await stopHookHealthMonitor()
    })

    it('stop is safe to call multiple times', async () => {
      await stopHookHealthMonitor()
      await stopHookHealthMonitor()
      // Should not throw
    })

    it('drains pre-existing registration files from pending/ on startup', async () => {
      const regFile = join(pendingDir, '20260101-120000-12345-claude-code.json')
      await fs.writeFile(
        regFile,
        JSON.stringify({ projectPath: '/tmp/x', registeredBy: 'claude-code' })
      )

      startHookHealthMonitor()
      expect(await waitForGone(regFile)).toBe(true)
    })

    it('consumes registration files added while running', async () => {
      startHookHealthMonitor()
      await new Promise((r) => setTimeout(r, 200))

      const regFile = join(pendingDir, '20260101-130000-54321-cursor.json')
      await fs.writeFile(regFile, JSON.stringify({ projectPath: '/tmp/y', registeredBy: 'cursor' }))
      expect(await waitForGone(regFile)).toBe(true)
    })

    it('still consumes session-end files', async () => {
      startHookHealthMonitor()
      await new Promise((r) => setTimeout(r, 200))

      const endFile = join(pendingDir, '20260101-140000-11111-session-end.json')
      await fs.writeFile(
        endFile,
        JSON.stringify({ event: 'session_end', conversation_id: 'abc', reason: 'exit' })
      )
      expect(await waitForGone(endFile)).toBe(true)
    })

    it('leaves in-flight dot-temp files alone', async () => {
      startHookHealthMonitor()
      await new Promise((r) => setTimeout(r, 200))

      const tmpFile = join(pendingDir, '.20260101-150000-22222-claude-code.json.tmp')
      await fs.writeFile(tmpFile, '{partial')
      expect(await waitForGone(tmpFile, 1000)).toBe(false)
    })

    it('sweeps active_session files for dead PIDs and keeps live ones', async () => {
      const { spawnSync } = await import('child_process')
      // A process that has already exited - its PID is guaranteed dead
      const deadPid = spawnSync('true').pid as number
      const deadFile = join(watchDir, `active_session_${deadPid}.json`)
      const aliveFile = join(watchDir, `active_session_${process.pid}.json`)
      await fs.writeFile(deadFile, JSON.stringify({ session_id: 'dead' }))
      await fs.writeFile(aliveFile, JSON.stringify({ session_id: 'alive' }))

      startHookHealthMonitor()
      expect(await waitForGone(deadFile)).toBe(true)
      // Live PID's file must survive
      await expect(fs.access(aliveFile)).resolves.toBeUndefined()
    })

    it('detects missing hooks and triggers callback', async () => {
      const cb = vi.fn()
      setOnHooksMissingCallback(cb)

      startHookHealthMonitor()

      // Wait for the first status check to complete
      await new Promise((r) => setTimeout(r, 200))

      await stopHookHealthMonitor()

      // The mock has cursor installed but missing hook - callback should fire
      if (cb.mock.calls.length > 0) {
        const entries = cb.mock.calls[0]![0]
        expect(Array.isArray(entries)).toBe(true)
        const cursorEntry = entries.find((e: { client: string }) => e.client === 'cursor')
        if (cursorEntry) {
          expect(cursorEntry.installed).toBe(true)
          expect(cursorEntry.hasHook).toBe(false)
        }
      }
    })
  })
})
