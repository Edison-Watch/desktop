import { OPENAI_PATH } from '../shared/logoPaths'
import type { McpClientId } from './mcpDiscovery'

/** Escape HTML special characters to prevent XSS injection. */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** Get an SVG icon for a client (Simple Icons / official brand SVGs). */
export function getClientIcon(client: McpClientId, _iconIdSuffix?: string): string {
  switch (client) {
    case 'vscode':
    case 'vscode-insiders':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>`
    case 'cursor':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>`
    case 'claude-desktop':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`
    case 'claude-code':
      return `<svg width="16" height="16" viewBox="0 -15 90 90" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="0" width="5" height="20"/><path d="M20 0 h10 v10 h-5 v10 h-5 z"/><rect x="30" y="0" width="30" height="20"/><path d="M60 0 h10 v20 h-5 v-10 h-5 z"/><rect x="70" y="0" width="5" height="20"/><rect x="5" y="20" width="5" height="10"/><path d="M10 20 h10 v20 h-5 v-10 h-5 z"/><rect x="20" y="20" width="50" height="20"/><path d="M70 20 h10 v10 h-5 v10 h-5 z"/><rect x="80" y="20" width="5" height="10"/><rect x="20" y="40" width="5" height="10"/><rect x="30" y="40" width="5" height="10"/><rect x="55" y="40" width="5" height="10"/><rect x="65" y="40" width="5" height="10"/></svg>`
    case 'windsurf':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z"/></svg>`
    case 'zed':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z"/></svg>`
    case 'codex':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${OPENAI_PATH}"/></svg>`
    case 'intellij':
    case 'pycharm':
    case 'webstorm':
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0v24h24V0zm10.5 4.5h3v15h-3zM16.5 4.5h3v15h-3zM5.25 7.5v9h13.5v-9z"/></svg>`
    default:
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>`
  }
}
