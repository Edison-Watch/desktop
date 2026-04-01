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

vi.mock("../sentry", () => ({ captureError: vi.fn() }));

const mockPaths: Record<string, string> = {};

vi.mock("../mcpDiscovery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../mcpDiscovery")>();
  return {
    ...actual,
    getVscodeUserMcpPath: () => mockPaths.vscode ?? "/tmp/nope",
    getCursorConfigPath: () => mockPaths.cursor ?? "/tmp/nope",
    getClaudeDesktopConfigPath: () =>
      mockPaths["claude-desktop"] ?? "/tmp/nope",
    getWindsurfConfigPath: () => mockPaths.windsurf ?? "/tmp/nope",
    getZedConfigPath: () => mockPaths.zed ?? "/tmp/nope",
    getClaudeCoworkConfigPath: () =>
      mockPaths["claude-cowork"] ?? "/tmp/nope",
    getJetBrainsMcpConfigPaths: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../hookInjectionClients", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../hookInjectionClients")>();
  return {
    ...actual,
    getCodexConfigPath: () => mockPaths.codex ?? "/tmp/nope",
  };
});

import {
  isEdisonWatchRegistered,
  findAppsNeedingReRegistration,
} from "../mcpConfigWriter";
import { getJetBrainsMcpConfigPaths } from "../mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers & constants
// ---------------------------------------------------------------------------
let testDir: string;
const EXPECTED_URL = "https://example.com/mcp/key123/";
const WRONG_URL = "https://old.example.com/mcp/oldkey/";

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    "selfheal-test-" + Date.now() + "-" + Math.random().toString(36),
  );
  await fs.mkdir(testDir, { recursive: true });
  for (const key of Object.keys(mockPaths)) delete mockPaths[key];
});

afterEach(async () => {
  try { await fs.rm(testDir, { recursive: true, force: true }); } catch { /* */ }
  vi.restoreAllMocks();
});

/** Write a JSON config file and wire up the mock path for the given appId. */
async function writeConfig(appId: string, content: unknown): Promise<string> {
  const configPath = join(testDir, `${appId}-config.json`);
  mockPaths[appId] = configPath;
  await fs.writeFile(configPath, JSON.stringify(content));
  return configPath;
}

// ===========================================================================
// isEdisonWatchRegistered
// ===========================================================================

describe("isEdisonWatchRegistered", () => {
  // --- Parameterized: apps using `mcpServers` key (JSON) ---
  describe.each([
    "cursor",
    "claude-desktop",
    "claude-cowork",
    "windsurf",
  ])("%s (mcpServers key)", (appId) => {
    it("returns false when config file does not exist", async () => {
      mockPaths[appId] = join(testDir, "nonexistent", "mcp.json");
      expect(await isEdisonWatchRegistered(appId)).toBe(false);
    });

    it("returns false when edison-watch is missing", async () => {
      await writeConfig(appId, { mcpServers: { other: { url: "http://x" } } });
      expect(await isEdisonWatchRegistered(appId)).toBe(false);
    });

    it("returns true when edison-watch exists with correct URL", async () => {
      await writeConfig(appId, {
        mcpServers: { "edison-watch": { type: "http", url: EXPECTED_URL } },
      });
      expect(await isEdisonWatchRegistered(appId, EXPECTED_URL)).toBe(true);
    });

    it("returns false when edison-watch has stale URL", async () => {
      await writeConfig(appId, {
        mcpServers: { "edison-watch": { type: "http", url: WRONG_URL } },
      });
      expect(await isEdisonWatchRegistered(appId, EXPECTED_URL)).toBe(false);
    });

    it("returns true when no expectedUrl check", async () => {
      await writeConfig(appId, {
        mcpServers: { "edison-watch": { type: "http", url: WRONG_URL } },
      });
      expect(await isEdisonWatchRegistered(appId)).toBe(true);
    });

    it("returns false on corrupt JSON", async () => {
      const p = join(testDir, `${appId}-config.json`);
      mockPaths[appId] = p;
      await fs.writeFile(p, "{{not valid json!!");
      expect(await isEdisonWatchRegistered(appId)).toBe(false);
    });
  });

  // --- Parameterized: apps using `servers` key (JSONC) ---
  describe.each(["vscode"])("%s (servers key, JSONC)", (appId) => {
    it("returns false when config file does not exist", async () => {
      mockPaths[appId] = join(testDir, "nonexistent", "mcp.json");
      expect(await isEdisonWatchRegistered(appId)).toBe(false);
    });

    it("returns true when edison-watch exists with correct URL", async () => {
      await writeConfig(appId, {
        servers: { "edison-watch": { type: "http", url: EXPECTED_URL } },
      });
      expect(await isEdisonWatchRegistered(appId, EXPECTED_URL)).toBe(true);
    });

    it("returns false when edison-watch has wrong URL", async () => {
      await writeConfig(appId, {
        servers: { "edison-watch": { type: "http", url: WRONG_URL } },
      });
      expect(await isEdisonWatchRegistered(appId, EXPECTED_URL)).toBe(false);
    });

    it("returns false when edison-watch missing", async () => {
      await writeConfig(appId, { servers: {} });
      expect(await isEdisonWatchRegistered(appId)).toBe(false);
    });
  });

  // VS Code-specific: JSONC with comments
  describe("vscode JSONC edge cases", () => {
    it("parses config with line and block comments", async () => {
      const p = join(testDir, "vscode-config.json");
      mockPaths.vscode = p;
      await fs.writeFile(p, `{
  // line comment
  "servers": {
    /* block comment */
    "edison-watch": { "type": "http", "url": "${EXPECTED_URL}" }
  }
}`);
      expect(await isEdisonWatchRegistered("vscode", EXPECTED_URL)).toBe(true);
    });

    it("returns false on corrupt JSONC", async () => {
      const p = join(testDir, "vscode-config.json");
      mockPaths.vscode = p;
      await fs.writeFile(p, "not valid {{{ jsonc //");
      expect(await isEdisonWatchRegistered("vscode")).toBe(false);
    });
  });

  // --- Zed (nested assistant.mcp_servers) ---
  describe("zed", () => {
    it("returns false when config file does not exist", async () => {
      mockPaths.zed = join(testDir, "nonexistent", "settings.json");
      expect(await isEdisonWatchRegistered("zed")).toBe(false);
    });

    it("returns true when edison-watch exists in nested structure", async () => {
      await writeConfig("zed", {
        assistant: { mcp_servers: { "edison-watch": { url: EXPECTED_URL } } },
      });
      expect(await isEdisonWatchRegistered("zed", EXPECTED_URL)).toBe(true);
    });

    it("returns false when assistant key is missing", async () => {
      await writeConfig("zed", { theme: "dark" });
      expect(await isEdisonWatchRegistered("zed")).toBe(false);
    });

    it("returns false when edison-watch is missing from mcp_servers", async () => {
      await writeConfig("zed", {
        assistant: { mcp_servers: { other: { url: "http://x" } } },
      });
      expect(await isEdisonWatchRegistered("zed")).toBe(false);
    });

    it("returns false when edison-watch has stale URL", async () => {
      await writeConfig("zed", {
        assistant: { mcp_servers: { "edison-watch": { url: WRONG_URL } } },
      });
      expect(await isEdisonWatchRegistered("zed", EXPECTED_URL)).toBe(false);
    });
  });

  // --- Codex (TOML) ---
  describe("codex", () => {
    async function writeToml(content: string) {
      const p = join(testDir, "codex-config.toml");
      mockPaths.codex = p;
      await fs.writeFile(p, content);
    }

    it("returns false when config file does not exist", async () => {
      mockPaths.codex = join(testDir, "nonexistent", "config.toml");
      expect(await isEdisonWatchRegistered("codex")).toBe(false);
    });

    it("returns true with correct URL", async () => {
      await writeToml(`[mcp_servers.edison-watch]\nurl = "${EXPECTED_URL}"\n`);
      expect(await isEdisonWatchRegistered("codex", EXPECTED_URL)).toBe(true);
    });

    it("returns false with wrong URL", async () => {
      await writeToml(`[mcp_servers.edison-watch]\nurl = "${WRONG_URL}"\n`);
      expect(await isEdisonWatchRegistered("codex", EXPECTED_URL)).toBe(false);
    });

    it("returns true when no expectedUrl check", async () => {
      await writeToml(`[mcp_servers.edison-watch]\nurl = "${WRONG_URL}"\n`);
      expect(await isEdisonWatchRegistered("codex")).toBe(true);
    });

    it("returns false when edison-watch section missing", async () => {
      await writeToml(`[mcp_servers.other-server]\nurl = "http://other"\n`);
      expect(await isEdisonWatchRegistered("codex")).toBe(false);
    });

    it("returns false on corrupt TOML", async () => {
      await writeToml("[[[invalid toml\ngarbage");
      expect(await isEdisonWatchRegistered("codex")).toBe(false);
    });

    it("returns false when edison-watch has no url key", async () => {
      await writeToml(`[mcp_servers.edison-watch]\nname = "test"\n`);
      expect(await isEdisonWatchRegistered("codex")).toBe(false);
    });
  });

  // --- JetBrains (directory scanning) ---
  describe.each([
    ["intellij" as const],
    ["pycharm" as const],
    ["webstorm" as const],
  ])("jetbrains — %s", (client) => {
    it("returns false when no config path matched", async () => {
      vi.mocked(getJetBrainsMcpConfigPaths).mockResolvedValue([]);
      expect(await isEdisonWatchRegistered(client)).toBe(false);
    });

    it("returns true when edison-watch exists with correct URL", async () => {
      const p = join(testDir, `${client}-servers.json`);
      await fs.writeFile(p, JSON.stringify({
        mcpServers: { "edison-watch": { type: "http", url: EXPECTED_URL } },
      }));
      vi.mocked(getJetBrainsMcpConfigPaths).mockResolvedValue([
        { client, path: p },
      ]);
      expect(await isEdisonWatchRegistered(client, EXPECTED_URL)).toBe(true);
    });

    it("returns false when edison-watch is missing", async () => {
      const p = join(testDir, `${client}-servers.json`);
      await fs.writeFile(p, JSON.stringify({
        mcpServers: { other: { url: "http://x" } },
      }));
      vi.mocked(getJetBrainsMcpConfigPaths).mockResolvedValue([
        { client, path: p },
      ]);
      expect(await isEdisonWatchRegistered(client)).toBe(false);
    });

    it("returns false when edison-watch has stale URL", async () => {
      const p = join(testDir, `${client}-servers.json`);
      await fs.writeFile(p, JSON.stringify({
        mcpServers: { "edison-watch": { type: "http", url: WRONG_URL } },
      }));
      vi.mocked(getJetBrainsMcpConfigPaths).mockResolvedValue([
        { client, path: p },
      ]);
      expect(await isEdisonWatchRegistered(client, EXPECTED_URL)).toBe(false);
    });
  });

  // --- claude-code (always deferred) ---
  it("claude-code always returns true", async () => {
    expect(await isEdisonWatchRegistered("claude-code")).toBe(true);
    expect(await isEdisonWatchRegistered("claude-code", EXPECTED_URL)).toBe(true);
  });
});

// ===========================================================================
// findAppsNeedingReRegistration
// ===========================================================================

describe("findAppsNeedingReRegistration", () => {
  it("returns [] when all apps registered with correct URL", async () => {
    await writeConfig("cursor", { mcpServers: { "edison-watch": { url: EXPECTED_URL } } });
    await writeConfig("windsurf", { mcpServers: { "edison-watch": { url: EXPECTED_URL } } });
    expect(
      await findAppsNeedingReRegistration(["cursor", "windsurf"], EXPECTED_URL),
    ).toEqual([]);
  });

  it("returns apps where edison-watch is missing", async () => {
    await writeConfig("cursor", { mcpServers: { "edison-watch": { url: EXPECTED_URL } } });
    await writeConfig("windsurf", { mcpServers: { other: { url: "http://x" } } });
    expect(
      await findAppsNeedingReRegistration(["cursor", "windsurf"], EXPECTED_URL),
    ).toEqual(["windsurf"]);
  });

  it("returns apps with stale URLs", async () => {
    await writeConfig("cursor", { mcpServers: { "edison-watch": { url: WRONG_URL } } });
    expect(
      await findAppsNeedingReRegistration(["cursor"], EXPECTED_URL),
    ).toEqual(["cursor"]);
  });

  it("returns mix of missing and stale apps", async () => {
    await writeConfig("cursor", { mcpServers: { "edison-watch": { url: WRONG_URL } } });
    mockPaths.windsurf = join(testDir, "nonexistent", "mcp.json");
    expect(
      await findAppsNeedingReRegistration(["cursor", "windsurf"], EXPECTED_URL),
    ).toEqual(["cursor", "windsurf"]);
  });

  it("returns [] for empty configuredApps", async () => {
    expect(await findAppsNeedingReRegistration([], EXPECTED_URL)).toEqual([]);
  });

  it("always skips claude-code", async () => {
    mockPaths.cursor = join(testDir, "nonexistent", "mcp.json");
    const result = await findAppsNeedingReRegistration(
      ["claude-code", "cursor"],
      EXPECTED_URL,
    );
    expect(result).toEqual(["cursor"]);
    expect(result).not.toContain("claude-code");
  });
});
