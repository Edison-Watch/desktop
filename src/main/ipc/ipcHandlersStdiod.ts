// IPC handlers for the stdiod daemon controller. Registered from
// ipcHandlers.ts via registerStdiodHandlers() - split out to keep the
// main IPC file under the project's file-size CI cap.

import { ipcMain } from 'electron'

import { getLogPath, getStatus, install, login, resetStdiod, uninstall } from '../stdiod/controller'
import type { StdiodLoginInput } from '../stdiod/types'

export function registerStdiodHandlers(): void {
  ipcMain.handle('stdiod:status', () => getStatus())
  ipcMain.handle('stdiod:install', () => install())
  ipcMain.handle('stdiod:login', (_event, input: StdiodLoginInput) => login(input))
  ipcMain.handle('stdiod:uninstall', (_event, opts?: { purge?: boolean }) => uninstall(opts ?? {}))
  ipcMain.handle('stdiod:reset', (_event, input: StdiodLoginInput) => resetStdiod(input))
  ipcMain.handle('stdiod:getLogPath', () => getLogPath())
}
