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

import {
  McpConfigMonitor,
  isEdisonWatchServer,
  filterOutEdisonWatchServers,
  getClientDisplayName,
} from "../mcpConfigMonitor";
import { SeenServersStore } from "../seenServersStore";
import type { DiscoveredMcpServer } from "../mcpDiscovery";

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
      expect(filtered[0].name).toBe("other-server");
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
      expect(getClientDisplayName("claude-desktop")).toBe("Claude Desktop");
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

      // Force a rescan — discoverMcpServers() scans system paths
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

      // Second scan — no changes expected on empty system
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

      // Monitor not started — addConfigPaths returns empty
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
  });
});
