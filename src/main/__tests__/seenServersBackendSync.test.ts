import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { promises as fs } from "fs";

// Mock electron - vi.mock factory must not reference outer variables
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return join(tmpdir(), "edison-test-userdata");
      return join(tmpdir(), "edison-test-" + name);
    },
    getVersion: () => "1.0.0-test",
  },
}));

// Mock setupConfig so the helper sees deterministic credentials
const apiBaseUrlMock = vi.fn<() => string | null>();
const credentialsMock = vi.fn<() => { apiKey: string; edisonSecretKey?: string } | null>();
vi.mock("../setupConfig", () => ({
  getApiBaseUrl: () => apiBaseUrlMock(),
  getCredentialsForEnv: () => credentialsMock(),
}));

// Mock orgIdCache so the test controls what "the client thinks its org is"
const cachedOrgIdMock = vi.fn<() => string | null>();
const refreshOrgIdMock = vi.fn<() => Promise<string | null>>();
vi.mock("../orgIdCache", () => ({
  getCachedOrgId: () => cachedOrgIdMock(),
  refreshOrgIdFromBackend: () => refreshOrgIdMock(),
}));

// Inject a real SeenServersStore pointed at a temp file by mocking
// getSharedSeenStore - the helper just calls .markFromBackend / .pruneForOrg on it.
import { SeenServersStore } from "../seenServersStore";
let injectedStore: SeenServersStore;
vi.mock("../seenServersStore", async () => {
  const actual = await vi.importActual<typeof import("../seenServersStore")>(
    "../seenServersStore",
  );
  return {
    ...actual,
    getSharedSeenStore: () => injectedStore,
  };
});

import { syncRegisteredServersFromBackend } from "../seenServersBackendSync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";

let testDir: string;

async function createTestDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    "seen-sync-test-" + Date.now() + "-" + Math.random().toString(36),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncRegisteredServersFromBackend", () => {
  beforeEach(async () => {
    testDir = await createTestDir();
    injectedStore = new SeenServersStore(join(testDir, "seen.json"));

    apiBaseUrlMock.mockReset();
    credentialsMock.mockReset();
    cachedOrgIdMock.mockReset();
    refreshOrgIdMock.mockReset();
    apiBaseUrlMock.mockReturnValue("https://api.example.com");
    credentialsMock.mockReturnValue({
      apiKey: "edison_test_key",
      edisonSecretKey: "user:abc.admin:def",
    });
    cachedOrgIdMock.mockReturnValue(ORG_A);
    refreshOrgIdMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupDir(testDir);
  });

  it("upserts each backend fingerprint with the backend-supplied status", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        org_id: ORG_A,
        fingerprints: [
          { name: "reddit", fingerprint: "1111aaaa1111aaaa", status: "registered" },
          { name: "datadog", fingerprint: "2222bbbb2222bbbb", status: "requested" },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    const reddit = await injectedStore.get(ORG_A, "1111aaaa1111aaaa");
    const datadog = await injectedStore.get(ORG_A, "2222bbbb2222bbbb");
    expect(reddit).not.toBeNull();
    expect(datadog).not.toBeNull();
    expect(reddit!.action).toBe("registered");
    // Pending admin-review: the entry is still silent-quarantine-eligible,
    // but classified as 'requested' to preserve the lifecycle distinction.
    expect(datadog!.action).toBe("requested");
    expect(reddit!.org_id).toBe(ORG_A);
  });

  it("does NOT prune a locally-requested server that is still pending in the backend", async () => {
    // Real-world scenario: user submits datadog → admin leaves it pending →
    // Cursor reinstalls the plugin → quarantine triggers sync. The backend
    // returns datadog with status='requested'; the prune must NOT remove it.
    await injectedStore.markSeen(ORG_A, {
      name: "datadog",
      client: "cursor",
      source: "plugin",
      path: "/tmp/datadog-mcp.json",
      config: { command: "node", args: ["datadog.js"] },
    }, "requested");
    const fpDatadog = (await injectedStore.getAllForOrg(ORG_A))[0].fingerprint;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: ORG_A,
          fingerprints: [
            { name: "datadog", fingerprint: fpDatadog, status: "requested" },
          ],
        }),
      }),
    );

    await syncRegisteredServersFromBackend();

    const entry = await injectedStore.get(ORG_A, fpDatadog);
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("requested");
  });

  it("forwards Authorization and X-Edison-Secret-Key headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ org_id: ORG_A, fingerprints: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, init] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.example.com/api/v1/servers/fingerprints");
    expect((init as RequestInit).method).toBe("GET");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer edison_test_key");
    expect(headers["X-Edison-Secret-Key"]).toBe("user:abc.admin:def");
  });

  it("omits the X-Edison-Secret-Key header when no secret key is configured", async () => {
    credentialsMock.mockReturnValue({ apiKey: "edison_test_key" });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ org_id: ORG_A, fingerprints: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer edison_test_key");
    expect(headers["X-Edison-Secret-Key"]).toBeUndefined();
  });

  it("silently no-ops on network error (preserves existing local state)", async () => {
    await injectedStore.markFromBackend(ORG_A, "preserved-fp-1234", "preserved", "registered");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unreachable")),
    );

    await expect(syncRegisteredServersFromBackend()).resolves.toBeUndefined();

    const entry = await injectedStore.get(ORG_A, "preserved-fp-1234");
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("registered");
  });

  it("silently no-ops on non-2xx HTTP response", async () => {
    await injectedStore.markFromBackend(ORG_A, "preserved-fp-5678", "preserved-2", "registered");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    );

    await expect(syncRegisteredServersFromBackend()).resolves.toBeUndefined();

    const entry = await injectedStore.get(ORG_A, "preserved-fp-5678");
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("registered");
  });

  it("silently no-ops when credentials are missing", async () => {
    credentialsMock.mockReturnValue(null);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("silently no-ops when no cached org_id", async () => {
    cachedOrgIdMock.mockReturnValue(null);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses to apply when response org_id does not match cached org_id", async () => {
    // Pre-seed an entry in ORG_A so we can prove it is NOT mutated
    await injectedStore.markFromBackend(ORG_A, "existing-fp", "existing", "registered");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: ORG_B, // ← mismatch
          fingerprints: [{ name: "evil", fingerprint: "evilevilevilevi" }],
        }),
      }),
    );

    await syncRegisteredServersFromBackend();

    // ORG_A entry untouched, ORG_B entry NOT created
    expect(await injectedStore.get(ORG_A, "existing-fp")).not.toBeNull();
    expect(await injectedStore.get(ORG_A, "evilevilevilevi")).toBeNull();
    expect(await injectedStore.get(ORG_B, "evilevilevilevi")).toBeNull();
  });

  it("ignores malformed entries in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: ORG_A,
          fingerprints: [
            { name: "valid", fingerprint: "validfingerprint" },
            { name: "bad-no-fp" },
            { fingerprint: "bad-no-name" },
            null,
            "totally bogus",
          ],
        }),
      }),
    );

    await syncRegisteredServersFromBackend();

    const valid = await injectedStore.get(ORG_A, "validfingerprint");
    expect(valid).not.toBeNull();
    expect(valid!.action).toBe("registered");

    const all = await injectedStore.getAll();
    expect(all).toHaveLength(1);
  });

  it("prunes stale entries for the current org that are not in the response", async () => {
    // Pre-seed two entries in ORG_A
    await injectedStore.markFromBackend(ORG_A, "keepfp1234567890", "keep", "registered");
    await injectedStore.markFromBackend(ORG_A, "dropfp1234567890", "drop", "requested");
    // And one in ORG_B that must NOT be touched
    await injectedStore.markFromBackend(ORG_B, "otherorgfp123456", "other", "registered");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          org_id: ORG_A,
          // Only "keep" is still registered server-side
          fingerprints: [{ name: "keep", fingerprint: "keepfp1234567890" }],
        }),
      }),
    );

    await syncRegisteredServersFromBackend();

    expect(await injectedStore.get(ORG_A, "keepfp1234567890")).not.toBeNull();
    expect(await injectedStore.get(ORG_A, "dropfp1234567890")).toBeNull();
    // ORG_B entry MUST survive the ORG_A prune
    expect(await injectedStore.get(ORG_B, "otherorgfp123456")).not.toBeNull();
  });
});
