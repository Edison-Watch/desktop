// Shared types for the stdiod daemon controller. Kept separate from
// controller.ts so the IPC handlers and the renderer (via preload) can
// import the type contract without pulling in Node-only modules.

export type ConnectionState =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'needs_reauth'
  | 'needs_upgrade'

export type ServerRunState = 'starting' | 'running' | 'crashed'

export interface StdiodServerEntry {
  name: string
  state: ServerRunState
  pid: number | null
}

// Mirrors the daemon's on-disk state.json schema (see
// stdiod/crates/edison-stdiod/src/state.rs). Fields are optional because
// the daemon may not have populated them yet on the first connection
// attempt.
export interface StdiodLiveState {
  connection_state: ConnectionState
  backend_url: string | null
  device_id: string | null
  device_label: string | null
  last_connected_at: string | null
  last_error: string | null
  servers: StdiodServerEntry[]
  generation: number
}

// What the renderer ultimately consumes. Combines the always-cheap
// "do we have a binary / is the unit installed" facts with the live
// state.json snapshot when available.
export interface StdiodStatus {
  binaryAvailable: boolean
  installed: boolean
  loggedIn: boolean
  state: StdiodLiveState | null
  // Wall-clock age (ms) of state.json. Used by the tray to flag a
  // "running but unresponsive" daemon - i.e. the launchctl unit reports
  // a PID but state.json hasn't been touched in minutes.
  stateAgeMs: number | null
}

export interface StdiodLoginInput {
  backend: string
  apiKey: string
  edisonSecretKey?: string
  deviceId?: string
  deviceLabel?: string
}

// Discriminated error surface - the renderer maps these to distinct UI
// messages (install button vs login prompt vs "binary missing, reinstall").
export type StdiodErrorCode =
  | 'binary_missing'
  | 'not_installed'
  | 'not_logged_in'
  | 'permission_denied'
  | 'spawn_failed'
  | 'unknown'

export interface StdiodResult<T = void> {
  ok: boolean
  value?: T
  errorCode?: StdiodErrorCode
  errorMessage?: string
}
