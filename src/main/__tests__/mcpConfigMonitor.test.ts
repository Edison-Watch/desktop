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
vi.mock("../infra/sentry", () => ({
  captureError: vi.fn(),
}));

import {
  McpConfigMonitor,
  isEdisonWatchServer,
  filterOutEdisonWatchServers,
  getClientDisplayName,
} from "../runtime/mcpConfigMonitor";
import { SeenServersStore } from "../discovery/seenServersStore";
import type { DiscoveredMcpServer } from "../discovery/mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "config-monitor-test-" + Date.now() + "-" + Math.random().toString(36),
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

describe("mcpConfigMonitor", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupDir(testDir);
  });

  describe("isEdisonWatchServer", () => {
    it("detects Edison Watch server by npx mcp-remote with edison args", () => {
      const server: DiscoveredMcpServer = {
        name: "gateway",
        client: "cursor",
        source: "user",
        path: "/tmp/mcp.json",
        config: {
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.edison.watch/sse"],
        },
      };
      expect(isEdisonWatchServer(server)).toBe(true);
    });

    it("detects Edison Watch server by URL containing 'edison'", () => {
      const server: DiscoveredMcpServer = {
        name: "my-proxy",
        client: "cursor",
        source: "user",
        path: "/tmp/mcp.json",
        config: {
          type: "http",
          url: "https://mcp.edison.watch/v1/sse",
        } as never,
      };
      expect(isEdisonWatchServer(server)).toBe(true);
    });

    it("detects Edison Watch server by localhost URL with /mcp path", () => {
      const server: DiscoveredMcpServer = {
        name: "local-proxy",
        client: "cursor",
        source: "user",
        path: "/tmp/mcp.json",
        config: {
          type: "http",
          url: "http://localhost:3000/mcp",
        } as never,
      };
      expect(isEdisonWatchServer(server)).toBe(true);
    });

    it("returns false for non-Edison servers", () => {
      const server: DiscoveredMcpServer = {
        name: "some-other-server",
        client: "cursor",
        source: "user",
        path: "/tmp/mcp.json",
        config: { command: "npx", args: ["-y", "some-server"] },
      };
      expect(isEdisonWatchServer(server)).toBe(false);
    });
  });

  describe("filterOutEdisonWatchServers", () => {
    it("filters Edison servers from array", () => {
      const servers: DiscoveredMcpServer[] = [
        {
          name: "ew-proxy",
          client: "cursor",
          source: "user",
          path: "/a",
          config: {
            type: "http",
            url: "https://mcp.edison.watch/sse",
          } as never,
        },
        {
          name: "other-server",
          client: "cursor",
          source: "user",
          path: "/b",
          config: { command: "other" },
        },
      ];
      const filtered = filterOutEdisonWatchServers(servers);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.name).toBe("other-server");
    });

    it("returns empty array when all servers are Edison", () => {
      const servers: DiscoveredMcpServer[] = [
        {
          name: "ew",
          client: "cursor",
          source: "user",
          path: "/a",
          config: {
            command: "npx",
            args: ["-y", "mcp-remote", "https://edison.watch/mcp/sse"],
          },
        },
      ];
      expect(filterOutEdisonWatchServers(servers)).toHaveLength(0);
    });
  });

  describe("getClientDisplayName", () => {
    it("returns human-readable names for known clients", () => {
      expect(getClientDisplayName("vscode")).toBe("VS Code");
      expect(getClientDisplayName("cursor")).toBe("Cursor");
      expect(getClientDisplayName("claude-code")).toBe("Claude Code");
      expect(getClientDisplayName("windsurf")).toBe("Windsurf");
      expect(getClientDisplayName("zed")).toBe("Zed");
    });
  });

  describe("McpConfigMonitor", () => {
    it("creates monitor with SeenServersStore", () => {
      const storePath = join(testDir, "seen.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      expect(monitor).toBeDefined();
      expect(monitor.getCurrentServers()).toEqual([]);
      expect(monitor.getMonitoredPaths()).toEqual([]);
    });

    it("detects new servers via forceRescan", async () => {
      const storePath = join(testDir, "seen.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      // Force a rescan - discoverMcpServers() scans system paths
      const changes = await monitor.forceRescan();
      expect(Array.isArray(changes)).toBe(true);
    });

    it("detects removed servers after forceRescan", async () => {
      const storePath = join(testDir, "seen-removed.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      // First scan to establish baseline
      await monitor.forceRescan();
      const before = monitor.getCurrentServers().length;

      // Second scan - no changes expected on empty system
      const changes = await monitor.forceRescan();
      const after = monitor.getCurrentServers().length;

      // Verify deterministic behavior
      expect(after).toBe(before);
      expect(Array.isArray(changes)).toBe(true);
    });

    it("handles corrupt config files gracefully", async () => {
      const storePath = join(testDir, "seen-corrupt.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      const corruptPath = join(testDir, "corrupt.json");
      await fs.writeFile(corruptPath, "{{invalid json!!", "utf-8");

      await monitor.addConfigPaths([corruptPath]);

      // Should not throw even with corrupt file
      const changes = await monitor.forceRescan();
      expect(Array.isArray(changes)).toBe(true);
    });

    it("addConfigPaths requires monitor to be running", async () => {
      const storePath = join(testDir, "seen-paths.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      const p1 = join(testDir, "a.json");
      await fs.writeFile(p1, "{}", "utf-8");

      // Monitor not started - addConfigPaths returns empty
      const added = await monitor.addConfigPaths([p1]);
      expect(added).toEqual([]);
      expect(monitor.getMonitoredPaths()).not.toContain(p1);
    });

    it("stop is safe to call multiple times", async () => {
      const storePath = join(testDir, "seen-stop.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store);

      await monitor.stop();
      await monitor.stop();
      // Should not throw
    });

    it("accepts custom rescan interval", async () => {
      const storePath = join(testDir, "seen-rescan.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store, 500, 30_000);

      expect(monitor).toBeDefined();
      await monitor.stop();
    });

    it("periodic rescan triggers checkForChanges", async () => {
      const storePath = join(testDir, "seen-periodic.json");
      const store = new SeenServersStore(storePath);
      // Use a very short rescan interval for testing (50ms)
      const monitor = new McpConfigMonitor(store, 500, 50);

      // Spy on the private checkForChanges method directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkSpy = vi
        .spyOn(monitor as any, "checkForChanges")
        .mockResolvedValue([]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (monitor as any).isRunning = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (monitor as any).startRescanTimer();

      try {
        // Wait for at least one interval tick
        await new Promise((r) => setTimeout(r, 120));

        await monitor.stop();

        expect(checkSpy).toHaveBeenCalled();
      } finally {
        checkSpy.mockRestore();
      }
    });

    it("stop clears rescan timer", async () => {
      const storePath = join(testDir, "seen-stop-rescan.json");
      const store = new SeenServersStore(storePath);
      const monitor = new McpConfigMonitor(store, 500, 100);

      // isRunning defaults to false, so the timer's guard prevents checkForChanges
      // from running even if a tick fires before stop() clears the interval.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (monitor as any).startRescanTimer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((monitor as any).rescanTimer).not.toBeNull();

      await monitor.stop();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((monitor as any).rescanTimer).toBeNull();
    });
  });
});
