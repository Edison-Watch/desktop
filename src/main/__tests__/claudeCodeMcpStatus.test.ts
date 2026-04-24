import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron before importing the module
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => `/tmp/edison-test-${name}`,
    getVersion: () => "1.0.0-test",
  },
}));

// Mock @edison/shared/config (not resolvable in CI without workspace linking)
vi.mock("@edison/shared/config", () => ({
  getEnvByName: () => ({}),
}));

// Mock child_process - vi.hoisted ensures the variable is available at hoist time
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

import { checkClaudeCodeMcpConnection } from "../infra/setupConfig";

describe("checkClaudeCodeMcpConnection", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  function simulateStdout(stdout: string) {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
        cb(null, { stdout });
      },
    );
  }

  function simulateError(message: string) {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error(message));
      },
    );
  }

  it('returns "connected" when CLI reports ✓ Connected', async () => {
    simulateStdout("edison-watch:\n  Scope: User\n  Status: ✓ Connected\n");
    expect(await checkClaudeCodeMcpConnection()).toBe("connected");
  });

  it('returns "failed" when CLI reports ✗ Failed', async () => {
    simulateStdout("edison-watch:\n  Scope: Project\n  Status: ✗ Failed to connect\n");
    expect(await checkClaudeCodeMcpConnection()).toBe("failed");
  });

  it('returns "needs-auth" when CLI reports Needs authentication', async () => {
    simulateStdout("edison-watch:\n  Status: ! Needs authentication\n");
    expect(await checkClaudeCodeMcpConnection()).toBe("needs-auth");
  });

  it('returns "unknown" when CLI output has no recognised status marker', async () => {
    simulateStdout("edison-watch:\n  Something unexpected\n");
    expect(await checkClaudeCodeMcpConnection()).toBe("unknown");
  });

  it('returns "not-found" when CLI reports server not found in stderr', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: string }) => void) => {
        const err = Object.assign(new Error("Command failed: exit code 1"), {
          stderr: "No MCP server found with name: edison-watch",
        });
        cb(err);
      },
    );
    expect(await checkClaudeCodeMcpConnection()).toBe("not-found");
  });

  it('returns "unknown" when CLI exits with a generic error (no server-not-found message)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { code?: number }) => void) => {
        const err = Object.assign(new Error("Command failed: exit code 1"), { code: 1 });
        cb(err);
      },
    );
    expect(await checkClaudeCodeMcpConnection()).toBe("unknown");
  });

  it('returns "unknown" when claude CLI is not found (ENOENT)', async () => {
    simulateError("spawn claude ENOENT");
    expect(await checkClaudeCodeMcpConnection()).toBe("unknown");
  });

  it('returns "unknown" when spawn fails with EBADF (Electron file descriptor issue)', async () => {
    simulateError("spawn EBADF");
    expect(await checkClaudeCodeMcpConnection()).toBe("unknown");
  });

  it("calls claude mcp get with correct arguments", async () => {
    simulateStdout("Status: ✓ Connected\n");
    await checkClaudeCodeMcpConnection();
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["mcp", "get", "edison-watch"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function),
    );
  });

  it('returns "unknown" when CLI times out (killed)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { killed?: boolean }) => void) => {
        const err = Object.assign(new Error("Command timed out"), { killed: true });
        cb(err);
      },
    );
    expect(await checkClaudeCodeMcpConnection()).toBe("unknown");
  });
});
