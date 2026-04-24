/**
 * ClientIntegration - uniform interface for every AI-agent desktop app we wrap.
 *
 * Each McpClientId maps to exactly one ClientIntegration object, registered in
 * `./registry.ts` as `CLIENTS[id]`. Orchestrators iterate over CLIENTS rather
 * than branching on id.
 *
 * This scaffolding PR introduces the interface and populates the fields
 * consumed by the existing orchestrators without behavior changes. Follow-up
 * PRs attach `edisonMcp` and `servers` sub-objects and rewrite each
 * orchestrator to use them.
 */
import type { McpConfigEntry } from './registry'
import type { DiscoveredMcpServer, McpClientId } from '../discovery/types'

// ── Session ID strategy (declare-only; consumed by status UI + docs) ─────────

/**
 * How this client's session id reaches our hook scripts.
 *
 * - `native-stdin`: the client passes a stable session/conversation id in the
 *   stdin JSON (`field` is the key name).
 * - `pid-scoped-file`: the SessionStart hook writes
 *   `~/.edison-watch/active_session_<ppid>.json` and PreToolUse reads it.
 * - `heuristic`: no reliable id; best-effort cwd/pid guess.
 * - `unsupported`: no mechanism exists today.
 */
export type SessionIdStrategy =
  | { kind: 'native-stdin'; field: string }
  | { kind: 'pid-scoped-file'; ppidBased: true }
  | { kind: 'heuristic'; note: string }
  | { kind: 'unsupported'; reason: string }

// ── Hook event mapping ───────────────────────────────────────────────────────

/** Edison's logical hook events; each client maps these to its native names. */
export type HookEvent =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool-use'
  | 'session-end'

/** How a single Edison event is wired into a client's native hook surface. */
export interface HookBinding {
  /** Native event name (e.g. `PreToolUse`, `beforeMCPExecution`, `Stop`). */
  nativeName: string
  /** Optional matcher (e.g. Claude Code's `mcp__*` tool filter). */
  matcher?: string
}

// ── Watch targets (declarative; consumed by the monitor refactor) ───────────

export interface DirWatchTarget {
  path: string
  /** chokidar depth. Cursor's workspaceStorage uses depth:1; plugin cache depth:3. */
  depth: number
  /** Optional predicate on the changed path to decide whether to react. */
  filter?: (path: string) => boolean
  onChange: 'rescan-dynamic-config-paths' | 'ignore'
}

export interface WatchTargets {
  /** Files watched directly (chokidar depth:0). Same entries as configEntries(). */
  files: McpConfigEntry[]
  /** Directory watchers with depth > 0. */
  dirs: DirWatchTarget[]
  /**
   * Whether the 20s periodic rescan should re-scan this client. True when MCPs
   * can appear without a config-file write (Cursor Extension API, deeplinks).
   */
  needsPeriodicRescan: boolean
}

// ── ClientIntegration interface ──────────────────────────────────────────────

export interface ClientIntegration {
  id: McpClientId

  /** Display metadata mirrored from @edison/shared agent-registry. */
  display: {
    name: string
    brandColor: string
  }

  isInstalled(): boolean

  discoverServers(): Promise<DiscoveredMcpServer[]>
  /** Static + dynamically scanned config paths (project, plugin, etc.). */
  configEntries(): Promise<McpConfigEntry[]>
  watchTargets(): Promise<WatchTargets>

  /**
   * Hook surface. Absent for clients without a hook system (Zed, JetBrains).
   *
   * `getStatus` and per-client edison-mcp registration operations are added in
   * follow-up PRs alongside the orchestrator rewrites (hookInjection and
   * mcpConfigWriter). Keeping this PR pure scaffolding avoids touching
   * orchestrator internals prematurely.
   */
  hooks?: {
    supportedEvents: Partial<Record<HookEvent, HookBinding>>
    sessionIdStrategy: SessionIdStrategy
    inject(): Promise<boolean>
    remove(): Promise<boolean>
  }

  /** `.backup.*` globs this client owns, for cleanup UX. */
  backups: {
    globs(): string[]
  }
}
