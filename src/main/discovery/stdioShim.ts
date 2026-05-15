/**
 * Detect and unwrap stdio shims (currently only `mcp-remote`) so a discovered
 * server like `{ command: "npx", args: ["-y", "mcp-remote", "https://x", "--header", "Authorization: Bearer …"] }`
 * is treated as the HTTP/SSE server it actually is.
 *
 * Two rules for the rest of the client:
 *
 * 1. If a shim is present and a URL is recoverable, replace `config` with the
 *    URL-shaped form. Downstream code (submit to backend, dedup, credential
 *    review) then sees a normal HTTP server.
 * 2. If a `command` is present and no shim wraps a URL, the server stays in
 *    its original stdio shape but is excluded from quarantine and listed as
 *    unsupported with "Local stdio servers are not yet supported".
 */

import type { McpServerConfig } from './types'

/** Concrete shape returned by a successful unwrap: HTTP or SSE with a URL. */
export interface UnwrappedRemoteConfig {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

/** Recognized launchers that may invoke `mcp-remote`. */
const LAUNCHER_RE = /^(npx|bunx|pnpx|yarn|pnpm)$/

/**
 * Coerce a raw `args` value into a string array.
 *
 * Standard MCP configs use `string[]`, but Cursor (and hand-edited files)
 * commonly store it as a single shell-style string, e.g.
 *   "args": "-y mcp-remote https://x --header 'Authorization: Bearer abc'"
 *
 * Tokenize whitespace-separated tokens with minimal quote support: single
 * and double quoted segments are kept as one token (quotes stripped). No
 * escape-sequence handling - discovered configs aren't shell scripts.
 */
function coerceArgs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((a) => String(a))
  if (typeof raw !== 'string') return []
  const out: string[] = []
  const re = /[^\s'"]+|"([^"]*)"|'([^']*)'/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[0])
  }
  return out
}

/** Matches `mcp-remote`, `mcp-remote@latest`, `mcp-remote@1.2.3`, or path/to/mcp-remote. */
const MCP_REMOTE_RE = /(^|\/)mcp-remote(@[\w.+-]+)?$/

/**
 * mcp-remote flags that take a value as the next token. Anything outside this
 * set is treated as a boolean flag unless the following token is clearly not
 * a URL. This prevents `--allow-http https://x` from swallowing the URL.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--header',
  '-H',
  '--transport',
  '--client',
  '--port',
  '--callback-port',
])

/**
 * Try to interpret `config` as a stdio invocation of `mcp-remote` wrapping a
 * remote MCP URL. Returns the URL-shaped config when successful, else null.
 *
 * Rules:
 * - The launcher is `npx` / `bunx` / `pnpx` / `yarn` / `pnpm`, or the command
 *   is itself `mcp-remote` (bare invocation).
 * - For `yarn` and `pnpm`, the next token must be `dlx` or `exec`.
 * - The first `https?://` arg after the `mcp-remote` token is taken as the URL.
 *   `--header` pairs are folded into the headers map; other flags
 *   (`--transport`, `--allow-http`, `--debug`, …) are dropped.
 * - Transport: `sse` if the URL path ends in `/sse` (with optional query), else `http`.
 *
 * Returns null if the config isn't a shim, or if the shim is malformed
 * (e.g. mcp-remote with no URL).
 */
export function unwrapStdioShim(config: McpServerConfig): UnwrappedRemoteConfig | null {
  if (!('command' in config) || !config.command) return null

  const command = String(config.command)
  const args = coerceArgs((config as { args?: unknown }).args)

  // Locate the `mcp-remote` token within the command/args.
  let remoteIdx = -1
  if (MCP_REMOTE_RE.test(command)) {
    remoteIdx = -1 // bare invocation: walk the whole args list
  } else if (LAUNCHER_RE.test(command)) {
    let start = 0
    if ((command === 'yarn' || command === 'pnpm') && (args[0] === 'dlx' || args[0] === 'exec')) {
      start = 1
    }
    for (let i = start; i < args.length; i++) {
      const a = args[i]
      if (a === undefined) continue
      // Skip launcher flags like `-y`, `--yes`.
      if (a.startsWith('-')) continue
      if (MCP_REMOTE_RE.test(a)) {
        remoteIdx = i
        break
      }
      // Anything else as the first non-flag positional means this isn't an
      // mcp-remote invocation (it's some other package).
      return null
    }
    if (remoteIdx < 0) return null
  } else {
    return null
  }

  // Extract URL and headers from the args after the mcp-remote token.
  let url: string | undefined
  const headers: Record<string, string> = {}
  let i = remoteIdx + 1
  while (i < args.length) {
    const tok = args[i]
    if (tok === undefined) { i += 1; continue }
    if (tok === '--header' || tok === '-H') {
      const value = args[i + 1]
      if (value) {
        const sep = value.indexOf(':')
        if (sep > 0) {
          const name = value.slice(0, sep).trim()
          const val = value.slice(sep + 1).trimStart()
          if (name) headers[name] = val
        }
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (tok.startsWith('--') || tok.startsWith('-')) {
      // Skip flags. mcp-remote mixes booleans (`--debug`, `--allow-http`,
      // `--ignore-robots-txt`, `--clean`, `--headers-from-stdin`) with
      // value-taking ones (`--transport`, `--client`, `--port`,
      // `--callback-port`). The dangerous case is a boolean flag placed
      // immediately before the URL: a naive "consume next non-flag token"
      // rule would swallow the URL and the unwrap would silently fail. Use
      // an allowlist for known value-taking flags; for anything else, only
      // pair with the next token if that token doesn't look like a URL.
      const next = args[i + 1]
      const takesValue = VALUE_FLAGS.has(tok)
      const nextLooksLikeUrl = next !== undefined && /^https?:\/\//i.test(next)
      if (next !== undefined && !next.startsWith('-') && (takesValue || !nextLooksLikeUrl)) {
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (!url && /^https?:\/\//i.test(tok)) {
      url = tok
      i += 1
      continue
    }
    i += 1
  }

  if (!url) return null

  const path = url.split('?')[0]!.replace(/\/+$/, '')
  const type: 'sse' | 'http' = path.endsWith('/sse') ? 'sse' : 'http'

  return Object.keys(headers).length > 0 ? { type, url, headers } : { type, url }
}

/**
 * True iff `config` declares a `command` but doesn't (or can't) wrap a URL via
 * a known stdio shim. Used by discovery to mark such servers unsupported and
 * by the quarantine monitor to leave them alone.
 */
export function isLocalStdioConfig(config: McpServerConfig): boolean {
  if (!('command' in config) || !config.command) return false
  if ('url' in config && config.url) return false
  return unwrapStdioShim(config) === null
}
