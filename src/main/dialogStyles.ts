/**
 * Shared CSS styles for Electron BrowserWindow dialogs (quarantine, debug, etc.).
 * Both dialogs use inline HTML, so we export CSS as template strings.
 */

/**
 * Base CSS: reset, Edison design tokens (matches packages/shared/src/theme/tokens.css),
 * body, and shared typography.
 */
export const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg-base: #0B0E14;
    --bg-raised: #141820;
    --bg-overlay: #1A1F2B;
    --bg-input: #0F1219;
    --accent: #7DFFF6;
    --accent-muted: #5CC8C0;
    --accent-dim: #2A4A48;
    --text-primary: #E8ECF2;
    --text-secondary: #8B95A8;
    --text-muted: #5A6478;
    --border: #1E2432;
    --border-active: #7DFFF6;
    --success: #34D399;
    --warning: #FBBF24;
    --danger: #F87171;
  }

  body {
    font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-base);
    color: var(--text-primary);
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
    color: var(--text-primary);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h1 .count {
    color: var(--danger);
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .description {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .description strong {
    color: var(--danger);
  }

  .summary {
    font-size: 13px;
    color: var(--text-muted);
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
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .server-item:hover {
    border-color: var(--text-muted);
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
    color: var(--text-primary);
  }

  .transport-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 2px 8px;
    border-radius: 3px;
    letter-spacing: 0.5px;
  }

  .server-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-overlay);
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
    color: var(--text-secondary);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-meta {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .meta-label {
    font-weight: 500;
    color: var(--text-muted);
  }

  .meta-value {
    color: var(--text-secondary);
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
    color: var(--border);
  }

  .empty-state {
    text-align: center;
    padding: 48px 20px;
    color: var(--text-muted);
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
    background: var(--bg-overlay);
    color: var(--text-primary);
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
    color: var(--text-muted) !important;
    border-color: var(--border) !important;
  }

  .button-bulk {
    font-size: 11px;
    padding: 5px 10px;
    flex: none;
  }

  .button-dismiss-all {
    background: transparent !important;
    color: var(--text-muted) !important;
    border-color: var(--border) !important;
  }

  .done-message {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
  }

  .done-message .checkmark {
    font-size: 32px;
    margin-bottom: 12px;
  }

  .already-pending-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 8px 16px;
    border-radius: 6px;
    width: 100%;
    font-style: italic;
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
    color: var(--accent);
    background: var(--accent-dim);
    padding: 4px 10px;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .quarantine-badge svg {
    color: var(--accent);
  }

  h1 .count {
    color: var(--accent);
  }

  .description strong {
    color: var(--accent);
  }

  .button-request {
    background: var(--accent-muted) !important;
    color: var(--bg-base) !important;
    border-color: var(--accent-muted) !important;
    font-weight: 600 !important;
  }

  .button-request-all {
    background: var(--accent-muted) !important;
    color: var(--bg-base) !important;
    border-color: var(--accent-muted) !important;
    font-weight: 600 !important;
  }

  .done-message .checkmark {
    color: var(--accent);
  }
`

/**
 * Alias: registration dialog uses the same brand colors as quarantine.
 */
export const REGISTRATION_CSS = QUARANTINE_CSS

/**
 * Credential review panel: inline secret detection/marking within server cards.
 * Used in quarantine and registration dialogs.
 */
export const CREDENTIAL_REVIEW_CSS = `
  .credential-review {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }

  .cr-description {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .cr-hint {
    font-size: 10px;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 8px;
  }

  .cr-entries {
    background: var(--bg-input);
    border-radius: 6px;
    padding: 10px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 12px;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cr-entry {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .cr-label {
    color: var(--text-muted);
    flex-shrink: 0;
    min-width: 70px;
    user-select: none;
  }

  .cr-value {
    flex: 1;
    word-break: break-all;
    color: var(--text-secondary);
    user-select: text;
    -webkit-user-select: text;
  }

  .cr-value[data-context="command"] {
    user-select: none;
    -webkit-user-select: none;
  }

  .cr-secret-btn {
    display: inline;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid rgba(249, 115, 22, 0.3);
    background: rgba(249, 115, 22, 0.2);
    color: #fdba74;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    transition: background 0.15s ease;
  }

  .cr-secret-btn:hover {
    background: rgba(249, 115, 22, 0.3);
  }

  .cr-secret-btn.disabled {
    background: var(--bg-base);
    color: var(--text-muted);
    border-color: var(--border);
  }

  .cr-var-label {
    font-size: 10px;
    color: rgba(251, 146, 60, 0.7);
    margin-left: 4px;
  }

  .cr-popup {
    position: fixed;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    transform: translateX(-50%);
  }

  .cr-popup-mark {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(249, 115, 22, 0.2);
    color: #fdba74;
    border: 1px solid rgba(249, 115, 22, 0.3);
    cursor: pointer;
    font-family: 'Archivo', sans-serif;
    white-space: nowrap;
    transition: background 0.15s ease;
  }

  .cr-popup-mark:hover {
    background: rgba(249, 115, 22, 0.3);
  }

  .cr-popup-close {
    font-size: 11px;
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    line-height: 1;
  }

  .cr-popup-close:hover {
    color: var(--text-primary);
  }

  .cr-actions {
    display: flex;
    gap: 8px;
  }

  .cr-empty {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 4px 0;
  }

  .cr-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 8px 0;
  }

  .cr-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`

/**
 * Debug-window-specific: refresh button, debug actions section.
 */
export const DEBUG_CSS = `
  .refresh-btn {
    border: 1px solid var(--border);
    background: var(--bg-overlay);
    color: var(--text-primary);
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
    background: var(--bg-raised);
  }

  .debug-actions h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
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
    background: var(--bg-overlay);
    color: var(--text-primary);
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

  .path-group {
    margin-bottom: 10px;
  }

  .path-group:last-child {
    margin-bottom: 0;
  }

  .path-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .path-group-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .path-group-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 1px 6px;
    border-radius: 3px;
  }

  .path-item {
    font-size: 11px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    color: var(--text-secondary);
    padding: 3px 8px;
    margin-left: 4px;
    border-left: 2px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-empty {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 3px 8px;
    margin-left: 4px;
  }
`
