import { describe, expect, it } from "vitest";

import {
  isLocalStdioConfig,
  unwrapStdioShim,
} from "../discovery/stdioShim";
import type { McpServerConfig } from "../discovery/types";

describe("unwrapStdioShim", () => {
  it("returns null for plain stdio (not an mcp-remote shim)", () => {
    const cfg: McpServerConfig = { command: "node", args: ["server.js"] };
    expect(unwrapStdioShim(cfg)).toBeNull();
  });

  it("returns null when no command is present", () => {
    expect(unwrapStdioShim({ type: "http", url: "https://x" })).toBeNull();
  });

  it("unwraps `npx -y mcp-remote <url>` to an http config", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.example.com/v1"],
    };
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "http",
      url: "https://mcp.example.com/v1",
    });
  });

  it("treats a /sse-suffixed URL as an SSE server", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"],
    };
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "sse",
      url: "https://mcp.atlassian.com/v1/sse",
    });
  });

  it("treats a /sse?qs URL as SSE", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: ["mcp-remote", "https://x/sse?token=abc"],
    };
    expect(unwrapStdioShim(cfg)?.type).toBe("sse");
  });

  it("folds --header flags into a headers map", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header",
        "Authorization: Bearer abc",
        "--header",
        "X-Trace: 42",
      ],
    };
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer abc", "X-Trace": "42" },
    });
  });

  it("accepts the -H short form for headers", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: ["mcp-remote", "https://x/mcp", "-H", "X-Foo: bar"],
    };
    expect(unwrapStdioShim(cfg)?.headers).toEqual({ "X-Foo": "bar" });
  });

  it("preserves colons in header values (Bearer tokens with `:`)", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [
        "mcp-remote",
        "https://x/mcp",
        "--header",
        "X-Edison-Secret-Key: user:abc:def",
      ],
    };
    expect(unwrapStdioShim(cfg)?.headers).toEqual({
      "X-Edison-Secret-Key": "user:abc:def",
    });
  });

  it("drops unknown flags like --transport / --allow-http", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "https://x",
        "--transport",
        "http-only",
        "--allow-http",
      ],
    };
    expect(unwrapStdioShim(cfg)).toEqual({ type: "http", url: "https://x" });
  });

  it("matches mcp-remote@version specifiers", () => {
    const cfg: McpServerConfig = {
      command: "npx",
      args: ["-y", "mcp-remote@latest", "https://x"],
    };
    expect(unwrapStdioShim(cfg)?.url).toBe("https://x");
  });

  it("supports bare `mcp-remote` invocation (no launcher)", () => {
    const cfg: McpServerConfig = {
      command: "mcp-remote",
      args: ["https://x", "--header", "Authorization: Bearer t"],
    };
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("supports bunx, pnpx", () => {
    expect(
      unwrapStdioShim({ command: "bunx", args: ["mcp-remote", "https://x"] }),
    ).toEqual({ type: "http", url: "https://x" });
    expect(
      unwrapStdioShim({ command: "pnpx", args: ["mcp-remote", "https://x"] }),
    ).toEqual({ type: "http", url: "https://x" });
  });

  it("supports `yarn dlx mcp-remote …`", () => {
    expect(
      unwrapStdioShim({
        command: "yarn",
        args: ["dlx", "mcp-remote", "https://x"],
      }),
    ).toEqual({ type: "http", url: "https://x" });
  });

  it("returns null when mcp-remote is launched without a URL", () => {
    expect(
      unwrapStdioShim({ command: "npx", args: ["-y", "mcp-remote"] }),
    ).toBeNull();
  });

  it("returns null when the launcher invokes a different package", () => {
    expect(
      unwrapStdioShim({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      }),
    ).toBeNull();
  });

  it("ignores http:// (non-https) only when there is no URL", () => {
    // localhost/dev URLs are still legitimate.
    expect(
      unwrapStdioShim({
        command: "npx",
        args: ["mcp-remote", "http://localhost:3000/mcp"],
      })?.url,
    ).toBe("http://localhost:3000/mcp");
  });

  // ── Cursor-style string args (whitespace-separated, not a JSON array) ───

  it("tokenizes string-form args (Cursor mcp.json shape)", () => {
    const cfg = {
      command: "npx",
      args: "-y mcp-remote https://mcp.zapier.com/api/v1/connect?token=abc",
    } as unknown as McpServerConfig;
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "http",
      url: "https://mcp.zapier.com/api/v1/connect?token=abc",
    });
  });

  it("tokenizes string-form args with embedded quoted headers", () => {
    const cfg = {
      command: "npx",
      args:
        "-y mcp-remote https://x/mcp --header \"Authorization: Bearer abc\" --header 'X-Trace: 42'",
    } as unknown as McpServerConfig;
    expect(unwrapStdioShim(cfg)).toEqual({
      type: "http",
      url: "https://x/mcp",
      headers: { Authorization: "Bearer abc", "X-Trace": "42" },
    });
  });

  it("tokenizes the real-world Cursor refs URL with apiKey querystring", () => {
    const cfg = {
      command: "npx",
      args: "-y mcp-remote https://api.ref.tools/mcp?apiKey=ref-1234",
    } as unknown as McpServerConfig;
    expect(unwrapStdioShim(cfg)?.url).toBe(
      "https://api.ref.tools/mcp?apiKey=ref-1234",
    );
  });

  it("returns null when string args name a non-shim package", () => {
    const cfg = {
      command: "npx",
      args: "mcp-neo4j-aura-manager@0.4.7",
    } as unknown as McpServerConfig;
    expect(unwrapStdioShim(cfg)).toBeNull();
  });
});

describe("isLocalStdioConfig", () => {
  it("flags command-only configs that aren't shims", () => {
    expect(isLocalStdioConfig({ command: "node", args: ["s.js"] })).toBe(true);
  });

  it("does not flag mcp-remote shims (they are HTTP after unwrap)", () => {
    expect(
      isLocalStdioConfig({
        command: "npx",
        args: ["mcp-remote", "https://x"],
      }),
    ).toBe(false);
  });

  it("does not flag URL-only configs", () => {
    expect(isLocalStdioConfig({ type: "http", url: "https://x" })).toBe(false);
  });
});
