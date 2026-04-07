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

// Mock marketplace restore so it doesn't touch real state.vscdb files during tests
vi.mock("../mcpQuarantineSqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcpQuarantineSqlite')>();
  return {
    ...actual,
    restoreAllMarketplaceServers: vi.fn().mockResolvedValue({ restored: 0, errors: [] }),
  };
});

import {
  getDisabledConfigPath,
  getServerConfigForImport,
  restoreAllQuarantinedServers,
} from "../mcpConfigActions";
import {
  submitServerRequest,
  approveServerRequest,
  fetchUserRole,
} from "../mcpServerSubmit";
import type { DiscoveredMcpServer } from "../mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "config-actions-test-" + Date.now() + "-" + Math.random().toString(36),
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

function makeServer(
  name: string,
  client: string = "cursor",
): DiscoveredMcpServer {
  return {
    name,
    client: client as DiscoveredMcpServer["client"],
    source: "user",
    path: `/tmp/${name}-mcp.json`,
    config: { command: "npx", args: ["-y", name] },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("mcpConfigActions", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupDir(testDir);
    vi.restoreAllMocks();
  });

  describe("getDisabledConfigPath", () => {
    it("prepends disabled_ to the filename", () => {
      const result = getDisabledConfigPath("/tmp/mcp.json");
      expect(result).toBe("/tmp/disabled_mcp.json");
    });

    it("handles paths with dots in directory names", () => {
      const result = getDisabledConfigPath(
        "/home/user/.config/cursor/mcp.json",
      );
      expect(result).toBe("/home/user/.config/cursor/disabled_mcp.json");
    });
  });

  describe("getServerConfigForImport", () => {
    it("returns sanitized config for import", () => {
      const server = makeServer("test-server", "cursor");
      const result = getServerConfigForImport(server);

      expect(result.name).toBe("test-server");
      expect(result.client).toBe("cursor");
      expect(result.config).toBeDefined();
      expect((result.config as { command: string }).command).toBe("npx");
    });

    it("includes HTTP config correctly", () => {
      const server: DiscoveredMcpServer = {
        name: "http-server",
        client: "vscode",
        source: "user",
        path: "/tmp/mcp.json",
        config: {
          type: "http",
          url: "https://example.com/mcp",
        } as never,
      };
      const result = getServerConfigForImport(server);

      expect(result.name).toBe("http-server");
      expect(result.client).toBe("vscode");
    });
  });

  describe("submitServerRequest (mocked HTTP)", () => {
    it("submits request to backend API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ request_id: 42 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const server = makeServer("test-server");
      const result = await submitServerRequest(
        server,
        "https://api.edison.watch",
        "test-api-key",
        "user-123",
      );

      expect(result).toEqual({ request_id: 42 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("api.edison.watch");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Authorization"]).toContain("test-api-key");
    });

    it("throws on API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });
      vi.stubGlobal("fetch", mockFetch);

      const server = makeServer("fail-server");
      await expect(
        submitServerRequest(
          server,
          "https://api.edison.watch",
          "test-key",
        ),
      ).rejects.toThrow();
    });
  });

  describe("approveServerRequest (mocked HTTP)", () => {
    it("approves request via backend API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "approved" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await approveServerRequest(
        42,
        "https://api.edison.watch",
        "admin-api-key",
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("api.edison.watch");
      expect(opts.method).toBe("POST");
    });
  });

  describe("fetchUserRole (mocked HTTP)", () => {
    it("returns user role from API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ role: "admin" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const role = await fetchUserRole(
        "https://api.edison.watch",
        "test-key",
      );
      expect(role).toBe("admin");
    });

    it("returns null on API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });
      vi.stubGlobal("fetch", mockFetch);

      const role = await fetchUserRole(
        "https://api.edison.watch",
        "bad-key",
      );
      expect(role).toBeNull();
    });
  });

  describe("restoreAllQuarantinedServers", () => {
    it("restores servers from plugin-sourced disabled files", async () => {
      // Create a fake plugin .mcp.json path and its disabled counterpart
      const pluginDir = join(testDir, "plugin-mcp");
      await fs.mkdir(pluginDir, { recursive: true });

      const pluginMcpPath = join(pluginDir, ".mcp.json");
      const disabledPath = getDisabledConfigPath(pluginMcpPath);

      // Write a disabled file with a quarantined server
      const disabledContent = {
        _metadata: { version: 1 },
        servers: {
          "test-plugin-server": {
            command: "node",
            args: ["server.js"],
            originalFile: pluginMcpPath,
            quarantinedAt: "2026-03-20T00:00:00Z",
          },
        },
      };
      await fs.writeFile(
        disabledPath,
        JSON.stringify(disabledContent),
        "utf-8",
      );

      // Mock the unified config registry for full isolation
      const mcpConfigPaths = await import("../mcpConfigPaths");
      const entriesSpy = vi
        .spyOn(mcpConfigPaths, "getAllConfigEntries")
        .mockResolvedValue([
          { client: "cursor", path: pluginMcpPath, kind: "json", scope: "user" },
        ]);
      // Mock getCursorProjectsDir so restoreAllCursorPlugins doesn't scan real filesystem
      const mcpDiscovery = await import("../mcpDiscovery");
      const projectsDirSpy = vi
        .spyOn(mcpDiscovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "nonexistent-projects"));

      try {
        const result = await restoreAllQuarantinedServers();

        expect(result.restored).toBe(1);
        expect(result.errors).toHaveLength(0);

        // Verify the disabled file was deleted
        await expect(fs.access(disabledPath)).rejects.toThrow();

        // Verify the original config was written with the restored server
        const restoredConfig = JSON.parse(
          await fs.readFile(pluginMcpPath, "utf-8"),
        );
        expect(restoredConfig).toHaveProperty("mcpServers");
        expect(restoredConfig.mcpServers).toHaveProperty("test-plugin-server");
      } finally {
        entriesSpy.mockRestore();
        projectsDirSpy.mockRestore();
      }
    });

    it("skips Codex TOML configs and reports error", async () => {
      const codexConfigPath = join(testDir, ".codex", "config.toml");
      const codexDisabledPath = join(testDir, ".codex", "disabled_config.toml");
      await fs.mkdir(join(testDir, ".codex"), { recursive: true });

      // Write a disabled file for a quarantined Codex server
      const disabledContent = {
        _metadata: { version: 1 },
        servers: {
          "everything": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            originalFile: codexConfigPath,
            quarantinedAt: "2026-03-20T00:00:00Z",
          },
        },
      };
      await fs.writeFile(codexDisabledPath, JSON.stringify(disabledContent), "utf-8");

      const mcpConfigPaths = await import("../mcpConfigPaths");
      const entriesSpy = vi
        .spyOn(mcpConfigPaths, "getAllConfigEntries")
        .mockResolvedValue([
          { client: "codex", path: codexConfigPath, kind: "toml", scope: "user" },
        ]);
      const mcpDiscovery = await import("../mcpDiscovery");
      const projectsDirSpy = vi
        .spyOn(mcpDiscovery, "getCursorProjectsDir")
        .mockReturnValue(join(testDir, "nonexistent-projects"));

      try {
        const result = await restoreAllQuarantinedServers();

        // Should not count as restored
        expect(result.restored).toBe(0);
        // Should report an error about TOML not being supported
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain("Codex config restore not yet supported");
        // Disabled file should persist (not deleted)
        await expect(fs.access(codexDisabledPath)).resolves.toBeUndefined();
      } finally {
        entriesSpy.mockRestore();
        projectsDirSpy.mockRestore();
      }
    });
  });
});
