import { AGENT_REGISTRY, type AgentId } from '@edison/shared/agent-registry'
import type { McpClientId } from '../discovery/mcpDiscovery'

/** Escape HTML special characters to prevent XSS injection. */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const FALLBACK_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>`

/** Get an SVG icon for a client (built from the shared agent registry). */
export function getClientIcon(client: McpClientId, _iconIdSuffix?: string): string {
  const entry = AGENT_REGISTRY[client as AgentId]
  if (!entry) return FALLBACK_ICON

  if (entry.svgPath) {
    // Dialog icons are bare SVGs without a brandColor background wrapper, so
    // they must use currentColor (inherits CSS accent) instead of svgFill
    // (which assumes a contrasting brandColor background like in AppLogo).
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${entry.svgPath}"/></svg>`
  }

  if (entry.customSvg) {
    const vb = entry.customViewBox ?? '0 0 24 24'
    return `<svg width="16" height="16" viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${entry.customSvg}</svg>`
  }

  return FALLBACK_ICON
}
