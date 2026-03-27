import { describe, it, expect } from "vitest";
import { detectSecrets } from "../secretDetection";
import type { DiscoveredMcpServer } from "../mcpDiscovery";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStdioServer(
  name: string,
  command: string,
  args?: string[],
  env?: Record<string, string>,
): DiscoveredMcpServer {
  return {
    name,
    client: "cursor",
    source: "user",
    path: `/tmp/${name}-mcp.json`,
    config: { command, ...(args && { args }), ...(env && { env }) },
  };
}

function makeHttpServer(
  name: string,
  url: string,
  headers?: Record<string, string>,
): DiscoveredMcpServer {
  return {
    name,
    client: "cursor",
    source: "user",
    path: `/tmp/${name}-mcp.json`,
    config: { url, ...(headers && { headers }) },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("detectSecrets", () => {
  // --------------------------------------------------------------------------
  // Stdio servers — args
  // --------------------------------------------------------------------------

  describe("stdio server args", () => {
    it("detects secret by sensitive flag name (--api-key)", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--api-key",
        "some-short-value",
      ]);
      const result = detectSecrets(server);
      expect(result.secretValues).toHaveProperty("API_KEY");
      expect(result.secretValues["API_KEY"]).toBe("some-short-value");
      expect(result.config).toHaveProperty("args");
      if ("args" in result.config && result.config.args) {
        expect(result.config.args).toContain("{API_KEY}");
      }
    });

    it("detects secret by known prefix (sk-)", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--key",
        "sk-1234567890abcdef",
      ]);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBeGreaterThan(0);
      expect(Object.values(result.secretValues)).toContain(
        "sk-1234567890abcdef",
      );
    });

    it("detects secret in --flag=value format", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--token=sk-live_abcdef1234567890",
      ]);
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "sk-live_abcdef1234567890",
      );
    });

    it("detects high-entropy standalone arg as secret", () => {
      const longKey = "sk-a1b2c3d4e5f6A7B8C9D0E1F2G3H4I5J6";
      const server = makeStdioServer("test", "node", ["server.js", longKey]);
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(longKey);
    });

    it("detects Bearer token in arg value", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--header",
        "Bearer my-secret-token-value",
      ]);
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "my-secret-token-value",
      );
      if ("args" in result.config && result.config.args) {
        const headerArg = result.config.args[2];
        expect(headerArg).toMatch(/^Bearer \{.*\}$/);
      }
    });

    it("skips non-secret flags like --verbose, --port", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--verbose",
        "true",
        "--port",
        "3000",
      ]);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });

    it("skips values that look like file paths", () => {
      const server = makeStdioServer("test", "node", [
        "server.js",
        "--config",
        "/home/user/.config/app.json",
      ]);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });

    it("skips -y flag (npx)", () => {
      const server = makeStdioServer("npx", "npx", ["-y", "some-package"]);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Stdio servers — env
  // --------------------------------------------------------------------------

  describe("stdio server env vars", () => {
    it("detects sensitive env var by key name", () => {
      const server = makeStdioServer("test", "node", ["server.js"], {
        API_KEY: "my-api-key-value",
      });
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("my-api-key-value");
      if ("env" in result.config && result.config.env) {
        expect(result.config.env["API_KEY"]).toMatch(/^\{.*\}$/);
      }
    });

    it("detects env var with known secret prefix value", () => {
      const server = makeStdioServer("test", "node", ["server.js"], {
        MY_VAR: "ghp_1234567890abcdef1234567890abcdef12345678",
      });
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "ghp_1234567890abcdef1234567890abcdef12345678",
      );
    });

    it("detects Bearer token in env var value", () => {
      const server = makeStdioServer("test", "node", ["server.js"], {
        AUTH_HEADER: "Bearer some-jwt-token-here",
      });
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "some-jwt-token-here",
      );
    });

    it("does not flag non-sensitive env var with short value", () => {
      const server = makeStdioServer("test", "node", ["server.js"], {
        NODE_ENV: "production",
        PORT: "3000",
      });
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // HTTP/SSE servers — URL credentials
  // --------------------------------------------------------------------------

  describe("HTTP server URL credentials", () => {
    it("detects user:pass in URL", () => {
      const server = makeHttpServer(
        "test",
        "https://admin:s3cret@api.example.com/mcp",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("s3cret");
      expect(Object.values(result.secretValues)).toContain("admin");
    });

    it("detects password-only in URL", () => {
      const server = makeHttpServer(
        "test",
        "https://:mypassword@api.example.com/mcp",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("mypassword");
    });
  });

  // --------------------------------------------------------------------------
  // HTTP/SSE servers — URL query parameters
  // --------------------------------------------------------------------------

  describe("HTTP server URL query parameters", () => {
    it("detects apiKey query parameter", () => {
      const server = makeHttpServer(
        "test",
        "https://api.ref.tools/mcp?apiKey=ref-9b5f5a63039ba5a9b0ab",
      );
      const result = detectSecrets(server);
      expect(result.secretValues).toHaveProperty("APIKEY");
      expect(result.secretValues["APIKEY"]).toBe("ref-9b5f5a63039ba5a9b0ab");
      if ("url" in result.config) {
        expect(result.config.url).toContain("{APIKEY}");
        expect(result.config.url).not.toContain("ref-9b5f5a63039ba5a9b0ab");
      }
    });

    it("detects token query parameter", () => {
      const server = makeHttpServer(
        "test",
        "https://api.example.com/mcp?token=abc123def456",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("abc123def456");
      if ("url" in result.config) {
        expect(result.config.url).not.toContain("abc123def456");
      }
    });

    it("detects access_token query parameter", () => {
      const server = makeHttpServer(
        "test",
        "https://api.example.com/mcp?access_token=xyz789",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("xyz789");
    });

    it("detects secret query parameter with known prefix value", () => {
      const server = makeHttpServer(
        "test",
        "https://api.example.com/mcp?param=sk-live_abcdef1234567890",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "sk-live_abcdef1234567890",
      );
    });

    it("preserves non-sensitive query parameters", () => {
      const server = makeHttpServer(
        "test",
        "https://api.example.com/mcp?format=json&apiKey=secret123",
      );
      const result = detectSecrets(server);
      if ("url" in result.config) {
        expect(result.config.url).toContain("format=json");
        expect(result.config.url).not.toContain("secret123");
      }
    });

    it("detects multiple sensitive query parameters", () => {
      const server = makeHttpServer(
        "test",
        "https://api.example.com/mcp?apiKey=key123&token=tok456",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("key123");
      expect(Object.values(result.secretValues)).toContain("tok456");
    });

    it("handles URL with both credentials and query params", () => {
      const server = makeHttpServer(
        "test",
        "https://user:pass@api.example.com/mcp?apiKey=key123",
      );
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("pass");
      expect(Object.values(result.secretValues)).toContain("key123");
    });
  });

  // --------------------------------------------------------------------------
  // HTTP/SSE servers — headers
  // --------------------------------------------------------------------------

  describe("HTTP server headers", () => {
    it("detects Authorization Bearer header", () => {
      const server = makeHttpServer("test", "https://api.example.com/mcp", {
        Authorization: "Bearer sk-1234567890abcdef",
      });
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain(
        "sk-1234567890abcdef",
      );
    });

    it("detects sensitive header by key name", () => {
      const server = makeHttpServer("test", "https://api.example.com/mcp", {
        "X-Api-Key": "my-secret-value",
      });
      const result = detectSecrets(server);
      expect(Object.values(result.secretValues)).toContain("my-secret-value");
    });

    it("does not flag non-sensitive headers", () => {
      const server = makeHttpServer("test", "https://api.example.com/mcp", {
        "Content-Type": "application/json",
        Accept: "text/plain",
      });
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe("edge cases", () => {
    it("returns config as-is for server with no secrets", () => {
      const server = makeStdioServer("test", "npx", ["-y", "some-mcp"]);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
      expect(Object.keys(result.templateFields).length).toBe(0);
    });

    it("generates unique var names when duplicates exist", () => {
      const server = makeStdioServer(
        "test",
        "node",
        ["server.js", "--api-key", "val1"],
        { API_KEY: "val2" },
      );
      const result = detectSecrets(server);
      const varNames = Object.keys(result.secretValues);
      // Should have 2 unique variable names
      expect(varNames.length).toBe(2);
      expect(new Set(varNames).size).toBe(2);
    });

    it("handles server with no args or env", () => {
      const server = makeStdioServer("test", "node", undefined, undefined);
      const result = detectSecrets(server);
      expect(Object.keys(result.secretValues).length).toBe(0);
    });

    it("handles connection string value", () => {
      const server = makeStdioServer("test", "node", ["server.js"], {
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      });
      const result = detectSecrets(server);
      // CONNECTION_STRING_PREFIXES detects this by value
      expect(
        Object.values(result.secretValues).some((v) =>
          v.startsWith("postgres://"),
        ),
      ).toBe(true);
    });
  });
});
