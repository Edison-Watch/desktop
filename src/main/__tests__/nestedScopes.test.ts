/**
 * Tests for project-scoped (.claude.json → projects.*.mcpServers) and
 * profile-scoped (settings.json → profiles.*.mcpServers) server operations.
 *
 * Covers: resolveServersMap, removeServerFromConfig, disableServerInConfig,
 * replaceServerWithProxy, quarantineServer, and buildRemovalMap.
 */
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

// Mock marketplace quarantine
vi.mock("../quarantine/mcpQuarantineSqlite", () => ({
  quarantineMarketplaceServer: vi.fn(),
  restoreAllMarketplaceServers: vi.fn().mockResolvedValue({ restored: 0, errors: [] }),
}));

// Mock child_process so `claude mcp remove` doesn't actually run
const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
  cb(null, "", "");
});
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args as Parameters<typeof execFileMock>),
}));

import {
  resolveServersMap,
  removeServerFromConfig,
  disableServerInConfig,
  replaceServerWithProxy,
  quarantineServer,
} from "../runtime/mcpConfigActions";
import { buildRemovalMap } from "../discovery/serverDeduplication";
import type { DiscoveredMcpServer, McpServerConfig } from "../discovery/mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "nested-scopes-test-" + Date.now() + "-" + Math.random().toString(36),
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

/** Write a JSON file and return its path. */
async function writeJson(dir: string, filename: string, content: unknown): Promise<string> {
  const filePath = join(dir, filename);
  await fs.writeFile(filePath, JSON.stringify(content, null, 2), "utf-8");
  return filePath;
}

/** Read and parse a JSON file. */
async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

// -- Fixture builders --------------------------------------------------------

function makeClaudeHomeJson() {
  return {
    mcpServers: {
      "global-server": { type: "sse", url: "http://localhost:3000/global/sse" },
    },
    projects: {
      "/Users/me/work/project-a": {
        mcpServers: {
          "proj-a-server": { type: "sse", url: "http://localhost:4000/a/sse" },
          "shared": { type: "sse", url: "http://localhost:4000/shared-a/sse" },
        },
      },
      "/Users/me/work/project-b": {
        mcpServers: {
          "proj-b-server": { command: "node", args: ["b.js"] },
          "shared": { type: "sse", url: "http://localhost:4000/shared-b/sse" },
        },
      },
    },
  };
}

function makeSettingsJson() {
  return {
    mcpServers: {
      "top-level": { type: "sse", url: "http://localhost:3000/top/sse" },
    },
    profiles: {
      work: {
        mcpServers: {
          "work-server": { type: "sse", url: "http://localhost:4000/work/sse" },
          "shared": { type: "sse", url: "http://localhost:4000/shared-work/sse" },
        },
      },
      personal: {
        mcpServers: {
          "personal-db": { command: "uvx", args: ["mcp-server-sqlite"] },
          "shared": { command: "npx", args: ["-y", "notion-mcp"] },
        },
      },
    },
  };
}

function makeServer(
  overrides: Partial<DiscoveredMcpServer> & { name: string; path: string },
): DiscoveredMcpServer {
  return {
    client: "claude-code",
    source: "user",
    config: { type: "sse", url: "http://localhost/placeholder" } as McpServerConfig,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("nested scopes (project + profile)", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupDir(testDir);
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // resolveServersMap
  // --------------------------------------------------------------------------
  describe("resolveServersMap", () => {
    it("resolves project-scoped server in .claude.json", () => {
      const config = makeClaudeHomeJson() as any;
      const server = makeServer({
        name: "proj-a-server",
        path: "/tmp/test.json",
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/a/sse" } as McpServerConfig,
      });

      const { servers, nested } = resolveServersMap(config, server, "proj-a-server");

      expect(nested).toBe(true);
      expect(servers).toBeDefined();
      expect(servers!["proj-a-server"]).toBeDefined();
      expect((servers!["proj-a-server"] as any).url).toBe("http://localhost:4000/a/sse");
    });

    it("resolves profile-scoped server in settings.json", () => {
      const config = makeSettingsJson() as any;
      const server = makeServer({
        name: "work-server",
        path: "/tmp/test.json",
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/work/sse" } as McpServerConfig,
      });

      const { servers, nested } = resolveServersMap(config, server, "work-server");

      expect(nested).toBe(true);
      expect(servers).toBeDefined();
      expect(servers!["work-server"]).toBeDefined();
    });

    it("falls back to top-level when no projectName or profileName", () => {
      const config = makeClaudeHomeJson() as any;
      const server = makeServer({
        name: "global-server",
        path: "/tmp/test.json",
        config: { type: "sse", url: "http://localhost:3000/global/sse" } as McpServerConfig,
      });

      const { servers, nested } = resolveServersMap(config, server, "global-server");

      expect(nested).toBe(false);
      expect(servers).toBeDefined();
      expect(servers!["global-server"]).toBeDefined();
    });

    it("falls back to top-level when project has no matching server", () => {
      const config = makeClaudeHomeJson() as any;
      const server = makeServer({
        name: "nonexistent",
        path: "/tmp/test.json",
        projectName: "/Users/me/work/project-a",
      });

      const result = resolveServersMap(config, server, "nonexistent");

      // Should fall through to top-level (which won't have it either, but nested=false)
      expect(result.nested).toBe(false);
    });

    it("falls back to top-level when profile has no matching server", () => {
      const config = makeSettingsJson() as any;
      const server = makeServer({
        name: "nonexistent",
        path: "/tmp/test.json",
        profileName: "work",
      });

      const result = resolveServersMap(config, server, "nonexistent");

      expect(result.nested).toBe(false);
    });

    it("returns the mutable reference (mutations apply in-place)", () => {
      const config = makeClaudeHomeJson() as any;
      const server = makeServer({
        name: "proj-a-server",
        path: "/tmp/test.json",
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/a/sse" } as McpServerConfig,
      });

      const { servers } = resolveServersMap(config, server, "proj-a-server");
      delete servers!["proj-a-server"];

      // Verify the deletion propagated into the original config object
      const projA = (config.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["proj-a-server"]).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // removeServerFromConfig
  // --------------------------------------------------------------------------
  describe("removeServerFromConfig", () => {
    it("removes a project-scoped server from .claude.json", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "proj-a-server",
        path: filePath,
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/a/sse" } as McpServerConfig,
      });

      await removeServerFromConfig(server);

      const result = await readJson(filePath);
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["proj-a-server"]).toBeUndefined();
      // Other entries should be untouched
      expect(projA.mcpServers["shared"]).toBeDefined();
      expect((result as any).mcpServers["global-server"]).toBeDefined();
    });

    it("removes a profile-scoped server from settings.json", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "work-server",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/work/sse" } as McpServerConfig,
      });

      await removeServerFromConfig(server);

      const result = await readJson(filePath);
      const work = (result.profiles as any).work;
      expect(work.mcpServers["work-server"]).toBeUndefined();
      // Other profile entries should remain
      expect(work.mcpServers["shared"]).toBeDefined();
      expect((result as any).mcpServers["top-level"]).toBeDefined();
    });

    it("removes a top-level server (no project/profile)", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "global-server",
        path: filePath,
        config: { type: "sse", url: "http://localhost:3000/global/sse" } as McpServerConfig,
      });

      await removeServerFromConfig(server);

      const result = await readJson(filePath);
      expect((result as any).mcpServers["global-server"]).toBeUndefined();
      // Projects should be untouched
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["proj-a-server"]).toBeDefined();
    });

    it("uses originalName when set (dedup rename scenario)", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "shared_ccode_1",
        originalName: "shared",
        path: filePath,
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/shared-a/sse" } as McpServerConfig,
      });

      await removeServerFromConfig(server);

      const result = await readJson(filePath);
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["shared"]).toBeUndefined();
      // project-b's "shared" should be untouched
      const projB = (result.projects as any)["/Users/me/work/project-b"];
      expect(projB.mcpServers["shared"]).toBeDefined();
    });

    it("throws when server not found in any scope", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "nonexistent",
        path: filePath,
        projectName: "/Users/me/work/project-a",
      });

      await expect(removeServerFromConfig(server)).rejects.toThrow(
        'Server "nonexistent" not found in config file',
      );
    });

    it("creates a backup before modifying", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "work-server",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/work/sse" } as McpServerConfig,
      });

      await removeServerFromConfig(server);

      const files = await fs.readdir(testDir);
      const backups = files.filter((f) => f.includes(".backup."));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // disableServerInConfig
  // --------------------------------------------------------------------------
  describe("disableServerInConfig", () => {
    it("disables a project-scoped server with _disabled_ prefix", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "proj-a-server",
        path: filePath,
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/a/sse" } as McpServerConfig,
      });

      await disableServerInConfig(server);

      const result = await readJson(filePath);
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["proj-a-server"]).toBeUndefined();
      expect(projA.mcpServers["_disabled_proj-a-server"]).toBeDefined();
      expect((projA.mcpServers["_disabled_proj-a-server"] as any).url).toBe(
        "http://localhost:4000/a/sse",
      );
    });

    it("disables a profile-scoped server with _disabled_ prefix", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "personal-db",
        path: filePath,
        profileName: "personal",
        config: { command: "uvx", args: ["mcp-server-sqlite"] } as unknown as McpServerConfig,
      });

      await disableServerInConfig(server);

      const result = await readJson(filePath);
      const personal = (result.profiles as any).personal;
      expect(personal.mcpServers["personal-db"]).toBeUndefined();
      expect(personal.mcpServers["_disabled_personal-db"]).toBeDefined();
    });

    it("does not affect other scopes when disabling nested server", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "shared",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/shared-work/sse" } as McpServerConfig,
      });

      await disableServerInConfig(server);

      const result = await readJson(filePath);
      // work's shared should be disabled
      expect((result.profiles as any).work.mcpServers["shared"]).toBeUndefined();
      expect((result.profiles as any).work.mcpServers["_disabled_shared"]).toBeDefined();
      // personal's shared should be untouched
      expect((result.profiles as any).personal.mcpServers["shared"]).toBeDefined();
      // top-level should be untouched
      expect((result as any).mcpServers["top-level"]).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // replaceServerWithProxy
  // --------------------------------------------------------------------------
  describe("replaceServerWithProxy", () => {
    it("replaces a project-scoped server with proxy", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "proj-b-server",
        path: filePath,
        projectName: "/Users/me/work/project-b",
        config: { command: "node", args: ["b.js"] } as unknown as McpServerConfig,
      });

      await replaceServerWithProxy(server, "http://edison.watch/proxy");

      const result = await readJson(filePath);
      const projB = (result.projects as any)["/Users/me/work/project-b"];
      expect(projB.mcpServers["proj-b-server"]).toEqual({
        type: "sse",
        url: "http://edison.watch/proxy",
      });
    });

    it("replaces a profile-scoped server with proxy", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "work-server",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/work/sse" } as McpServerConfig,
      });

      await replaceServerWithProxy(server, "http://edison.watch/proxy", "secret-123");

      const result = await readJson(filePath);
      const work = (result.profiles as any).work;
      expect(work.mcpServers["work-server"]).toEqual({
        type: "sse",
        url: "http://edison.watch/proxy",
        headers: { "X-Edison-Secret-Key": "secret-123" },
      });
    });

    it("does not affect other projects when replacing nested server", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "shared_ccode_1",
        originalName: "shared",
        path: filePath,
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/shared-a/sse" } as McpServerConfig,
      });

      await replaceServerWithProxy(server, "http://edison.watch/proxy");

      const result = await readJson(filePath);
      // project-a's shared should be replaced
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      expect((projA.mcpServers["shared"] as any).url).toBe("http://edison.watch/proxy");
      // project-b's shared should be untouched
      const projB = (result.projects as any)["/Users/me/work/project-b"];
      expect((projB.mcpServers["shared"] as any).url).toBe("http://localhost:4000/shared-b/sse");
    });
  });

  // --------------------------------------------------------------------------
  // quarantineServer
  // --------------------------------------------------------------------------
  describe("quarantineServer", () => {
    it("quarantines a project-scoped server from .claude.json via CLI", async () => {
      execFileMock.mockClear();
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());
      const server = makeServer({
        name: "proj-a-server",
        path: filePath,
        source: "project",
        client: "claude-code",
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/a/sse" } as McpServerConfig,
      });

      const result = await quarantineServer(server);

      expect(result).not.toBeNull();
      expect(result!.originalPath).toBe(filePath);

      // Verify CLI was called instead of direct file edit
      expect(execFileMock).toHaveBeenCalledOnce();
      const [cmd, args, opts] = execFileMock.mock.calls[0]!;
      expect(cmd).toBe("claude");
      expect(args).toEqual(["mcp", "remove", "proj-a-server"]);
      expect(opts).toMatchObject({ cwd: "/Users/me/work/project-a" });

      // Original config should NOT have been modified (CLI handles removal)
      const config = await readJson(filePath);
      const projA = (config.projects as any)["/Users/me/work/project-a"];
      expect(projA.mcpServers["proj-a-server"]).toBeDefined();
    });

    it("quarantines a profile-scoped server from settings.json", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());
      const server = makeServer({
        name: "work-server",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/work/sse" } as McpServerConfig,
      });

      const result = await quarantineServer(server);

      expect(result).not.toBeNull();

      // Verify server was removed from original config
      const config = await readJson(filePath);
      const work = (config.profiles as any).work;
      expect(work.mcpServers["work-server"]).toBeUndefined();
      expect(work.mcpServers["shared"]).toBeDefined();
    });

    it("returns null and rolls back when server is already absent", async () => {
      // Write config WITHOUT the server we're trying to quarantine
      const config = {
        mcpServers: { "other": { type: "sse", url: "http://localhost/other" } },
        projects: {
          "/Users/me/project": {
            mcpServers: { "other-proj": { type: "sse", url: "http://localhost/proj" } },
          },
        },
      };
      const filePath = await writeJson(testDir, "claude.json", config);

      const server = makeServer({
        name: "missing-server",
        path: filePath,
        projectName: "/Users/me/project",
        config: { type: "sse", url: "http://localhost/gone" } as McpServerConfig,
      });

      const result = await quarantineServer(server);

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // buildRemovalMap - double-removal prevention
  // --------------------------------------------------------------------------
  describe("buildRemovalMap", () => {
    it("maps all raw entries when configs are identical (no rename)", () => {
      const rawEntries: DiscoveredMcpServer[] = [
        makeServer({
          name: "notion",
          path: "/home/.claude/settings.json",
          config: { command: "npx", args: ["-y", "notion-mcp"] } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "notion",
          path: "/home/.cursor/mcp.json",
          client: "cursor",
          config: { command: "npx", args: ["-y", "notion-mcp"] } as unknown as McpServerConfig,
        }),
      ];

      // Dedup merges identical configs into one entry
      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "notion",
          path: "/home/.claude/settings.json",
          clients: ["claude-code", "cursor"],
          config: { command: "npx", args: ["-y", "notion-mcp"] } as unknown as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap(rawEntries, deduped);
      expect(map.get("notion")).toHaveLength(2);
    });

    it("maps each renamed server to only its own raw entry (prevents double-removal)", () => {
      // "samediff" in two projects with different configs
      const rawEntries: DiscoveredMcpServer[] = [
        makeServer({
          name: "samediff",
          path: "/home/.claude.json",
          projectName: "/Users/me/work/project-a",
          config: { type: "sse", url: "http://localhost/a" } as McpServerConfig,
        }),
        makeServer({
          name: "samediff",
          path: "/home/.claude.json",
          projectName: "/Users/me/work/project-b",
          config: { type: "sse", url: "http://localhost/b" } as McpServerConfig,
        }),
      ];

      // Dedup renames to samediff_ccode_1 and samediff_ccode_2
      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "samediff_ccode_1",
          originalName: "samediff",
          path: "/home/.claude.json",
          projectName: "/Users/me/work/project-a",
          config: { type: "sse", url: "http://localhost/a" } as McpServerConfig,
        }),
        makeServer({
          name: "samediff_ccode_2",
          originalName: "samediff",
          path: "/home/.claude.json",
          projectName: "/Users/me/work/project-b",
          config: { type: "sse", url: "http://localhost/b" } as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap(rawEntries, deduped);

      // Each deduped entry should map to exactly 1 raw entry
      const entries1 = map.get("samediff_ccode_1")!;
      expect(entries1).toHaveLength(1);
      expect(entries1[0]!.projectName).toBe("/Users/me/work/project-a");

      const entries2 = map.get("samediff_ccode_2")!;
      expect(entries2).toHaveLength(1);
      expect(entries2[0]!.projectName).toBe("/Users/me/work/project-b");
    });

    it("maps renamed server to own entry for profile conflicts", () => {
      // Same server name in two profiles with different configs
      const rawEntries: DiscoveredMcpServer[] = [
        makeServer({
          name: "notion",
          path: "/home/.claude/settings.json",
          profileName: "work",
          config: { command: "npx", args: ["-y", "notion-mcp"], env: { TOKEN: "work-token" } } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "notion",
          path: "/home/.claude/settings.json",
          profileName: "personal",
          config: { command: "npx", args: ["-y", "notion-mcp"], env: { TOKEN: "personal-token" } } as unknown as McpServerConfig,
        }),
      ];

      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "notion_ccode_1",
          originalName: "notion",
          path: "/home/.claude/settings.json",
          profileName: "work",
          config: { command: "npx", args: ["-y", "notion-mcp"], env: { TOKEN: "work-token" } } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "notion_ccode_2",
          originalName: "notion",
          path: "/home/.claude/settings.json",
          profileName: "personal",
          config: { command: "npx", args: ["-y", "notion-mcp"], env: { TOKEN: "personal-token" } } as unknown as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap(rawEntries, deduped);

      const entries1 = map.get("notion_ccode_1")!;
      expect(entries1).toHaveLength(1);
      expect(entries1[0]!.profileName).toBe("work");

      const entries2 = map.get("notion_ccode_2")!;
      expect(entries2).toHaveLength(1);
      expect(entries2[0]!.profileName).toBe("personal");
    });

    it("maps renamed server across different clients correctly", () => {
      // Same name, different clients, different configs
      const rawEntries: DiscoveredMcpServer[] = [
        makeServer({
          name: "sqlite",
          path: "/home/.claude/settings.json",
          client: "claude-code",
          config: { command: "uvx", args: ["mcp-sqlite"] } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "sqlite",
          path: "/home/.cursor/mcp.json",
          client: "cursor",
          config: { command: "npx", args: ["-y", "mcp-sqlite"] } as unknown as McpServerConfig,
        }),
      ];

      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "sqlite_ccode",
          originalName: "sqlite",
          path: "/home/.claude/settings.json",
          client: "claude-code",
          config: { command: "uvx", args: ["mcp-sqlite"] } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "sqlite_cursor",
          originalName: "sqlite",
          path: "/home/.cursor/mcp.json",
          client: "cursor",
          config: { command: "npx", args: ["-y", "mcp-sqlite"] } as unknown as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap(rawEntries, deduped);

      const ccode = map.get("sqlite_ccode")!;
      expect(ccode).toHaveLength(1);
      expect(ccode[0]!.path).toBe("/home/.claude/settings.json");

      const cursor = map.get("sqlite_cursor")!;
      expect(cursor).toHaveLength(1);
      expect(cursor[0]!.path).toBe("/home/.cursor/mcp.json");
    });

    it("deduplicates raw entries with same name+path (prevents triple-removal)", () => {
      // Same server discovered through multiple paths for the same config file
      // e.g. cursor global + cursor workspace storage both pointing at ~/.cursor/mcp.json
      const rawEntries: DiscoveredMcpServer[] = [
        makeServer({
          name: "zap1",
          path: "/home/.claude/settings.json",
          config: { command: "npx", args: ["-y", "zap1-mcp"] } as unknown as McpServerConfig,
        }),
        makeServer({
          name: "zap1",
          path: "/home/.cursor/mcp.json",
          client: "cursor",
          config: { command: "npx", args: ["-y", "zap1-mcp"] } as unknown as McpServerConfig,
        }),
        // Duplicate: same name + same path (discovered via a second code path)
        makeServer({
          name: "zap1",
          path: "/home/.cursor/mcp.json",
          client: "cursor",
          config: { command: "npx", args: ["-y", "zap1-mcp"] } as unknown as McpServerConfig,
        }),
      ];

      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "zap1",
          path: "/home/.claude/settings.json",
          clients: ["claude-code", "cursor"],
          config: { command: "npx", args: ["-y", "zap1-mcp"] } as unknown as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap(rawEntries, deduped);

      // Should be 2 (one per unique path), NOT 3
      const entries = map.get("zap1")!;
      expect(entries).toHaveLength(2);
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("/home/.claude/settings.json");
      expect(paths).toContain("/home/.cursor/mcp.json");
    });

    it("falls back to deduped server itself when no raw match found", () => {
      // Edge case: raw entries were modified between discovery and building the map
      const deduped: DiscoveredMcpServer[] = [
        makeServer({
          name: "ghost_ccode_1",
          originalName: "ghost",
          path: "/home/.claude.json",
          projectName: "project-x",
          config: { type: "sse", url: "http://localhost/ghost" } as McpServerConfig,
        }),
      ];

      const map = buildRemovalMap([], deduped);

      const entries = map.get("ghost_ccode_1")!;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("ghost_ccode_1");
    });
  });

  // --------------------------------------------------------------------------
  // Integration: sequential removal of project-scoped servers
  // --------------------------------------------------------------------------
  describe("sequential removal of same-name project-scoped servers", () => {
    it("removes 'shared' from project-a without affecting project-b", async () => {
      const filePath = await writeJson(testDir, "claude.json", makeClaudeHomeJson());

      // Remove from project-a
      const serverA = makeServer({
        name: "shared_ccode_1",
        originalName: "shared",
        path: filePath,
        projectName: "/Users/me/work/project-a",
        config: { type: "sse", url: "http://localhost:4000/shared-a/sse" } as McpServerConfig,
      });
      await removeServerFromConfig(serverA);

      // Remove from project-b
      const serverB = makeServer({
        name: "shared_ccode_2",
        originalName: "shared",
        path: filePath,
        projectName: "/Users/me/work/project-b",
        config: { type: "sse", url: "http://localhost:4000/shared-b/sse" } as McpServerConfig,
      });
      await removeServerFromConfig(serverB);

      const result = await readJson(filePath);
      const projA = (result.projects as any)["/Users/me/work/project-a"];
      const projB = (result.projects as any)["/Users/me/work/project-b"];

      expect(projA.mcpServers["shared"]).toBeUndefined();
      expect(projB.mcpServers["shared"]).toBeUndefined();
      // Other entries should be untouched
      expect(projA.mcpServers["proj-a-server"]).toBeDefined();
      expect(projB.mcpServers["proj-b-server"]).toBeDefined();
    });

    it("removes same-name servers from different profiles sequentially", async () => {
      const filePath = await writeJson(testDir, "settings.json", makeSettingsJson());

      const serverWork = makeServer({
        name: "shared_ccode_1",
        originalName: "shared",
        path: filePath,
        profileName: "work",
        config: { type: "sse", url: "http://localhost:4000/shared-work/sse" } as McpServerConfig,
      });
      await removeServerFromConfig(serverWork);

      const serverPersonal = makeServer({
        name: "shared_ccode_2",
        originalName: "shared",
        path: filePath,
        profileName: "personal",
        config: { command: "npx", args: ["-y", "notion-mcp"] } as unknown as McpServerConfig,
      });
      await removeServerFromConfig(serverPersonal);

      const result = await readJson(filePath);
      expect((result.profiles as any).work.mcpServers["shared"]).toBeUndefined();
      expect((result.profiles as any).personal.mcpServers["shared"]).toBeUndefined();
      // Other entries untouched
      expect((result.profiles as any).work.mcpServers["work-server"]).toBeDefined();
      expect((result.profiles as any).personal.mcpServers["personal-db"]).toBeDefined();
    });
  });
});
