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

// Inject a real SeenServersStore pointed at a temp file by mocking
// getSharedSeenStore - the helper just calls .markRegisteredFromBackend on it.
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
    apiBaseUrlMock.mockReturnValue("https://api.example.com");
    credentialsMock.mockReturnValue({
      apiKey: "edison_test_key",
      edisonSecretKey: "user:abc.admin:def",
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupDir(testDir);
  });

  it("upserts each backend fingerprint as 'registered' in the local store", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fingerprints: [
          { name: "reddit", fingerprint: "1111aaaa1111aaaa" },
          { name: "datadog", fingerprint: "2222bbbb2222bbbb" },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await syncRegisteredServersFromBackend();

    // Both entries should now be in the store as registered
    const reddit = await injectedStore.get("1111aaaa1111aaaa");
    const datadog = await injectedStore.get("2222bbbb2222bbbb");
    expect(reddit).not.toBeNull();
    expect(datadog).not.toBeNull();
    expect(reddit!.action).toBe("registered");
    expect(datadog!.action).toBe("registered");
    expect(reddit!.name).toBe("reddit");
    expect(datadog!.name).toBe("datadog");
  });

  it("forwards Authorization and X-Edison-Secret-Key headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fingerprints: [] }),
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
      json: async () => ({ fingerprints: [] }),
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
    // Pre-seed the store so we can prove the sync doesn't wipe anything on failure
    await injectedStore.markRegisteredFromBackend("preserved-fp-1234", "preserved");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unreachable")),
    );

    await expect(syncRegisteredServersFromBackend()).resolves.toBeUndefined();

    // Existing entry must still be there
    const entry = await injectedStore.get("preserved-fp-1234");
    expect(entry).not.toBeNull();
    expect(entry!.action).toBe("registered");
  });

  it("silently no-ops on non-2xx HTTP response", async () => {
    await injectedStore.markRegisteredFromBackend("preserved-fp-5678", "preserved-2");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    );

    await expect(syncRegisteredServersFromBackend()).resolves.toBeUndefined();

    const entry = await injectedStore.get("preserved-fp-5678");
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

  it("ignores malformed entries in the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
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

    // Only the well-formed entry should land in the store
    const valid = await injectedStore.get("validfingerprint");
    expect(valid).not.toBeNull();
    expect(valid!.action).toBe("registered");

    const all = await injectedStore.getAll();
    expect(all).toHaveLength(1);
  });
});
