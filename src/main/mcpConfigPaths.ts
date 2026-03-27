/**
 * Aggregated MCP config-path registry.
 * Kept separate from mcpDiscovery.ts to stay within line limits.
 */
import {
  getVscodeUserMcpPath,
  getVscodeInsidersUserMcpPath,
  getClaudeDesktopConfigPath,
  getCursorConfigPath,
  getCursorWorkspaceStoragePath,
  getClaudeCodeUserSettingsPath,
  getClaudeCodeLocalSettingsPath,
  getClaudeCodeHomeJsonPath,
  getClaudeCodeDedicatedMcpPath,
  getWindsurfConfigPath,
  getZedConfigPath,
} from './mcpDiscovery'
import { getClaudeCoworkConfigPath } from './mcpDiscoveryCowork'

/** All config paths that should be monitored for changes. */
export interface McpConfigPaths {
  vscode: string
  vscodeInsiders: string
  claudeDesktop: string
  claudeCowork: string
  cursor: string
  cursorWorkspaceStorage: string
  claudeCode: string[]
  windsurf: string
  zed: string
}

export function getAllConfigPaths(): McpConfigPaths {
  return {
    vscode: getVscodeUserMcpPath(),
    vscodeInsiders: getVscodeInsidersUserMcpPath(),
    claudeDesktop: getClaudeDesktopConfigPath(),
    claudeCowork: getClaudeCoworkConfigPath(),
    cursor: getCursorConfigPath(),
    cursorWorkspaceStorage: getCursorWorkspaceStoragePath(),
    claudeCode: [
      getClaudeCodeUserSettingsPath(),
      getClaudeCodeLocalSettingsPath(),
      getClaudeCodeHomeJsonPath(),
      getClaudeCodeDedicatedMcpPath()
    ],
    windsurf: getWindsurfConfigPath(),
    zed: getZedConfigPath(),
  }
}
