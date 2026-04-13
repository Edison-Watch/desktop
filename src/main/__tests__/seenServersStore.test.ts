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

import { SeenServersStore, getServerFingerprint } from "../seenServersStore";
import type { DiscoveredMcpServer } from "../mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "seen-servers-test-" + Date.now() + "-" + Math.random().toString(36),
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

function makeServer(name: string, command = "cmd"): DiscoveredMcpServer {
  return {
    name,
    client: "cursor",
    source: "user",
    path: `/tmp/${name}-mcp.json`,
    config: { command, args: [] },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("seenServersStore", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupDir(testDir);
  });

  describe("getServerFingerprint", () => {
    it("returns consistent 16-char hex string", () => {
      const server = makeServer("test");
      const fp = getServerFingerprint(server);
      expect(fp).toHaveLength(16);
      expect(fp).toMatch(/^[0-9a-f]+$/);
      expect(getServerFingerprint(server)).toBe(fp);
    });

    it("returns different fingerprints for different servers", () => {
      const a = makeServer("server-a");
      const b = makeServer("server-b");
      expect(getServerFingerprint(a)).not.toBe(getServerFingerprint(b));
    });

    it("includes command in fingerprint", () => {
      const s1 = makeServer("test", "cmd1");
      const s2 = makeServer("test", "cmd2");
      expect(getServerFingerprint(s1)).not.toBe(getServerFingerprint(s2));
    });
  });

  // ----------------------------------------------------------------------
  // Cross-language fingerprint parity
  // ----------------------------------------------------------------------
  // The desktop client and the backend MUST produce identical fingerprints
  // for identical inputs, otherwise the silent-quarantine sync via
  // GET /api/v1/servers/fingerprints classifies known servers as unknown
  // (or vice-versa) and the user gets spurious dialogs.
  //
  // The pinned hex values below are duplicated verbatim in
  // tests/api_v1/test_servers_fingerprints.py::TestComputeServerFingerprint
  // - touching either side without updating the other should fail BOTH suites.
  // ----------------------------------------------------------------------
  describe("getServerFingerprint cross-language parity", () => {
    function makeStdio(name: string, command: string, args: string[]): DiscoveredMcpServer {
      return {
        name,
        client: "cursor",
        source: "user",
        path: `/tmp/${name}-mcp.json`,
        config: { command, args },
      };
    }
    function makeHttp(name: string, url: string): DiscoveredMcpServer {
      return {
        name,
        client: "cursor",
        source: "user",
        path: `/tmp/${name}-mcp.json`,
        config: { type: "http", url } as never,
      };
    }

    it("stdio: pinned fingerprint matches Python backend", () => {
      // Identifier under hash: "reddit:npx:-y reddit-mcp"
      // Verified in tests/api_v1/test_servers_fingerprints.py and via:
      //   node -e "const c=require('crypto');console.log(
      //     c.createHash('sha256').update('reddit:npx:-y reddit-mcp')
      //      .digest('hex').slice(0,16))"
      const fp = getServerFingerprint(makeStdio("reddit", "npx", ["-y", "reddit-mcp"]));
      expect(fp).toBe("b626e6c0e3dc647d");
    });

    it("http: pinned fingerprint matches Python backend", () => {
      // Identifier under hash: "api:https://api.example.com/mcp"
      const fp = getServerFingerprint(makeHttp("api", "https://api.example.com/mcp"));
      const expected = require("crypto")
        .createHash("sha256")
        .update("api:https://api.example.com/mcp")
        .digest("hex")
        .slice(0, 16);
      expect(fp).toBe(expected);
    });

    it("stdio with empty args: identifier ends in trailing colon", () => {
      // Identifier under hash: "solo:cli:"  (args.join(' ') === '')
      const fp = getServerFingerprint(makeStdio("solo", "cli", []));
      const expected = require("crypto")
        .createHash("sha256")
        .update("solo:cli:")
        .digest("hex")
        .slice(0, 16);
      expect(fp).toBe(expected);
    });
  });

  describe("SeenServersStore", () => {
    it("creates new store with empty state", async () => {
      const storePath = join(testDir, "seen.json");
      const store = new SeenServersStore(storePath);

      const all = await store.getAll();
      expect(all).toEqual([]);
    });

    it("marks server as seen", async () => {
      const storePath = join(testDir, "seen-mark.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("my-server");

      await store.markSeen(server);
      expect(await store.hasSeen(server)).toBe(true);
    });

    it("hasSeen returns false for unknown server", async () => {
      const storePath = join(testDir, "seen-unknown.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("unknown-server");

      expect(await store.hasSeen(server)).toBe(false);
    });

    it("marks and queries server action", async () => {
      const storePath = join(testDir, "seen-action.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("action-server");

      await store.markSeen(server, "quarantined");
      expect(await store.hasAction(server)).toBe(true);

      const fp = getServerFingerprint(server);
      const entry = await store.get(fp);
      expect(entry).not.toBeNull();
      expect(entry!.action).toBe("quarantined");
    });

    it("updates action on existing server", async () => {
      const storePath = join(testDir, "seen-update.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("update-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(server, "quarantined");
      await store.markAction(fp, "requested");

      const entry = await store.get(fp);
      expect(entry!.action).toBe("requested");
    });

    it("removes server from store", async () => {
      const storePath = join(testDir, "seen-remove.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("remove-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(server);
      expect(await store.hasSeen(server)).toBe(true);

      await store.remove(fp);
      expect(await store.hasSeen(server)).toBe(false);
    });

    it("clears all servers", async () => {
      const storePath = join(testDir, "seen-clear.json");
      const store = new SeenServersStore(storePath);

      await store.markSeen(makeServer("a"));
      await store.markSeen(makeServer("b"));
      await store.markSeen(makeServer("c"));

      expect((await store.getAll()).length).toBe(3);

      await store.clear();
      expect((await store.getAll()).length).toBe(0);
    });

    it("persists across store instances", async () => {
      const storePath = join(testDir, "seen-persist.json");
      const server = makeServer("persist-server");

      // First instance writes
      const store1 = new SeenServersStore(storePath);
      await store1.markSeen(server, "dismissed");

      // Second instance reads the same file
      const store2 = new SeenServersStore(storePath);
      expect(await store2.hasSeen(server)).toBe(true);

      const fp = getServerFingerprint(server);
      const entry = await store2.get(fp);
      expect(entry!.action).toBe("dismissed");
    });

    it("getAll returns all stored servers", async () => {
      const storePath = join(testDir, "seen-getall.json");
      const store = new SeenServersStore(storePath);

      await store.markSeen(makeServer("s1"));
      await store.markSeen(makeServer("s2"));

      const all = await store.getAll();
      expect(all).toHaveLength(2);
      const names = all.map((s) => s.name).sort();
      expect(names).toEqual(["s1", "s2"]);
    });

    it("stores quarantine info", async () => {
      const storePath = join(testDir, "seen-quarantine.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("q-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(server, "quarantined", {
        disabledPath: "/tmp/disabled/mcp.json",
        quarantinedAt: "2025-01-01T00:00:00Z",
      });

      const entry = await store.get(fp);
      expect(entry!.disabledPath).toBe("/tmp/disabled/mcp.json");
      expect(entry!.quarantinedAt).toBe("2025-01-01T00:00:00Z");
    });
  });

  describe("markRegisteredFromBackend", () => {
    it("creates a new registered entry when none exists locally", async () => {
      const storePath = join(testDir, "seen-backend-new.json");
      const store = new SeenServersStore(storePath);

      await store.markRegisteredFromBackend("abcd1234abcd1234", "reddit");

      const entry = await store.get("abcd1234abcd1234");
      expect(entry).not.toBeNull();
      expect(entry!.fingerprint).toBe("abcd1234abcd1234");
      expect(entry!.name).toBe("reddit");
      expect(entry!.action).toBe("registered");
      expect(entry!.actionAt).not.toBeNull();
    });

    it("backend wins: overwrites a local 'dismissed' action with 'registered'", async () => {
      const storePath = join(testDir, "seen-backend-overwrite.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("dismissed-server");
      const fp = getServerFingerprint(server);

      // User dismissed it locally first
      await store.markSeen(server, "dismissed");
      expect((await store.get(fp))!.action).toBe("dismissed");

      // Backend says it's registered - backend wins
      await store.markRegisteredFromBackend(fp, server.name);
      expect((await store.get(fp))!.action).toBe("registered");
    });

    it("preserves firstSeenAt and disabledPath from existing entry", async () => {
      const storePath = join(testDir, "seen-backend-preserve.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("preserved-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(server, "quarantined", {
        disabledPath: "/tmp/disabled/foo.json",
        quarantinedAt: "2025-01-01T00:00:00Z",
      });
      const before = (await store.get(fp))!;

      // Wait a tick so actionAt would differ
      await new Promise((r) => setTimeout(r, 5));
      await store.markRegisteredFromBackend(fp, server.name);

      const after = (await store.get(fp))!;
      expect(after.firstSeenAt).toBe(before.firstSeenAt);
      expect(after.disabledPath).toBe("/tmp/disabled/foo.json");
      expect(after.quarantinedAt).toBe("2025-01-01T00:00:00Z");
      expect(after.action).toBe("registered");
      expect(after.actionAt).toBeGreaterThanOrEqual(before.actionAt!);
    });

    it("uses backend-supplied name only when there is no existing entry", async () => {
      const storePath = join(testDir, "seen-backend-name.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("local-name");
      const fp = getServerFingerprint(server);

      await store.markSeen(server, "quarantined");
      // Backend reports a different name (e.g. an org-renamed server) - keep
      // the local name since the existing entry has the more accurate context.
      await store.markRegisteredFromBackend(fp, "backend-name");

      expect((await store.get(fp))!.name).toBe("local-name");
    });
  });
});
