/**
 * macOS .app bundle names for each client, plus the existence probe used to
 * filter discovered MCPs to clients that are actually installed.
 *
 * Lives in a leaf module so client integrations can import it without
 * forming a cycle through the CLIENTS registry.
 */
import { promises as fs } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

/** On macOS, map client ids to possible .app bundle names. */
export const MAC_APP_NAMES: Record<string, string[]> = {
  vscode: ['Visual Studio Code.app'],
  cursor: ['Cursor.app'],
  // Claude Desktop and Cowork ship the same .app bundle. Cowork is
  // distinguished only by the `vm_bundles/` sibling directory under
  // ~/Library/Application Support/Claude/, which is checked separately
  // (see clients/claude-cowork/index.ts and the detectClients handler).
  'claude-desktop': ['Claude.app'],
  'claude-cowork': ['Claude.app'],
  windsurf: ['Windsurf.app'],
  zed: ['Zed.app'],
  intellij: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app', 'IntelliJ IDEA Ultimate.app'],
  pycharm: ['PyCharm.app', 'PyCharm CE.app'],
  webstorm: ['WebStorm.app'],
}

/** On macOS, check whether a GUI client's .app bundle exists. CLI-only clients always pass. */
export async function macAppExists(clientId: string): Promise<boolean> {
  if (platform() !== 'darwin') return true
  const appNames = MAC_APP_NAMES[clientId]
  if (!appNames) return true
  for (const appName of appNames) {
    try { await fs.access(join('/Applications', appName)); return true } catch { /* */ }
    try { await fs.access(join(homedir(), 'Applications', appName)); return true } catch { /* */ }
  }
  return false
}
