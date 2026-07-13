import { existsSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

// Resolve the absolute path to the mcp_detector_daemon (edison-detectord) binary.
//
// Packaged: Contents/Resources/bin/edison-detectord (staged by
// scripts/build-detectord.sh, copied via mac.extraResources). Dev: the cargo
// target dir in the sibling detectord/ clone, where the binary keeps its cargo
// name `mcp_detector_daemon`; run `cargo build --release` (or build-detectord.sh)
// there once.
export function getDetectordBinaryPath(): string {
  const win = process.platform === 'win32'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', win ? 'edison-detectord.exe' : 'edison-detectord')
  }
  // __dirname in dev is <repo>/desktop/out/main. Accept either the cargo dev
  // build (detectord/target/release, plain `cargo build --release`) or the
  // staged universal binary (desktop/bin, `npm run build:detectord`).
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const candidates = [
    path.join(repoRoot, 'detectord', 'target', 'release', win ? 'mcp_detector_daemon.exe' : 'mcp_detector_daemon'),
    path.join(__dirname, '..', '..', 'bin', win ? 'edison-detectord.exe' : 'edison-detectord')
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

export function detectordBinaryExists(): boolean {
  return existsSync(getDetectordBinaryPath())
}

// The IPC endpoint the daemon serves. Must match the daemon's
// ipc::default_socket_path():
//   - Unix: base_dir/daemon.sock (base_dir = appData/edison-watch-detectord).
//   - Windows: a per-user named pipe `\\.\pipe\edison-detectord.<user>`, where
//     <user> uses the same USER||LOGNAME||USERNAME chain as the daemon's
//     paths::current_username(). Node's net.createConnection(string) connects to
//     a named pipe when the string is a `\\.\pipe\...` path.
export function detectordSocketPath(): string {
  if (process.platform === 'win32') {
    const user =
      process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'unknown'
    return `\\\\.\\pipe\\edison-detectord.${user}`
  }
  return path.join(app.getPath('appData'), 'edison-watch-detectord', 'daemon.sock')
}
