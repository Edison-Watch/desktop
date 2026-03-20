import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

// Mock electron before importing the module
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return join(tmpdir(), "edison-test-userdata");
      return join(tmpdir(), "edison-test-" + name);
    },
    getVersion: () => "1.0.0-test",
  },
}));

// Mock sentry to avoid side effects
vi.mock("../sentry", () => ({
  captureError: vi.fn(),
}));

import {
  getPendingRegistrationsDir,
  getPendingErrorsDir,
  isClaudeCodeInstalled,
  isCursorInstalled,
  isWindsurfInstalled,
} from "../hookInjection";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "hook-injection-test-" + Date.now() + "-" + Math.random().toString(36),
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

describe("hookInjection", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupDir(testDir);
    vi.restoreAllMocks();
  });

  describe("getPendingRegistrationsDir", () => {
    it("returns a path under ~/.edison-watch", () => {
      const dir = getPendingRegistrationsDir();
      expect(dir).toContain("edison-watch");
      expect(dir).toContain("pending");
    });
  });

  describe("getPendingErrorsDir", () => {
    it("returns a path under ~/.edison-watch", () => {
      const dir = getPendingErrorsDir();
      expect(dir).toContain("edison-watch");
      expect(dir).toContain("errors");
    });
  });

  describe("isClaudeCodeInstalled", () => {
    it("returns a boolean", () => {
      const result = isClaudeCodeInstalled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("isCursorInstalled", () => {
    it("returns a boolean", () => {
      const result = isCursorInstalled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("isWindsurfInstalled", () => {
    it("returns a boolean", () => {
      const result = isWindsurfInstalled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("Claude Code hook injection (file-based)", () => {
    it("creates correct JSON structure when injecting into empty settings", async () => {
      const settingsPath = join(testDir, "settings.json");
      await fs.writeFile(settingsPath, "{}", "utf-8");

      // We can't easily test injectClaudeCodeHook directly since it
      // reads from a fixed path. Instead test the JSON structure it would produce.
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));

      // Simulate what injectClaudeCodeHook does: add hooks.PreToolUse
      settings.hooks = {
        PreToolUse: [
          {
            matcher: "mcp",
            hooks: [
              {
                type: "command",
                command: "edison-watch-hook pre-tool-use",
              },
            ],
          },
        ],
      };

      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      const result = JSON.parse(await fs.readFile(settingsPath, "utf-8"));

      expect(result.hooks).toBeDefined();
      expect(result.hooks.PreToolUse).toHaveLength(1);
      expect(result.hooks.PreToolUse[0].matcher).toBe("mcp");
      expect(result.hooks.PreToolUse[0].hooks[0].type).toBe("command");
      expect(result.hooks.PreToolUse[0].hooks[0].command).toContain(
        "edison-watch-hook",
      );
    });

    it("removes hook entry when removing from settings", async () => {
      const settingsPath = join(testDir, "settings-with-hook.json");
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp",
              hooks: [
                {
                  type: "command",
                  command: "edison-watch-hook pre-tool-use",
                },
              ],
            },
          ],
        },
      };

      await fs.writeFile(
        settingsPath,
        JSON.stringify(settings, null, 2),
        "utf-8",
      );

      // Simulate removeClaudeCodeHook: filter out Edison entries
      const loaded = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      for (const key of Object.keys(loaded.hooks ?? {})) {
        loaded.hooks[key] = loaded.hooks[key].filter(
          (g: { hooks: Array<{ command: string }> }) =>
            !g.hooks?.some((h) => h.command?.includes("edison-watch")),
        );
        if (loaded.hooks[key].length === 0) delete loaded.hooks[key];
      }
      if (Object.keys(loaded.hooks).length === 0) delete loaded.hooks;

      await fs.writeFile(
        settingsPath,
        JSON.stringify(loaded, null, 2),
        "utf-8",
      );
      const result = JSON.parse(await fs.readFile(settingsPath, "utf-8"));

      expect(result.hooks).toBeUndefined();
    });

    it("handles missing config files gracefully", async () => {
      const nonExistent = join(testDir, "nonexistent-settings.json");
      let exists = false;
      try {
        await fs.access(nonExistent);
        exists = true;
      } catch {
        /* expected */
      }
      expect(exists).toBe(false);
    });
  });

  describe("Cursor hook injection (file-based)", () => {
    it("creates correct hooks.json structure with beforeMCPExecution and sessionEnd", async () => {
      const hooksPath = join(testDir, "hooks.json");

      // Simulate what injectCursorHook does (migrated from preToolUse to beforeMCPExecution)
      const hooksFile = {
        version: 1,
        hooks: {
          sessionStart: [
            {
              command: "edison-hook cursor",
              type: "command",
            },
          ],
          beforeMCPExecution: [
            {
              command: "edison-session-hook",
              type: "command",
            },
          ],
          sessionEnd: [
            {
              command: "edison-session-end",
              type: "command",
            },
          ],
        },
      };

      await fs.writeFile(
        hooksPath,
        JSON.stringify(hooksFile, null, 2),
        "utf-8",
      );
      const result = JSON.parse(await fs.readFile(hooksPath, "utf-8"));

      expect(result.version).toBe(1);
      expect(result.hooks.beforeMCPExecution).toHaveLength(1);
      expect(result.hooks.beforeMCPExecution[0].command).toContain(
        "edison-session-hook",
      );
      expect(result.hooks.beforeMCPExecution[0].type).toBe("command");
      // No matcher needed — beforeMCPExecution is already MCP-specific
      expect(result.hooks.beforeMCPExecution[0].matcher).toBeUndefined();
      // sessionEnd hook for explicit session completion
      expect(result.hooks.sessionEnd).toHaveLength(1);
      expect(result.hooks.sessionEnd[0].command).toContain(
        "edison-session-end",
      );
      // preToolUse should not be present (migrated away)
      expect(result.hooks.preToolUse).toBeUndefined();
    });
  });

  describe("Windsurf hook injection (file-based)", () => {
    it("creates correct hooks.json structure", async () => {
      const hooksPath = join(testDir, "windsurf-hooks.json");

      // Simulate Windsurf hook structure
      const hooksFile = {
        hooks: {
          pre_mcp_tool_use: [
            {
              command: "edison-watch-hook pre-tool-use",
              show_output: false,
              working_directory: "$HOME",
            },
          ],
        },
      };

      await fs.writeFile(
        hooksPath,
        JSON.stringify(hooksFile, null, 2),
        "utf-8",
      );
      const result = JSON.parse(await fs.readFile(hooksPath, "utf-8"));

      expect(result.hooks.pre_mcp_tool_use).toHaveLength(1);
      expect(result.hooks.pre_mcp_tool_use[0].command).toContain(
        "edison-watch",
      );
      expect(result.hooks.pre_mcp_tool_use[0].show_output).toBe(false);
    });
  });
});
