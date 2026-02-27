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
});
