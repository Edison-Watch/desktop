import { existsSync } from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

// Absolute path to the bundled Windows Python (packaged resources/python/python.exe,
// or dev bin/python/<arch>); null on non-Windows or when unstaged.
export function getBundledPythonPath(): string | null {
  if (process.platform !== 'win32') return null

  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'python', 'python.exe')
    return existsSync(packaged) ? packaged : null
  }

  // Dev: optional staged copy under client_2/bin (__dirname is client_2/out/main).
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const devPath = path.resolve(__dirname, '..', '..', 'bin', 'python', arch, 'python.exe')
  return existsSync(devPath) ? devPath : null
}
