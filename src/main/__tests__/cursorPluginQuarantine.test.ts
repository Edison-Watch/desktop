import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";
import type { DiscoveredMcpServer } from "../discovery/mcpDiscovery";
import {
  quarantineCursorPlugin,
  restoreAllCursorPlugins,
} from "../runtime/mcpConfigActions";

// ---------------------------------------------------------------------------
// Helpers - build a fake Cursor plugin + projects layout in a temp dir
// ---------------------------------------------------------------------------

let testDir: string;

/** ~/.cursor/plugins/cache/<marketplace>/<name>/<sha>/mcp.json */
async function createPluginCache(
  marketplace: string,
  pluginName: string,
  sha: string,
  mcpConfig: Record<string, unknown>,
): Promise<string> {
  const dir = join(testDir, "plugins", "cache", marketplace, pluginName, sha);
  await fs.mkdir(dir, { recursive: true });
  const mcpPath = join(dir, "mcp.json");
  await fs.writeFile(mcpPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2));
  return mcpPath;
}

/** ~/.cursor/projects/<project>/mcps/<pluginDir>/SERVER_METADATA.json */
async function createProjectPluginDir(
  projectName: string,
  pluginDirName: string,
  serverName: string,
): Promise<string> {
  const mcpsDir = join(testDir, "projects", projectName, "mcps", pluginDirName);
  await fs.mkdir(mcpsDir, { recursive: true });
  await fs.writeFile(
    join(mcpsDir, "SERVER_METADATA.json"),
    JSON.stringify({ serverIdentifier: pluginDirName, serverName }),
  );
  return mcpsDir;
}

function makePluginServer(
  name: string,
  cachePath: string,
): DiscoveredMcpServer {
  return {
    name,
    client: "cursor",
    source: "plugin",
    path: cachePath,
    config: { type: "http", url: `https://${name}.example.com/mcp` } as never,
  };
}

async function dirExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cursorPluginQuarantine", () => {
  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      "cursor-plugin-test-" + Date.now() + "-" + Math.random().toString(36),
    );
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { await fs.rm(testDir, { recursive: true, force: true }); } catch { /* */ }
  });

  describe("quarantineCursorPlugin", () => {
    it("renames plugin-datadog-datadog dirs to ew-disabled-plugin-datadog-datadog across projects", async () => {
      // Setup: datadog plugin in cache
      const cachePath = await createPluginCache(
        "cursor-public", "datadog", "fdce3e1db7c99b80939f2ad95c67f525bf0eee50",
        { datadog: { url: "https://dd-mcp.example.com/mcp" } },
      );

      // Setup: datadog installed in 2 projects
      const projA = await createProjectPluginDir(
        "Users-alice-work-projectA", "plugin-datadog-datadog", "datadog",
      );
      const projB = await createProjectPluginDir(
        "Users-alice-work-projectB", "plugin-datadog-datadog", "datadog",
      );
      // Also a non-matching dir that should be left alone
      await createProjectPluginDir(
        "Users-alice-work-projectA", "plugin-slack-slack", "slack",
      );

      // Mock getCursorProjectsDir to point at our temp dir
      const discovery = await import("../discovery/mcpDiscovery");
      const spy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));

      try {
        const server = makePluginServer("datadog", cachePath);
        const result = await quarantineCursorPlugin(server);

        expect(result).not.toBeNull();
        expect(result!.quarantinedAt).toBeTruthy();

        // Verify: plugin-datadog-datadog renamed to ew-disabled-plugin-datadog-datadog
        expect(await dirExists(projA)).toBe(false);
        expect(await dirExists(projA.replace("plugin-datadog-datadog", "ew-disabled-plugin-datadog-datadog"))).toBe(true);
        expect(await dirExists(projB)).toBe(false);
        expect(await dirExists(projB.replace("plugin-datadog-datadog", "ew-disabled-plugin-datadog-datadog"))).toBe(true);

        // Verify: slack plugin was NOT renamed
        expect(await dirExists(
          join(testDir, "projects", "Users-alice-work-projectA", "mcps", "plugin-slack-slack"),
        )).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("disables cache dir even when no project dirs exist", async () => {
      const cachePath = await createPluginCache(
        "cursor-public", "nonexistent", "abc123",
        { nonexistent: { url: "https://example.com" } },
      );
      await fs.mkdir(join(testDir, "projects"), { recursive: true });

      const discovery = await import("../discovery/mcpDiscovery");
      const spy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));

      try {
        const server = makePluginServer("nonexistent", cachePath);
        const result = await quarantineCursorPlugin(server);
        // Still returns a result because the cache dir was renamed
        expect(result).not.toBeNull();
        // Cache dir renamed
        expect(await dirExists(join(testDir, "plugins", "cache", "cursor-public", "nonexistent"))).toBe(false);
        expect(await dirExists(join(testDir, "plugins", "cache", "cursor-public", "ew-disabled-nonexistent"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("skips already-disabled project dirs but still disables cache", async () => {
      const cachePath = await createPluginCache(
        "cursor-public", "slack", "b647da95db39",
        { slack: { url: "https://mcp.slack.com/mcp" } },
      );

      // Pre-disabled project directory
      const mcpsDir = join(testDir, "projects", "proj1", "mcps");
      await fs.mkdir(join(mcpsDir, "ew-disabled-plugin-slack-slack"), { recursive: true });

      const discovery = await import("../discovery/mcpDiscovery");
      const spy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));

      try {
        const server = makePluginServer("slack", cachePath);
        const result = await quarantineCursorPlugin(server);
        expect(result).not.toBeNull();
        // Project disabled dir still there
        expect(await dirExists(join(mcpsDir, "ew-disabled-plugin-slack-slack"))).toBe(true);
        // Cache dir was renamed
        expect(await dirExists(join(testDir, "plugins", "cache", "cursor-public", "slack"))).toBe(false);
        expect(await dirExists(join(testDir, "plugins", "cache", "cursor-public", "ew-disabled-slack"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("restoreAllCursorPlugins", () => {
    it("renames ew-disabled-plugin-* back to plugin-*", async () => {
      // Setup: disabled dirs in 2 projects
      const mcpsDirA = join(testDir, "projects", "projA", "mcps");
      const mcpsDirB = join(testDir, "projects", "projB", "mcps");
      await fs.mkdir(join(mcpsDirA, "ew-disabled-plugin-datadog-datadog"), { recursive: true });
      await fs.mkdir(join(mcpsDirA, "ew-disabled-plugin-slack-slack"), { recursive: true });
      await fs.mkdir(join(mcpsDirB, "ew-disabled-plugin-datadog-datadog"), { recursive: true });
      // Active plugin that should not be touched
      await fs.mkdir(join(mcpsDirA, "plugin-active-active"), { recursive: true });

      // Also create a disabled cache dir
      const cacheDir = join(testDir, "plugins", "cache", "cursor-public");
      await fs.mkdir(join(cacheDir, "ew-disabled-datadog", "sha1"), { recursive: true });
      await fs.writeFile(join(cacheDir, "ew-disabled-datadog", "sha1", "mcp.json"), "{}");

      const discovery = await import("../discovery/mcpDiscovery");
      const projSpy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));
      const cacheSpy = vi.spyOn(discovery, "getCursorPluginCachePath")
        .mockReturnValue(join(testDir, "plugins", "cache"));

      try {
        const result = await restoreAllCursorPlugins();

        // 3 project dirs + 1 cache dir = 4
        expect(result.restored).toBe(4);
        expect(result.errors).toHaveLength(0);

        // Verify project dirs restored
        expect(await dirExists(join(mcpsDirA, "plugin-datadog-datadog"))).toBe(true);
        expect(await dirExists(join(mcpsDirA, "plugin-slack-slack"))).toBe(true);
        expect(await dirExists(join(mcpsDirB, "plugin-datadog-datadog"))).toBe(true);
        // Disabled dirs gone
        expect(await dirExists(join(mcpsDirA, "ew-disabled-plugin-datadog-datadog"))).toBe(false);
        // Active plugin untouched
        expect(await dirExists(join(mcpsDirA, "plugin-active-active"))).toBe(true);
        // Cache dir restored
        expect(await dirExists(join(cacheDir, "datadog"))).toBe(true);
        expect(await dirExists(join(cacheDir, "ew-disabled-datadog"))).toBe(false);
      } finally {
        projSpy.mockRestore();
        cacheSpy.mockRestore();
      }
    });

    it("returns zero when no disabled dirs exist", async () => {
      await fs.mkdir(join(testDir, "projects", "proj1", "mcps", "plugin-normal"), { recursive: true });
      await fs.mkdir(join(testDir, "plugins", "cache", "cursor-public", "normal", "sha1"), { recursive: true });

      const discovery = await import("../discovery/mcpDiscovery");
      const projSpy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));
      const cacheSpy = vi.spyOn(discovery, "getCursorPluginCachePath")
        .mockReturnValue(join(testDir, "plugins", "cache"));

      try {
        const result = await restoreAllCursorPlugins();
        expect(result.restored).toBe(0);
        expect(result.errors).toHaveLength(0);
      } finally {
        projSpy.mockRestore();
        cacheSpy.mockRestore();
      }
    });
  });

  describe("discovery → quarantine → restore roundtrip", () => {
    it("discovers plugin from cache, quarantines across projects, then restores", async () => {
      // 1. Create plugin in cache (like Cursor installing datadog)
      const cachePath = await createPluginCache(
        "cursor-public", "datadog", "fdce3e1db7c99b80939f2ad95c67f525bf0eee50",
        { datadog: { url: "https://${DD_MCP_DOMAIN}/api/unstable/mcp-server/mcp" } },
      );

      // 2. Create project plugin dirs (Cursor activates plugin per-project)
      const projDir1 = await createProjectPluginDir(
        "Users-gatlingx-work-edison-watch", "plugin-datadog-datadog", "datadog",
      );
      const projDir2 = await createProjectPluginDir(
        "tmp-session-abc123", "plugin-datadog-datadog", "datadog",
      );

      const discovery = await import("../discovery/mcpDiscovery");
      const projSpy = vi.spyOn(discovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "projects"));
      const cacheSpy = vi.spyOn(discovery, "getCursorPluginCachePath")
        .mockReturnValue(join(testDir, "plugins", "cache"));

      try {
        // 3. Simulate discovered server (as discoverCursor would produce)
        const server: DiscoveredMcpServer = {
          name: "datadog",
          client: "cursor",
          source: "plugin",
          path: cachePath,
          config: { type: "http", url: "https://dd-mcp.example.com/mcp" } as never,
        };

        // 4. Quarantine
        const qResult = await quarantineCursorPlugin(server);
        expect(qResult).not.toBeNull();

        // Verify project dirs are disabled
        expect(await dirExists(projDir1)).toBe(false);
        expect(await dirExists(projDir2)).toBe(false);
        expect(await dirExists(projDir1.replace("plugin-datadog-datadog", "ew-disabled-plugin-datadog-datadog"))).toBe(true);
        expect(await dirExists(projDir2.replace("plugin-datadog-datadog", "ew-disabled-plugin-datadog-datadog"))).toBe(true);

        // Verify cache dir is disabled (renamed, not deleted)
        const cachePluginDir = join(testDir, "plugins", "cache", "cursor-public", "datadog");
        const disabledCacheDir = join(testDir, "plugins", "cache", "cursor-public", "ew-disabled-datadog");
        expect(await dirExists(cachePluginDir)).toBe(false);
        expect(await dirExists(disabledCacheDir)).toBe(true);

        // 5. Restore
        const rResult = await restoreAllCursorPlugins();
        // 2 project dirs + 1 cache dir = 3
        expect(rResult.restored).toBe(3);
        expect(rResult.errors).toHaveLength(0);

        // Verify project dirs are restored
        expect(await dirExists(projDir1)).toBe(true);
        expect(await dirExists(projDir2)).toBe(true);

        // Verify cache dir is restored and mcp.json is intact
        expect(await dirExists(cachePluginDir)).toBe(true);
        const cacheContent = await fs.readFile(cachePath, "utf-8");
        expect(JSON.parse(cacheContent).mcpServers.datadog).toBeDefined();
      } finally {
        projSpy.mockRestore();
        cacheSpy.mockRestore();
      }
    });
  });
});
