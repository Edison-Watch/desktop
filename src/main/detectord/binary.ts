import { createHash } from 'node:crypto'
import { existsSync, copyFileSync, mkdirSync, chmodSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

// Resolve the absolute path to the mcp_detector_daemon (edison-detectord) binary
// as it ships inside the app.
//
// Packaged: <resources>/bin/edison-detectord (staged by the build-detectord*
// scripts, copied via the extraResources rule in electron-builder.yml). Dev: the
// cargo target dir in the sibling detectord/ clone, where the binary keeps its
// cargo name `mcp_detector_daemon`; run `cargo build --release` (or a
// build-detectord script) there once.
//
// On Linux this path is EPHEMERAL: the AppImage mounts at a different
// /tmp/.mount_* directory every launch, so it must not be baked into anything
// long-lived (e.g. a systemd unit's ExecStart). Use getDetectordBinaryPath() for
// that - it returns the stable copy. This function is the source for staging.
function getBundledDetectordBinaryPath(): string {
  const win = process.platform === 'win32'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', win ? 'edison-detectord.exe' : 'edison-detectord')
  }
  // __dirname in dev is <repo>/desktop/out/main. Accept either the cargo dev
  // build (detectord/target/release, plain `cargo build --release`) or the
  // staged binary (desktop/bin, `npm run build:detectord`).
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const candidates = [
    path.join(repoRoot, 'detectord', 'target', 'release', win ? 'mcp_detector_daemon.exe' : 'mcp_detector_daemon'),
    path.join(__dirname, '..', '..', 'bin', win ? 'edison-detectord.exe' : 'edison-detectord')
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

// Stable on-disk home for the daemon on packaged Linux. The AppImage mount path
// changes every launch, so a systemd unit whose ExecStart points into the mount
// breaks the moment the app closes (status=203/EXEC -> crash-loop). We copy the
// daemon out to this fixed path and run/install from there. Same base dir as
// stdiod (~/.local/share/edison-watch/bin). mac/win bundle paths are already
// stable inside the .app / install dir, so they don't need this.
function getStableLinuxBinaryPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'edison-watch', 'bin', 'edison-detectord')
}

// Whether this platform needs the copy-to-stable-location dance (packaged Linux
// only). In dev the cargo target path is already stable.
function usesStableLinuxCopy(): boolean {
  return process.platform === 'linux' && app.isPackaged
}

// The daemon path the app should invoke and that the systemd unit references.
// On packaged Linux this is the stable copy (created by stageDetectordBinary);
// everywhere else it's the bundled path.
export function getDetectordBinaryPath(): string {
  return usesStableLinuxCopy() ? getStableLinuxBinaryPath() : getBundledDetectordBinaryPath()
}

// Whether two files have identical contents. Size is checked first as a cheap
// reject (a differing size can't be the same file); only when sizes match do we
// hash both. Size alone is NOT a safe "unchanged" signal: an app update can ship
// a new daemon of identical byte size, which a size-only check would miss,
// leaving the stale copy in place (running the old daemon). Throws if either
// file is unreadable, so the caller keeps any existing copy.
function sameContents(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false
  const hash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
  return hash(a) === hash(b)
}

// Copy the bundled daemon to the stable Linux path when missing or changed
// (contents differ -> app was updated with a new daemon). No-op on mac/win and
// in dev. Idempotent and cheap; safe to call on every startup before any daemon
// command runs. Returns the resolved binary path.
export function stageDetectordBinary(): string {
  if (!usesStableLinuxCopy()) return getBundledDetectordBinaryPath()
  const src = getBundledDetectordBinaryPath()
  const dst = getStableLinuxBinaryPath()
  try {
    const needsCopy = !existsSync(dst) || !sameContents(src, dst)
    if (needsCopy) {
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      chmodSync(dst, 0o755)
    }
  } catch {
    // Source unreadable (e.g. a mount race) - leave any existing copy in place.
    // Callers detect a still-missing binary via detectordBinaryExists().
  }
  return dst
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
