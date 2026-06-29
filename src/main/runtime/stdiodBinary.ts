import { existsSync, copyFileSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

// Resolve the absolute path to the edison-stdiod binary as it ships inside the
// app.
//
// In a packaged build the binary lives at <resources>/bin/edison-stdiod
// (staged by the build-stdiod* scripts and copied via the extraResources rule
// in electron-builder.yml). In dev we point at the cargo target directory
// inside the repo so `npm run dev` works without a full package build - the dev
// workflow expects the developer to have run `cargo build --release` (or a
// build-stdiod script) at least once.
//
// On Linux this path is EPHEMERAL: the AppImage mounts at a different
// /tmp/.mount_* directory every launch, so it must not be baked into anything
// long-lived (e.g. a systemd unit's ExecStart). Use getStdiodBinaryPath() for
// that - it returns the stable copy. This function is the source for staging.
function getBundledStdiodBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'edison-stdiod.exe' : 'edison-stdiod'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', exe)
  }
  // __dirname in dev is <repo>/client_2/out/main; three steps up reaches
  // the repo root (out/main -> out -> client_2 -> <repo>).
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  return path.join(repoRoot, 'stdiod', 'target', 'release', exe)
}

// Stable on-disk home for the daemon on packaged Linux. The AppImage mount path
// changes every launch, so a systemd unit whose ExecStart points into the mount
// breaks the moment the app closes (status=203/EXEC -> crash-loop). We copy the
// daemon out to this fixed path and run/install from there. mac/win bundle paths
// are already stable inside the .app / install dir, so they don't need this.
function getStableLinuxBinaryPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'edison-watch', 'bin', 'edison-stdiod')
}

// Whether this platform needs the copy-to-stable-location dance (packaged Linux
// only). In dev the cargo target path is already stable.
function usesStableLinuxCopy(): boolean {
  return process.platform === 'linux' && app.isPackaged
}

// The daemon path the app should invoke and that the systemd unit references.
// On packaged Linux this is the stable copy (created by stageStdiodBinary);
// everywhere else it's the bundled path.
export function getStdiodBinaryPath(): string {
  return usesStableLinuxCopy() ? getStableLinuxBinaryPath() : getBundledStdiodBinaryPath()
}

// Copy the bundled daemon to the stable Linux path when missing or changed
// (size differs -> app was updated with a new daemon). No-op on mac/win and in
// dev. Idempotent and cheap; safe to call on every startup before any daemon
// command runs. Returns the resolved binary path.
export function stageStdiodBinary(): string {
  if (!usesStableLinuxCopy()) return getBundledStdiodBinaryPath()
  const src = getBundledStdiodBinaryPath()
  const dst = getStableLinuxBinaryPath()
  try {
    const srcSize = statSync(src).size
    const needsCopy = !existsSync(dst) || statSync(dst).size !== srcSize
    if (needsCopy) {
      mkdirSync(path.dirname(dst), { recursive: true })
      copyFileSync(src, dst)
      chmodSync(dst, 0o755)
    }
  } catch {
    // Source unreadable (e.g. a mount race) - leave any existing copy in place.
    // Callers detect a still-missing binary via stdiodBinaryExists().
  }
  return dst
}

export function stdiodBinaryExists(): boolean {
  return existsSync(getStdiodBinaryPath())
}
