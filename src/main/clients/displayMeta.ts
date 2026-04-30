/**
 * Display metadata (name + brand color) for every supported client.
 *
 * Mirrors the entries in `@edison/shared/agent-registry`. Duplicated here so
 * main-process code can build ClientIntegration objects without dragging the
 * shared package into test module graphs (vitest can't resolve subpath
 * exports of an unbuilt package). Keep in sync with the shared registry.
 */
import type { McpClientId } from '../discovery/types'

export interface ClientDisplay {
  name: string
  brandColor: string
}

export const CLIENT_DISPLAY: Record<McpClientId, ClientDisplay> = {
  'claude-code': { name: 'Claude Code', brandColor: '#1A1A1A' },
  'claude-desktop': { name: 'Claude Desktop', brandColor: '#D97757' },
  'claude-cowork': { name: 'Claude Cowork', brandColor: '#C4745B' },
  codex: { name: 'Codex', brandColor: '#000000' },
  cursor: { name: 'Cursor', brandColor: '#000000' },
  vscode: { name: 'VS Code', brandColor: '#007ACC' },
  windsurf: { name: 'Windsurf', brandColor: '#0EA5E9' },
  zed: { name: 'Zed', brandColor: '#084CCF' },
  intellij: { name: 'IntelliJ IDEA', brandColor: '#000000' },
  pycharm: { name: 'PyCharm', brandColor: '#21D789' },
  webstorm: { name: 'WebStorm', brandColor: '#07C3F2' },
}
