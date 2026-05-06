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

import { SeenServersStore, getServerFingerprint } from "../discovery/seenServersStore";
import type { DiscoveredMcpServer } from "../discovery/mcpDiscovery";

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

    it("templatized URL: concrete embedded token matches its templatized form", () => {
      // Discovery sees the live token in the user's mcp.json; backend stored
      // the templatized form at submit time. detectSecrets() should pull the
      // token out so both fingerprints land on the same value.
      const concrete = makeHttp(
        "zap",
        "https://mcp.zapier.com/api/v1/connect?token=MmUwOWM2MDQtMzU1Zi00NjhlLTlkMWE",
      );
      const templated = makeHttp(
        "zap",
        "https://mcp.zapier.com/api/v1/connect?token={TOKEN}",
      );
      expect(getServerFingerprint(concrete)).toBe(getServerFingerprint(templated));
    });

    it("templatized URL: placeholder variable name does not affect fingerprint", () => {
      // Two clients that auto-name the same secret differently still match.
      const a = makeHttp("zap", "https://mcp.zapier.com/api/v1/connect?token={TOKEN}");
      const b = makeHttp(
        "zap",
        "https://mcp.zapier.com/api/v1/connect?token={SOME_TOKEN}",
      );
      expect(getServerFingerprint(a)).toBe(getServerFingerprint(b));
    });
  });

  const ORG_A = "00000000-0000-0000-0000-00000000000a";
  const ORG_B = "00000000-0000-0000-0000-00000000000b";

  describe("SeenServersStore", () => {
    it("creates new store with empty state", async () => {
      const storePath = join(testDir, "seen.json");
      const store = new SeenServersStore(storePath);

      const all = await store.getAll();
      expect(all).toEqual([]);
    });

    it("marks server as seen under a given org", async () => {
      const storePath = join(testDir, "seen-mark.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("my-server");

      await store.markSeen(ORG_A, server);
      expect(await store.hasSeen(ORG_A, server)).toBe(true);
    });

    it("hasSeen returns false for unknown server in this org", async () => {
      const storePath = join(testDir, "seen-unknown.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("unknown-server");

      expect(await store.hasSeen(ORG_A, server)).toBe(false);
    });

    it("hasSeen is scoped per org - same server, different org is unknown", async () => {
      const storePath = join(testDir, "seen-org-scope.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("shared-name");

      await store.markSeen(ORG_A, server, "registered");
      expect(await store.hasSeen(ORG_A, server)).toBe(true);
      expect(await store.hasSeen(ORG_B, server)).toBe(false);
    });

    it("marks and queries server action", async () => {
      const storePath = join(testDir, "seen-action.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("action-server");

      await store.markSeen(ORG_A, server, "quarantined");
      expect(await store.hasAction(ORG_A, server)).toBe(true);

      const fp = getServerFingerprint(server);
      const entry = await store.get(ORG_A, fp);
      expect(entry).not.toBeNull();
      expect(entry!.org_id).toBe(ORG_A);
      expect(entry!.action).toBe("quarantined");
    });

    it("updates action on existing server", async () => {
      const storePath = join(testDir, "seen-update.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("update-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(ORG_A, server, "quarantined");
      await store.markAction(ORG_A, fp, "requested");

      const entry = await store.get(ORG_A, fp);
      expect(entry!.action).toBe("requested");
    });

    it("removes server from store", async () => {
      const storePath = join(testDir, "seen-remove.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("remove-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(ORG_A, server);
      expect(await store.hasSeen(ORG_A, server)).toBe(true);

      await store.remove(ORG_A, fp);
      expect(await store.hasSeen(ORG_A, server)).toBe(false);
    });

    it("clears all servers", async () => {
      const storePath = join(testDir, "seen-clear.json");
      const store = new SeenServersStore(storePath);

      await store.markSeen(ORG_A, makeServer("a"));
      await store.markSeen(ORG_A, makeServer("b"));
      await store.markSeen(ORG_B, makeServer("c"));

      expect((await store.getAll()).length).toBe(3);

      await store.clear();
      expect((await store.getAll()).length).toBe(0);
    });

    it("persists across store instances", async () => {
      const storePath = join(testDir, "seen-persist.json");
      const server = makeServer("persist-server");

      const store1 = new SeenServersStore(storePath);
      await store1.markSeen(ORG_A, server, "dismissed");

      const store2 = new SeenServersStore(storePath);
      expect(await store2.hasSeen(ORG_A, server)).toBe(true);

      const fp = getServerFingerprint(server);
      const entry = await store2.get(ORG_A, fp);
      expect(entry!.action).toBe("dismissed");
    });

    it("drops legacy (un-scoped) entries on load", async () => {
      // Write a pre-org-scoping file by hand - keys are bare fingerprints and
      // entries have no org_id. The store should silently drop these.
      const storePath = join(testDir, "seen-legacy.json");
      const legacy = {
        version: 1,
        servers: {
          "deadbeefcafef00d": {
            fingerprint: "deadbeefcafef00d",
            name: "legacy",
            sourceApp: "cursor",
            configPath: "/tmp/x",
            firstSeenAt: 1,
            lastSeenAt: 1,
            action: "registered",
            actionAt: 1,
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(legacy), "utf-8");

      const store = new SeenServersStore(storePath);
      expect(await store.getAll()).toEqual([]);
    });

    it("stores quarantine info", async () => {
      const storePath = join(testDir, "seen-quarantine.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("q-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(ORG_A, server, "quarantined", {
        disabledPath: "/tmp/disabled/mcp.json",
        quarantinedAt: "2025-01-01T00:00:00Z",
      });

      const entry = await store.get(ORG_A, fp);
      expect(entry!.disabledPath).toBe("/tmp/disabled/mcp.json");
      expect(entry!.quarantinedAt).toBe("2025-01-01T00:00:00Z");
    });
  });

  describe("markFromBackend", () => {
    it("creates a new registered entry when none exists locally", async () => {
      const storePath = join(testDir, "seen-backend-new.json");
      const store = new SeenServersStore(storePath);

      await store.markFromBackend(ORG_A, "abcd1234abcd1234", "reddit", "registered");

      const entry = await store.get(ORG_A, "abcd1234abcd1234");
      expect(entry).not.toBeNull();
      expect(entry!.fingerprint).toBe("abcd1234abcd1234");
      expect(entry!.org_id).toBe(ORG_A);
      expect(entry!.name).toBe("reddit");
      expect(entry!.action).toBe("registered");
      expect(entry!.actionAt).not.toBeNull();
    });

    it("creates a 'requested' entry when backend reports a pending admin review", async () => {
      const storePath = join(testDir, "seen-backend-requested.json");
      const store = new SeenServersStore(storePath);

      await store.markFromBackend(ORG_A, "ffff0000ffff0000", "slack", "requested");

      const entry = await store.get(ORG_A, "ffff0000ffff0000");
      expect(entry).not.toBeNull();
      expect(entry!.action).toBe("requested");
    });

    it("backend wins: overwrites a local 'dismissed' action with the backend action", async () => {
      const storePath = join(testDir, "seen-backend-overwrite.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("dismissed-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(ORG_A, server, "dismissed");
      expect((await store.get(ORG_A, fp))!.action).toBe("dismissed");

      await store.markFromBackend(ORG_A, fp, server.name, "registered");
      expect((await store.get(ORG_A, fp))!.action).toBe("registered");
    });

    it("preserves firstSeenAt and disabledPath from existing entry", async () => {
      const storePath = join(testDir, "seen-backend-preserve.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("preserved-server");
      const fp = getServerFingerprint(server);

      await store.markSeen(ORG_A, server, "quarantined", {
        disabledPath: "/tmp/disabled/foo.json",
        quarantinedAt: "2025-01-01T00:00:00Z",
      });
      const before = (await store.get(ORG_A, fp))!;

      await new Promise((r) => setTimeout(r, 5));
      await store.markFromBackend(ORG_A, fp, server.name, "registered");

      const after = (await store.get(ORG_A, fp))!;
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

      await store.markSeen(ORG_A, server, "quarantined");
      await store.markFromBackend(ORG_A, fp, "backend-name", "registered");

      expect((await store.get(ORG_A, fp))!.name).toBe("local-name");
    });
  });

  describe("pruneForOrg", () => {
    it("removes entries for the target org not in keep-set", async () => {
      const storePath = join(testDir, "seen-prune.json");
      const store = new SeenServersStore(storePath);
      const keep = makeServer("keep");
      const drop = makeServer("drop");

      await store.markSeen(ORG_A, keep, "registered");
      await store.markSeen(ORG_A, drop, "requested");

      await store.pruneForOrg(
        ORG_A,
        new Set([getServerFingerprint(keep)]),
      );

      expect(await store.hasSeen(ORG_A, keep)).toBe(true);
      expect(await store.hasSeen(ORG_A, drop)).toBe(false);
    });

    it("leaves entries for other orgs untouched", async () => {
      const storePath = join(testDir, "seen-prune-other-org.json");
      const store = new SeenServersStore(storePath);
      const server = makeServer("other-org-server");

      await store.markSeen(ORG_B, server, "registered");
      await store.pruneForOrg(ORG_A, new Set());

      expect(await store.hasSeen(ORG_B, server)).toBe(true);
    });
  });
});
