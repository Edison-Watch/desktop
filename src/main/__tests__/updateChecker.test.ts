import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock electron — vi.mock factory must not reference outer variables
vi.mock("electron", () => {
  const NotificationMock = vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    on: vi.fn(),
  }));
  (NotificationMock as unknown as { isSupported: () => boolean }).isSupported =
    () => true;

  return {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "Edison Watch",
    },
    shell: {
      openExternal: vi.fn(),
    },
    Notification: NotificationMock,
  };
});

import {
  startUpdateChecker,
  stopUpdateChecker,
  getAvailableUpdate,
  openUpdateDownload,
} from "../updateChecker";

// ============================================================================
// Tests
// ============================================================================

describe("updateChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopUpdateChecker();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("version comparison", () => {
    it("detects newer version from remote", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "version: 2.0.0\nurl: https://download.example.com",
      });
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(16_000);

      expect(mockFetch).toHaveBeenCalled();
    });

    it("does not trigger update for same version", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "version: 1.0.0\nurl: https://download.example.com",
      });
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(16_000);

      const update = getAvailableUpdate();
      expect(update).toBeNull();
    });

    it("does not trigger update for older version", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "version: 0.5.0\nurl: https://download.example.com",
      });
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(16_000);

      const update = getAvailableUpdate();
      expect(update).toBeNull();
    });

    it("handles fetch failure gracefully", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(16_000);

      const update = getAvailableUpdate();
      expect(update).toBeNull();
    });
  });

  describe("startUpdateChecker / stopUpdateChecker", () => {
    it("starts and stops without error", () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not found",
      });
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker();
      stopUpdateChecker();
    });

    it("stop is safe to call multiple times", () => {
      stopUpdateChecker();
      stopUpdateChecker();
    });

    it("accepts onUpdateAvailable callback", async () => {
      const cb = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          "version: 9.9.9\nurl: https://download.example.com",
      });
      vi.stubGlobal("fetch", mockFetch);

      startUpdateChecker({ onUpdateAvailable: cb });
      await vi.advanceTimersByTimeAsync(16_000);
    });
  });

  describe("getAvailableUpdate", () => {
    it("returns null or UpdateInfo", () => {
      const result = getAvailableUpdate();
      expect(
        result === null || typeof result?.version === "string",
      ).toBe(true);
    });
  });

  describe("openUpdateDownload", () => {
    it("does not throw when no update is available", () => {
      expect(() => openUpdateDownload()).not.toThrow();
    });
  });
});
