import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir, platform } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { promises as fs } from "fs";
import {
  getVscodeUserMcpPath,
  getCursorConfigPath,
  getWindsurfConfigPath,
  getZedConfigPath,
  getClaudeCodeUserSettingsPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeDedicatedMcpPath,
  getClaudeCodeManagedMcpPath,
  parseVscodeMcpJson,
  parseClaudeCodeSettingsJson,
  parseClaudeCodeMcpJson,
  parseClaudeHomeJson,
  parseClaudeDedicatedMcpServers,
  parseCursorMcpJson,
  parseWindsurfMcpJson,
  parseZedSettingsJson,
  parseJetBrainsServersJson,
  getJetBrainsMcpConfigPaths,
  discoverMcpServers,
  getServerFingerprint,
  getCursorProjectMcpPaths,
  getCursorWorkspaceStoragePath,
} from "../discovery/mcpDiscovery";
import type { DiscoveredMcpServer } from "../discovery/mcpDiscovery";
import { getAllConfigPaths } from "../clients/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testTmpDir: string;

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "mcp-discovery-test-" + Date.now() + "-" + Math.random().toString(36),
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function createTempConfig(
  dir: string,
  filename: string,
  content: string,
): Promise<string> {
  const filePath = join(dir, filename);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// Path Resolution Tests
// ============================================================================

describe("Path Resolution Functions", () => {
  describe("getVscodeUserMcpPath", () => {
    it("returns platform-specific VS Code mcp.json path", () => {
      const path = getVscodeUserMcpPath();
      expect(path.length).toBeGreaterThan(0);
      expect(path).toMatch(/mcp\.json$/);

      switch (platform()) {
        case "darwin":
          expect(path).toContain("Library/Application Support/Code/User");
          break;
        case "win32":
          expect(path).toMatch(/Code.*User/);
          break;
        default:
          expect(path).toContain(".config/Code/User");
      }
    });
  });

  describe("getCursorConfigPath", () => {
    it("returns Cursor mcp.json path in .cursor directory", () => {
      const path = getCursorConfigPath();
      expect(path.length).toBeGreaterThan(0);
      expect(path).toContain(".cursor");
      expect(path).toMatch(/mcp\.json$/);
    });
  });

  describe("getWindsurfConfigPath", () => {
    it("returns Windsurf mcp_config.json path", () => {
      const path = getWindsurfConfigPath();
      expect(path.length).toBeGreaterThan(0);
      expect(path).toContain(".codeium/windsurf");
      expect(path).toMatch(/mcp_config\.json$/);
    });
  });

  describe("getZedConfigPath", () => {
    it("returns platform-specific Zed settings.json path", () => {
      const path = getZedConfigPath();
      expect(path.length).toBeGreaterThan(0);
      expect(path).toMatch(/settings\.json$/);

      switch (platform()) {
        case "darwin":
          expect(path).toContain(".config/zed");
          break;
        case "win32":
          expect(path).toContain("Zed");
          break;
        default:
          expect(path).toContain(".config/zed");
      }
    });
  });

  describe("Claude Code paths", () => {
    it("returns correct user settings path", () => {
      const path = getClaudeCodeUserSettingsPath();
      expect(path).toContain(".claude");
      expect(path).toMatch(/settings\.json$/);
    });

    it("returns correct local settings path", () => {
      const path = getClaudeCodeLocalSettingsPath();
      expect(path).toContain(".claude");
      expect(path).toMatch(/settings\.local\.json$/);
    });

    it("returns correct home json path", () => {
      const path = getClaudeCodeHomeJsonPath();
      expect(path).toMatch(/\.claude\.json$/);
    });

    it("returns correct dedicated MCP path", () => {
      const path = getClaudeCodeDedicatedMcpPath();
      expect(path).toContain(".claude");
      expect(path).toMatch(/mcp_servers\.json$/);
    });

    it("returns platform-specific managed MCP path", () => {
      const path = getClaudeCodeManagedMcpPath();
      expect(path).not.toBeNull();
      expect(path!).toContain("managed-mcp.json");
    });
  });

  describe("getAllConfigPaths", () => {
    it("returns all config paths in correct structure", () => {
      const paths = getAllConfigPaths();

      expect(typeof paths.vscode).toBe("string");
      expect(typeof paths.cursor).toBe("string");
      expect(Array.isArray(paths.claudeCode)).toBe(true);
      expect(paths.claudeCode.length).toBe(4);
      expect(typeof paths.windsurf).toBe("string");
      expect(typeof paths.zed).toBe("string");
    });
  });
});

// ============================================================================
// Config Parsing Tests
// ============================================================================

describe("Config Parsing Functions", () => {
  beforeAll(async () => {
    testTmpDir = await createTempDir();
  });

  afterAll(async () => {
    await cleanupDir(testTmpDir);
  });

  describe("parseVscodeMcpJson", () => {
    it("parses VS Code mcp.json with servers key", async () => {
      const config = {
        servers: {
          "test-server": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-test"],
          },
          "http-server": { type: "http", url: "https://example.com/mcp" },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "vscode-mcp.json",
        JSON.stringify(config),
      );
      const servers = await parseVscodeMcpJson(filePath);

      expect(servers).toHaveLength(2);
      expect(servers[0]!.name).toBe("test-server");
      expect(servers[0]!.client).toBe("vscode");
      expect(servers[0]!.source).toBe("user");
      expect(servers[0]!.path).toBe(filePath);
      expect(servers[0]!.config).toEqual(config.servers["test-server"]);

      expect(servers[1]!.name).toBe("http-server");
      expect((servers[1]!.config as { type: string }).type).toBe("http");
    });

    it("handles empty servers object", async () => {
      const filePath = await createTempConfig(
        testTmpDir,
        "vscode-empty.json",
        JSON.stringify({ servers: {} }),
      );
      const servers = await parseVscodeMcpJson(filePath);
      expect(servers).toHaveLength(0);
    });

    it("handles missing servers key", async () => {
      const filePath = await createTempConfig(
        testTmpDir,
        "vscode-no-servers.json",
        JSON.stringify({ inputs: [] }),
      );
      const servers = await parseVscodeMcpJson(filePath);
      expect(servers).toHaveLength(0);
    });

  });

  describe("parseClaudeCodeSettingsJson", () => {
    it("parses settings.json with mcpServers", async () => {
      const config = {
        mcpServers: {
          everything: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-everything"],
            env: { HOME: "/tmp" },
          },
        },
        permissions: { allow: ["Read"] },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "claude-settings.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeCodeSettingsJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("everything");
      expect(servers[0]!.client).toBe("claude-code");
      expect(servers[0]!.source).toBe("user");
      expect(
        (servers[0]!.config as { env?: Record<string, string> }).env,
      ).toEqual({ HOME: "/tmp" });
    });

    it("handles missing mcpServers key", async () => {
      const filePath = await createTempConfig(
        testTmpDir,
        "claude-no-mcp.json",
        JSON.stringify({ permissions: { allow: ["Read"] } }),
      );
      const servers = await parseClaudeCodeSettingsJson(filePath);
      expect(servers).toHaveLength(0);
    });
  });

  describe("parseClaudeCodeMcpJson", () => {
    it("parses managed-mcp.json as enterprise source", async () => {
      const config = {
        mcpServers: {
          "enterprise-server": {
            type: "http",
            url: "https://internal.company.com/mcp",
          },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "managed-mcp.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeCodeMcpJson(filePath, "enterprise");

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("enterprise-server");
      expect(servers[0]!.source).toBe("enterprise");
    });

    it("parses .mcp.json as project source", async () => {
      const config = {
        mcpServers: {
          "project-server": { command: "node", args: ["./mcp-server.js"] },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "project-mcp.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeCodeMcpJson(filePath, "project");

      expect(servers).toHaveLength(1);
      expect(servers[0]!.source).toBe("project");
    });
  });

  describe("parseClaudeHomeJson", () => {
    it("parses top-level mcpServers", async () => {
      const config = {
        mcpServers: {
          "global-server": { command: "npx", args: ["-y", "some-server"] },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "claude-home.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeHomeJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("global-server");
      expect(servers[0]!.source).toBe("user");
      expect(servers[0]!.projectName).toBeUndefined();
    });

    it("parses project-specific mcpServers", async () => {
      const config = {
        projects: {
          "/Users/test/my-project": {
            mcpServers: {
              "project-server": { command: "node", args: ["server.js"] },
            },
          },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "claude-home-projects.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeHomeJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("project-server");
      expect(servers[0]!.source).toBe("project");
      expect(servers[0]!.projectName).toBe("/Users/test/my-project");
    });

    it("combines top-level and project servers", async () => {
      const config = {
        mcpServers: { global: { command: "global-cmd" } },
        projects: {
          "/path/to/proj": {
            mcpServers: { local: { command: "local-cmd" } },
          },
        },
      };

      const filePath = await createTempConfig(
        testTmpDir,
        "claude-home-combined.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeHomeJson(filePath);

      expect(servers).toHaveLength(2);
      const global = servers.find((s) => s.name === "global");
      const local = servers.find((s) => s.name === "local");
      expect(global).toBeDefined();
      expect(local).toBeDefined();
      expect(global!.source).toBe("user");
      expect(local!.source).toBe("project");
    });
  });

  describe("parseClaudeDedicatedMcpServers", () => {
    it("parses wrapped format with mcpServers key", async () => {
      const config = {
        mcpServers: {
          "wrapped-server": { command: "npx", args: ["server"] },
        },
      };
      const filePath = await createTempConfig(
        testTmpDir,
        "mcp-servers-wrapped.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeDedicatedMcpServers(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("wrapped-server");
    });

    it("parses direct mapping format", async () => {
      const config = {
        "direct-server": { command: "node", args: ["direct.js"] },
      };
      const filePath = await createTempConfig(
        testTmpDir,
        "mcp-servers-direct.json",
        JSON.stringify(config),
      );
      const servers = await parseClaudeDedicatedMcpServers(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("direct-server");
    });
  });

  describe("parseCursorMcpJson", () => {
    it("parses Cursor mcp.json", async () => {
      const config = {
        mcpServers: {
          "cursor-server": {
            command: "npx",
            args: ["-y", "@cursor/mcp-server"],
          },
        },
      };
      const filePath = await createTempConfig(
        testTmpDir,
        "cursor-mcp.json",
        JSON.stringify(config),
      );
      const servers = await parseCursorMcpJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.client).toBe("cursor");
    });
  });

  // Regression test for the home-dir-as-workspace bug: if a Cursor workspace.json's
  // `folder` field points at $HOME, the synthesized `<folder>/.cursor/mcp.json` aliases
  // the global ~/.cursor/mcp.json (which is the user-scope config, not project-scope).
  // The synthesized entry must be dropped so the same file isn't tagged 'project' and
  // wrongly skipped from quarantine downstream.
  describe("getCursorProjectMcpPaths", () => {
    // Skipped on Windows because the workspaceStorage path resolution there reads
    // APPDATA rather than HOME and would need a different env-var override.
    const itPosix = platform() === "win32" ? it.skip : it;

    itPosix(
      "skips workspaces rooted at $HOME (would alias global ~/.cursor/mcp.json)",
      async () => {
        const fakeHome = await createTempDir();
        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
          const storageDir = getCursorWorkspaceStoragePath();
          await fs.mkdir(storageDir, { recursive: true });

          // Workspace #1: rooted at $HOME - synthesized path would equal the global
          // ~/.cursor/mcp.json. This entry must be dropped.
          const homeWsDir = join(storageDir, "ws-home-hash");
          await fs.mkdir(homeWsDir, { recursive: true });
          await fs.writeFile(
            join(homeWsDir, "workspace.json"),
            JSON.stringify({ folder: pathToFileURL(fakeHome).href }),
            "utf-8",
          );

          // Workspace #2: rooted at a real subdirectory - must still be discovered.
          const realProjectDir = join(fakeHome, "work", "real-project");
          await fs.mkdir(realProjectDir, { recursive: true });
          const realWsDir = join(storageDir, "ws-real-hash");
          await fs.mkdir(realWsDir, { recursive: true });
          await fs.writeFile(
            join(realWsDir, "workspace.json"),
            JSON.stringify({ folder: pathToFileURL(realProjectDir).href }),
            "utf-8",
          );

          const paths = await getCursorProjectMcpPaths();

          const aliasedGlobal = join(fakeHome, ".cursor", "mcp.json");
          const realProjectMcp = join(
            realProjectDir,
            ".cursor",
            "mcp.json",
          );

          expect(paths).not.toContain(aliasedGlobal);
          expect(paths).toContain(realProjectMcp);
        } finally {
          if (originalHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = originalHome;
          }
          await cleanupDir(fakeHome);
        }
      },
    );
  });

  describe("parseWindsurfMcpJson", () => {
    it("parses Windsurf mcp_config.json", async () => {
      const config = {
        mcpServers: {
          "windsurf-server": {
            type: "sse",
            url: "https://windsurf.example.com/mcp",
          },
        },
      };
      const filePath = await createTempConfig(
        testTmpDir,
        "windsurf-mcp.json",
        JSON.stringify(config),
      );
      const servers = await parseWindsurfMcpJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.client).toBe("windsurf");
    });
  });

  describe("parseZedSettingsJson", () => {
    it("parses Zed settings.json with context_servers", async () => {
      const config = {
        theme: "dark",
        context_servers: {
          "zed-server": { command: "npx", args: ["zed-mcp"] },
        },
      };
      const filePath = await createTempConfig(
        testTmpDir,
        "zed-settings.json",
        JSON.stringify(config),
      );
      const servers = await parseZedSettingsJson(filePath);

      expect(servers).toHaveLength(1);
      expect(servers[0]!.client).toBe("zed");
    });

    it("handles missing context_servers key", async () => {
      const filePath = await createTempConfig(
        testTmpDir,
        "zed-no-context.json",
        JSON.stringify({ theme: "dark" }),
      );
      const servers = await parseZedSettingsJson(filePath);
      expect(servers).toHaveLength(0);
    });
  });

});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe("Edge Cases and Error Handling", () => {
  let edgeCaseTmpDir: string;

  beforeAll(async () => {
    edgeCaseTmpDir = await createTempDir();
  });

  afterAll(async () => {
    await cleanupDir(edgeCaseTmpDir);
  });

  it("throws on invalid JSON", async () => {
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "invalid.json",
      "{ invalid json }",
    );
    await expect(parseClaudeCodeSettingsJson(filePath)).rejects.toThrow();
  });

  it("throws on non-existent file", async () => {
    await expect(
      parseClaudeCodeSettingsJson("/non/existent/path.json"),
    ).rejects.toThrow();
  });

  it("handles server with all optional fields", async () => {
    const config = {
      mcpServers: {
        "full-server": {
          command: "node",
          args: ["--port", "3000"],
          env: { NODE_ENV: "production", DEBUG: "true" },
          envFile: ".env.local",
        },
      },
    };
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "full-server.json",
      JSON.stringify(config),
    );
    const servers = await parseClaudeCodeSettingsJson(filePath);

    expect(servers).toHaveLength(1);
    const c = servers[0]!.config as {
      command: string;
      args: string[];
      env: Record<string, string>;
      envFile: string;
    };
    expect(c.command).toBe("node");
    expect(c.args).toEqual(["--port", "3000"]);
    expect(c.env).toEqual({ NODE_ENV: "production", DEBUG: "true" });
    expect(c.envFile).toBe(".env.local");
  });

  it("handles HTTP server with headers", async () => {
    const config = {
      servers: {
        "auth-server": {
          type: "http",
          url: "https://api.example.com/mcp",
          headers: {
            Authorization: "Bearer token123",
            "X-Custom-Header": "custom-value",
          },
        },
      },
    };
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "http-headers.json",
      JSON.stringify(config),
    );
    const servers = await parseVscodeMcpJson(filePath);

    expect(servers).toHaveLength(1);
    const c = servers[0]!.config as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(c.type).toBe("http");
    expect(c.url).toBe("https://api.example.com/mcp");
    expect(c.headers).toEqual({
      Authorization: "Bearer token123",
      "X-Custom-Header": "custom-value",
    });
  });

  it("handles multiple servers in one config", async () => {
    const config = {
      mcpServers: {
        server1: { command: "cmd1" },
        server2: { command: "cmd2" },
        server3: { command: "cmd3" },
        server4: { type: "http", url: "https://example.com" },
        server5: { type: "sse", url: "https://sse.example.com" },
      },
    };
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "multi-server.json",
      JSON.stringify(config),
    );
    const servers = await parseClaudeCodeSettingsJson(filePath);

    expect(servers).toHaveLength(5);
    const names = servers.map((s) => s.name).sort();
    expect(names).toEqual([
      "server1",
      "server2",
      "server3",
      "server4",
      "server5",
    ]);
  });

  it("handles unicode server names", async () => {
    const config = {
      mcpServers: {
        "サーバー-日本語": { command: "cmd" },
        "servidor-español": { command: "cmd" },
        "сервер-русский": { command: "cmd" },
      },
    };
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "unicode-names.json",
      JSON.stringify(config),
    );
    const servers = await parseClaudeCodeSettingsJson(filePath);
    expect(servers).toHaveLength(3);
  });

  it("handles special characters in command args", async () => {
    const config = {
      mcpServers: {
        "special-args": {
          command: "node",
          args: [
            "--path=/tmp/test dir/file.js",
            '--flag="quoted value"',
            "-e",
            "console.log('hello')",
          ],
        },
      },
    };
    const filePath = await createTempConfig(
      edgeCaseTmpDir,
      "special-args.json",
      JSON.stringify(config),
    );
    const servers = await parseClaudeCodeSettingsJson(filePath);
    expect((servers[0]!.config as { args: string[] }).args).toEqual([
      "--path=/tmp/test dir/file.js",
      '--flag="quoted value"',
      "-e",
      "console.log('hello')",
    ]);
  });
});

// ============================================================================
// discoverMcpServers, getServerFingerprint, JetBrains
// ============================================================================

describe("discoverMcpServers and fingerprinting", () => {
  it("discoverMcpServers returns an array of DiscoveredMcpServer", async () => {
    const servers = await discoverMcpServers();
    expect(Array.isArray(servers)).toBe(true);
    for (const s of servers) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.client).toBe("string");
      expect(typeof s.path).toBe("string");
      expect(s.config).toBeDefined();
      expect(
        ["user", "workspace", "remote", "unknown", "enterprise", "project", "marketplace", "plugin"],
      ).toContain(s.source);
    }
  });

  it("getServerFingerprint is stable for same input", () => {
    const server: DiscoveredMcpServer = {
      name: "test-server",
      client: "cursor",
      source: "user",
      path: "/tmp/mcp.json",
      config: { command: "npx", args: ["-y", "some-server"] },
    };
    const fp1 = getServerFingerprint(server);
    const fp2 = getServerFingerprint(server);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
    expect(fp1).toMatch(/^[0-9a-f]+$/);
  });

  it("getServerFingerprint differs for different name/command", () => {
    const a: DiscoveredMcpServer = {
      name: "a",
      client: "cursor",
      source: "user",
      path: "/p",
      config: { command: "cmd", args: ["x"] },
    };
    const b: DiscoveredMcpServer = {
      name: "b",
      client: "cursor",
      source: "user",
      path: "/p",
      config: { command: "cmd", args: ["x"] },
    };
    expect(getServerFingerprint(a)).not.toBe(getServerFingerprint(b));
  });

  it("fingerprint changes when command changes", () => {
    const base: DiscoveredMcpServer = {
      name: "s",
      client: "cursor",
      source: "user",
      path: "/p",
      config: { command: "cmd1", args: [] },
    };
    const modified: DiscoveredMcpServer = {
      ...base,
      config: { command: "cmd2", args: [] },
    };
    expect(getServerFingerprint(base)).not.toBe(
      getServerFingerprint(modified),
    );
  });

  it("fingerprint changes when args change", () => {
    const base: DiscoveredMcpServer = {
      name: "s",
      client: "cursor",
      source: "user",
      path: "/p",
      config: { command: "cmd", args: ["a"] },
    };
    const modified: DiscoveredMcpServer = {
      ...base,
      config: { command: "cmd", args: ["b"] },
    };
    expect(getServerFingerprint(base)).not.toBe(
      getServerFingerprint(modified),
    );
  });
});

describe("JetBrains parsing", () => {
  let jetbrainsTmpDir: string;

  beforeAll(async () => {
    jetbrainsTmpDir = await createTempDir();
  });

  afterAll(async () => {
    await cleanupDir(jetbrainsTmpDir);
  });

  it("parseJetBrainsServersJson parses mcpServers shape", async () => {
    const config = {
      mcpServers: {
        "jb-server": { command: "node", args: ["server.js"] },
      },
    };
    const filePath = await createTempConfig(
      jetbrainsTmpDir,
      "jetbrains-servers.json",
      JSON.stringify(config),
    );
    const servers = await parseJetBrainsServersJson(filePath, "intellij");

    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("jb-server");
    expect(servers[0]!.client).toBe("intellij");
    expect(servers[0]!.source).toBe("user");
    expect(servers[0]!.path).toBe(filePath);
  });

  it("getJetBrainsMcpConfigPaths returns array", async () => {
    const paths = await getJetBrainsMcpConfigPaths();
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths) {
      expect(["intellij", "pycharm", "webstorm"]).toContain(p.client);
      expect(p.path).toMatch(/mcp.*servers\.json/);
    }
  });
});
