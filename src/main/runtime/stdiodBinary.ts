import { existsSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

// Resolve the absolute path to the bundled edison-stdiod binary.
//
// In a packaged build the binary lives at Contents/Resources/bin/edison-stdiod
// (staged by client_2/scripts/build-stdiod.sh and copied via the
// mac.extraResources rule in electron-builder.yml). In dev we point at the
// cargo target directory inside the repo so `npm run dev` works without a
// full package build - the dev workflow expects the developer to have run
// `cargo build --release` (or the build-stdiod.sh script) at least once.
export function getStdiodBinaryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'edison-stdiod')
  }
  // __dirname in dev is <repo>/client_2/out/main; three steps up reaches
  // the repo root (out/main -> out -> client_2 -> <repo>).
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  return path.join(repoRoot, 'stdiod', 'target', 'release', 'edison-stdiod')
}

export function stdiodBinaryExists(): boolean {
  return existsSync(getStdiodBinaryPath())
}
