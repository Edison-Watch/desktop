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
  getDisabledConfigPath,
  getServerConfigForImport,
  submitServerRequest,
  approveServerRequest,
  fetchUserRole,
} from "../mcpConfigActions";
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
});
