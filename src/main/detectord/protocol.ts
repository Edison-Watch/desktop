// TypeScript mirror of the daemon's wire protocol (detectord/crates/
// mcp_detector_daemon/src/protocol.rs). Newline-delimited JSON over the Unix
// socket: one Reply per Request (FIFO), plus unsolicited Event pushes.

export type Choice = 'send_to_ew' | 'skip'

export type Request =
  | {
      op: 'enroll'
      url: string
      key: string
      mcp_url?: string
      agents?: string[]
      secret?: string
      /** false = detect-only (no edison-watch install / hooks). Defaults true. */
      install?: boolean
      /** Arm auto-quarantine. Set true only once onboarding completes. */
      armed?: boolean
    }
  | { op: 'status'; refresh?: boolean }
  | { op: 'list_agents' }
  | { op: 'list_servers' }
  | { op: 'disposition'; name: string; agent?: string; choice: Choice; rename?: string }
  | { op: 'refresh_policy' }
  | { op: 'verify_secret'; key: string }
  | { op: 'reset_secret'; key: string; confirm: boolean }
  | { op: 'unenroll' }

export interface Status {
  user: string
  enrolled: boolean
  org_id?: string | null
  org_name?: string | null
  email?: string | null
  role?: string | null
  quarantine: boolean
  quarantined_count: number
  armed?: boolean
}

export interface AgentInfo {
  name: string
  installed: boolean
}

/** One discovered server instance. `state`: edison | known | new | opaque | report. */
// Mirrors the daemon's externally-tagged mcp_detector_lib::ServerConfig.
export type HttpKind = 'Http' | 'Sse' | 'StreamableHttp'
export type OpaqueReason = 'ExtensionProvider' | 'ExtensionServer' | 'CursorPlugin'
export type ServerConfig =
  | { Stdio: { command: string; args: string[]; env: Record<string, string> } }
  | { Http: { url: string; headers: Record<string, string>; kind: HttpKind } }
  | { Opaque: { removable: boolean; reason: OpaqueReason } }

export interface ServerView {
  name: string
  agent: string
  kind: string // stdio | http | opaque
  state: string
  fingerprint?: string | null
  path: string
  config?: ServerConfig | null
}

export interface SecretOutcome {
  valid?: boolean | null
  expired?: boolean | null
  deleted?: number | null
}

export type Reply =
  | ({ reply: 'status' } & Status)
  | { reply: 'agents'; agents: AgentInfo[] }
  | { reply: 'servers'; servers: ServerView[] }
  | ({ reply: 'secret' } & SecretOutcome)
  | { reply: 'ack' }
  | { reply: 'error'; message: string }

export type DetectordEvent =
  | ({ event: 'quarantined' } & ServerView)
  | ({ event: 'discovered' } & ServerView)
  | { event: 'policy_changed'; quarantine: boolean }

/** A line from the daemon is either a Reply or an Event. */
export function isEvent(msg: unknown): msg is DetectordEvent {
  return typeof msg === 'object' && msg !== null && 'event' in msg
}

export function isReply(msg: unknown): msg is Reply {
  return typeof msg === 'object' && msg !== null && 'reply' in msg
}
