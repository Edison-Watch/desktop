/**
 * Shared CSS styles for Electron BrowserWindow dialogs (quarantine, debug, etc.).
 * Both dialogs use inline HTML, so we export CSS as template strings.
 */

/**
 * Base CSS: reset, CSS variables (Edison palette), body, and shared typography.
 */
export const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --baseline-black: #000000;
    --grid-grey-50: #F9F9F9;
    --grid-grey-100: #C8C8C8;
    --grid-grey-200: #8F8F8F;
    --grid-grey-300: #555555;
    --grid-grey-400: #383838;
    --grid-grey-500: #1C1C1C;
    --graphene-grey-200: #A3A9B3;
    --graphene-grey-500: #5E6575;
    --graphene-grey-800: #2F3440;
    --core-cyan-400: #E0FFFE;
    --core-cyan-500: #C3FFFD;
    --core-cyan-600: #7DE6E2;
    --circuit-green-400: #3EE7A0;
    --circuit-green-500: #00C781;
    --circuit-green-600: #007A52;
    --infra-red-400: #FF6B7D;
    --infra-red-500: #FF3B4D;
    --infra-red-600: #C3001A;

    /* Semantic mappings */
    --bg: var(--baseline-black);
    --card: var(--grid-grey-500);
    --border: var(--grid-grey-400);
    --text: var(--grid-grey-50);
    --muted: var(--graphene-grey-200);
    --accent: var(--core-cyan-500);
    --success: var(--circuit-green-500);
    --danger: var(--infra-red-500);
  }

  body {
    font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 20px;
  }
`

/**
 * Header row: title left, actions right.
 */
export const HEADER_CSS = `
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h1 .count {
    color: var(--infra-red-400);
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .description {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .description strong {
    color: var(--infra-red-400);
  }

  .summary {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 16px;
  }

  .summary .count {
    color: var(--accent);
    font-weight: 500;
  }
`

/**
 * Server card layout: card, header row, name, source badge, info line.
 */
export const SERVER_CARD_CSS = `
  #servers {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .server-item {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .server-item:hover {
    border-color: var(--graphene-grey-500);
  }

  .server-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .server-name {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .server-name strong {
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
  }

  .transport-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: rgba(195, 255, 253, 0.1);
    padding: 2px 8px;
    border-radius: 3px;
    letter-spacing: 0.5px;
  }

  .server-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    background: var(--graphene-grey-800);
    padding: 4px 10px;
    border-radius: 4px;
  }

  .client-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
  }

  .client-name {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .server-info {
    font-size: 12px;
    color: var(--muted);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-meta {
    font-size: 11px;
    color: var(--graphene-grey-500);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .meta-label {
    font-weight: 500;
    color: var(--graphene-grey-200);
    opacity: 0.6;
  }

  .meta-value {
    color: var(--graphene-grey-200);
    opacity: 0.8;
  }

  .meta-value.path {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }

  .meta-separator {
    color: var(--grid-grey-400);
  }

  .empty-state {
    text-align: center;
    padding: 48px 20px;
    color: var(--muted);
  }

  .empty-state p {
    margin-top: 12px;
    font-size: 14px;
  }
`

/**
 * Shared button base styles and server-actions layout.
 * Used by both quarantine and registration dialogs.
 */
export const BUTTON_CSS = `
  .server-actions {
    display: flex;
    gap: 8px;
  }

  .button {
    border: 1px solid var(--border);
    background: var(--graphene-grey-800);
    color: var(--text);
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    flex: 1;
  }

  .button:hover {
    filter: brightness(1.15);
    transform: translateY(-1px);
  }

  .button:active {
    transform: translateY(0);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .button-dismiss {
    background: transparent !important;
    color: var(--muted) !important;
    border-color: var(--border) !important;
  }

  .button-bulk {
    font-size: 11px;
    padding: 5px 10px;
    flex: none;
  }

  .button-dismiss-all {
    background: transparent !important;
    color: var(--muted) !important;
    border-color: var(--border) !important;
  }

  .done-message {
    text-align: center;
    padding: 40px;
    color: var(--muted);
  }

  .done-message .checkmark {
    font-size: 32px;
    margin-bottom: 12px;
  }
`

/**
 * Quarantine-specific: badge and action button colors using brand cyan.
 * Layered on top of BUTTON_CSS.
 */
export const QUARANTINE_CSS = `
  .quarantine-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--core-cyan-500);
    background: rgba(195, 255, 253, 0.1);
    padding: 4px 10px;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .quarantine-badge svg {
    color: var(--core-cyan-500);
  }

  h1 .count {
    color: var(--core-cyan-500);
  }

  .description strong {
    color: var(--core-cyan-500);
  }

  .button-request {
    background: var(--core-cyan-600) !important;
    color: var(--baseline-black) !important;
    border-color: var(--core-cyan-600) !important;
    font-weight: 600 !important;
  }

  .button-request-all {
    background: var(--core-cyan-600) !important;
    color: var(--baseline-black) !important;
    border-color: var(--core-cyan-600) !important;
    font-weight: 600 !important;
  }

  .done-message .checkmark {
    color: var(--core-cyan-500);
  }
`

/**
 * Alias: registration dialog uses the same brand colors as quarantine.
 */
export const REGISTRATION_CSS = QUARANTINE_CSS

/**
 * Debug-window-specific: refresh button, debug actions section.
 */
export const DEBUG_CSS = `
  .refresh-btn {
    border: 1px solid var(--border);
    background: var(--graphene-grey-800);
    color: var(--text);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .refresh-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .refresh-btn:active {
    transform: translateY(1px);
  }

  .refresh-btn.loading {
    opacity: 0.6;
    pointer-events: none;
  }

  .refresh-btn svg {
    transition: transform 0.3s ease;
  }

  .refresh-btn.loading svg {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .debug-actions {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 16px;
    background: var(--card);
  }

  .debug-actions h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }

  .debug-actions .actions-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-btn {
    border: 1px solid var(--border);
    background: var(--graphene-grey-800);
    color: var(--text);
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .action-btn:active {
    transform: translateY(1px);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .action-btn .status {
    font-size: 11px;
    opacity: 0.7;
  }
`
