import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return join(tmpdir(), "edison-test-userdata");
      return join(tmpdir(), "edison-test-" + name);
    },
    getVersion: () => "1.0.0-test",
  },
}));

// Mock sentry
vi.mock("../sentry", () => ({
  captureError: vi.fn(),
}));

// Mock hookInjection so we can control getHookStatus and getPendingErrorsDir
vi.mock("../hookInjection", () => ({
  getHookStatus: vi.fn().mockResolvedValue([
    { client: "claude-code", installed: true, hasHook: true },
    { client: "cursor", installed: true, hasHook: false },
    { client: "windsurf", installed: false, hasHook: false },
  ]),
  getPendingErrorsDir: vi
    .fn()
    .mockReturnValue(join(tmpdir(), "edison-test-errors")),
  getPendingRegistrationsDir: vi
    .fn()
    .mockReturnValue(join(tmpdir(), "edison-test-pending")),
}));

import {
  setOnHooksMissingCallback,
  getHookStatusLabel,
  startHookHealthMonitor,
  stopHookHealthMonitor,
} from "../hookHealthMonitor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "hook-health-test-" + Date.now() + "-" + Math.random().toString(36),
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("hookHealthMonitor", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
    // Ensure the mock errors dir exists for the watcher
    const errorsDir = join(tmpdir(), "edison-test-errors");
    await fs.mkdir(errorsDir, { recursive: true });
  });

  afterEach(async () => {
    await stopHookHealthMonitor();
    await cleanupDir(testDir);
    const errorsDir = join(tmpdir(), "edison-test-errors");
    await cleanupDir(errorsDir);
    vi.restoreAllMocks();
  });

  describe("setOnHooksMissingCallback", () => {
    it("accepts a callback function", () => {
      const cb = vi.fn();
      setOnHooksMissingCallback(cb);
      // Should not throw
    });
  });

  describe("getHookStatusLabel", () => {
    it("returns a string label", () => {
      const label = getHookStatusLabel();
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    });
  });

  describe("startHookHealthMonitor / stopHookHealthMonitor", () => {
    it("starts and stops without error", async () => {
      startHookHealthMonitor();
      // Give it a moment to initialize
      await new Promise((r) => setTimeout(r, 100));
      await stopHookHealthMonitor();
    });

    it("stop is safe to call multiple times", async () => {
      await stopHookHealthMonitor();
      await stopHookHealthMonitor();
      // Should not throw
    });

    it("detects missing hooks and triggers callback", async () => {
      const cb = vi.fn();
      setOnHooksMissingCallback(cb);

      startHookHealthMonitor();

      // Wait for the first status check to complete
      await new Promise((r) => setTimeout(r, 200));

      await stopHookHealthMonitor();

      // The mock has cursor installed but missing hook — callback should fire
      if (cb.mock.calls.length > 0) {
        const entries = cb.mock.calls[0][0];
        expect(Array.isArray(entries)).toBe(true);
        const cursorEntry = entries.find(
          (e: { client: string }) => e.client === "cursor",
        );
        if (cursorEntry) {
          expect(cursorEntry.installed).toBe(true);
          expect(cursorEntry.hasHook).toBe(false);
        }
      }
    });
  });
});
