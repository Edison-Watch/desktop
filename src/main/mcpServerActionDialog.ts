import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import type { QuarantinedServerEvent } from './mcpConfigMonitor'
import { getClientDisplayName, filterOutEdisonWatchServers } from './mcpConfigMonitor'
import type { ServerAction } from './seenServersStore'
import type { McpClientId } from './mcpDiscovery'
import { discoverMcpServers, getServerFingerprint } from './mcpDiscovery'
import {
  BASE_CSS,
  HEADER_CSS,
  SERVER_CARD_CSS,
  BUTTON_CSS,
  QUARANTINE_CSS,
  REGISTRATION_CSS
} from './dialogStyles'

/**
 * Escape HTML special characters to prevent XSS injection.
 * Used to sanitize content from MCP config files before inserting into HTML template.
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Get an SVG icon for a client.
 * Icons from Simple Icons (https://simpleicons.org) - official brand SVGs.
 */
export function getClientIcon(client: McpClientId): string {
  switch (client) {
    case 'vscode':
    case 'vscode-insiders':
      // Visual Studio Code icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>`
    case 'cursor':
      // Cursor icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>`
    case 'claude-desktop':
    case 'claude-code':
      // Anthropic icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`
    case 'windsurf':
      // Windsurf icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z"/></svg>`
    case 'zed':
      // Zed Industries icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z"/></svg>`
    case 'antigravity':
      // Google icon (Simple Icons) - Antigravity is Google's IDE
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>`
    case 'intellij':
    case 'pycharm':
    case 'webstorm':
      // JetBrains icon (Simple Icons)
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0v24h24V0zm10.5 4.5h3v15h-3zM16.5 4.5h3v15h-3zM5.25 7.5v9h13.5v-9z"/></svg>`
    default:
      // Generic server icon
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>`
  }
}

export interface ServerActionResult {
  fingerprint: string
  serverName: string
  sourceApp: string
  action: ServerAction
}

let serverActionWindow: BrowserWindow | null = null

/**
 * Show a dialog for quarantined MCP servers.
 * User can either request access or dismiss (leave quarantined).
 * When isAdminOrOwner is true, buttons say "Add to Edison" and the server
 * will be both requested and auto-approved by the IPC handler.
 */
export function showQuarantinedServersDialog(
  events: QuarantinedServerEvent[],
  parentWindow?: BrowserWindow,
  isAdminOrOwner = false
): Promise<ServerActionResult[]> {
  return new Promise((resolve) => {
    const results: ServerActionResult[] = []

    if (events.length === 0) {
      resolve([])
      return
    }

    // Close existing window if open
    if (serverActionWindow && !serverActionWindow.isDestroyed()) {
      serverActionWindow.focus()
      resolve([])
      return
    }

    // Create the dialog window. nodeIntegration/contextIsolation are used for IPC from our own
    // inline HTML only; all user-controlled content is escaped (escapeHtml) or sanitized (script
    // JSON and selector values) before injection, so no untrusted content reaches the template.
    serverActionWindow = new BrowserWindow({
      width: 500,
      height: Math.min(600, 220 + events.length * 110),
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      modal: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    // Build config map for passing to IPC (so we can include full config in requests)
    const configMap: Record<string, { config: unknown; path: string }> = {}
    events.forEach((event) => {
      configMap[event.fingerprint] = {
        config: event.server.config,
        path: event.server.path
      }
    })

    // Build HTML for each server
    const serversHtml = events
      .map((event) => {
        const server = event.server
        const config = server.config
        const clientName = getClientDisplayName(server.client)
        const clientIcon = getClientIcon(server.client)

        // Get command/url info - escape all user-controlled content to prevent XSS
        let serverInfo = ''
        if ('command' in config && config.command) {
          const args = config.args?.slice(0, 3).join(' ') ?? ''
          serverInfo = escapeHtml(
            `${config.command} ${args}${config.args && config.args.length > 3 ? '...' : ''}`
          )
        } else if ('url' in config && config.url) {
          serverInfo = escapeHtml(config.url)
        }

        // Escape all dynamic content from MCP config files
        const safeName = escapeHtml(server.name)
        const safeFingerprint = escapeHtml(event.fingerprint)
        const safeClient = escapeHtml(server.client)

        return `
          <div class="server-item" data-fingerprint="${safeFingerprint}" data-name="${safeName}" data-source="${safeClient}">
            <div class="server-header">
              <div class="server-name">
                <strong>${safeName}</strong>
              </div>
              <div class="server-source">
                <span class="client-icon">${clientIcon}</span>
                <span class="client-name">${clientName}</span>
              </div>
            </div>
            <div class="server-info">${serverInfo}</div>
            <div class="quarantine-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg>
              Needs Approval
            </div>
            <div class="server-actions">
              <button class="button button-request" data-action="${isAdminOrOwner ? 'registered' : 'requested'}" title="${isAdminOrOwner ? 'Add this server to Edison directly' : 'Submit request for IT admin approval'}">${isAdminOrOwner ? 'Add to Edison' : 'Request Approval'}</button>
              <button class="button button-dismiss" data-action="dismissed" title="Skip for now without requesting">Skip for Now</button>
            </div>
          </div>
        `
      })
      .join('')

    // Edison Watch branded HTML
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>New AI Extensions Detected</title>
        <style>
          ${BASE_CSS}
          ${HEADER_CSS}
          ${SERVER_CARD_CSS}
          ${BUTTON_CSS}
          ${QUARANTINE_CSS}
        </style>
      </head>
      <body data-configs="${escapeHtml(JSON.stringify(configMap))}">
        <div class="header">
          <h1>New AI Extensions Detected <span class="count">(${events.length})</span></h1>
          <div class="header-actions">
            <button class="button button-bulk button-request-all" id="request-all">${isAdminOrOwner ? 'Add All' : 'Request All'}</button>
            <button class="button button-bulk button-dismiss-all" id="dismiss-all">Skip All</button>
          </div>
        </div>
        <div class="description">
          ${isAdminOrOwner
            ? 'We noticed you\'ve added new extensions to your AI tools. As an admin, you can add them to Edison directly.'
            : 'We noticed you\'ve added new extensions to your AI tools. Your IT team needs to approve them before they can be used through Edison Watch. Would you like to request approval?'}
        </div>
        <div id="servers">${serversHtml}</div>
        <script>
          const { ipcRenderer } = require('electron')
          const results = []
          const serverConfigs = JSON.parse(document.body.dataset.configs || '{}')
          let bulkOperationInProgress = false

          function findItemByFingerprint(fingerprint) {
            const items = document.querySelectorAll('.server-item')
            for (const item of items) {
              if (item.dataset.fingerprint === fingerprint) return item
            }
            return null
          }

          function reenableButtons() {
            document.querySelectorAll('.server-item button').forEach(btn => {
              btn.disabled = false
              btn.style.opacity = '1'
            })
            const requestAll = document.getElementById('request-all')
            const dismissAll = document.getElementById('dismiss-all')
            if (requestAll) { requestAll.disabled = false; requestAll.style.opacity = '1' }
            if (dismissAll) { dismissAll.disabled = false; dismissAll.style.opacity = '1' }
          }

          function updateHeaderCount() {
            const remaining = document.querySelectorAll('.server-item').length
            const countSpan = document.querySelector('h1 .count')
            if (countSpan) {
              countSpan.textContent = '(' + remaining + ')'
            }
          }

          function removeServerItem(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              // Safety: re-enable buttons if element wasn't found
              if (!bulkOperationInProgress) reenableButtons()
              return
            }

            item.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
            item.style.transform = 'translateX(-100%)'
            item.style.opacity = '0'
            item.style.maxHeight = item.offsetHeight + 'px'

            setTimeout(() => {
              item.style.maxHeight = '0'
              item.style.marginBottom = '0'
              item.style.paddingTop = '0'
              item.style.paddingBottom = '0'
              item.style.borderWidth = '0'
            }, 100)

            setTimeout(() => {
              try {
                item.remove()
                updateHeaderCount()
                const remaining = document.querySelectorAll('.server-item').length
                if (remaining === 0) {
                  // Auto-close when all servers have been handled
                  ipcRenderer.invoke('mcp:serverActionComplete', results)
                  window.close()
                } else if (!bulkOperationInProgress) {
                  reenableButtons()
                }
              } catch (err) {
                // Ensure buttons are always re-enabled even if something fails
                console.error('Error removing server item:', err)
                if (!bulkOperationInProgress) reenableButtons()
              }
            }, 400)
          }

          function showAlreadyPendingBadge(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            const actionsEl = item.querySelector('.server-actions')
            if (actionsEl) {
              actionsEl.innerHTML = '<div class="already-pending-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>Request already pending with IT admin</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          async function handleAction(fingerprint, serverName, sourceApp, action) {
            const serverData = serverConfigs[fingerprint] || {}
            results.push({ fingerprint, serverName, sourceApp, action })
            let result
            try {
              result = await ipcRenderer.invoke('mcp:handleServerAction', {
                fingerprint,
                serverName,
                sourceApp,
                action,
                config: serverData.config,
                configPath: serverData.path
              })
            } catch (err) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            if (result && result.alreadyPending) {
              showAlreadyPendingBadge(fingerprint)
              return
            }
            removeServerItem(fingerprint)
          }

          document.addEventListener('click', (e) => {
            const button = e.target.closest('button')
            if (!button || button.disabled) return

            document.querySelectorAll('button').forEach(btn => {
              btn.disabled = true
              btn.style.opacity = '0.5'
            })

            const action = button.dataset.action
            const item = button.closest('.server-item')
            if (!item || !action) {
              document.querySelectorAll('button').forEach(btn => {
                btn.disabled = false
                btn.style.opacity = '1'
              })
              return
            }
            const fingerprint = item.dataset.fingerprint
            const serverName = item.dataset.name
            const sourceApp = item.dataset.source
            handleAction(fingerprint, serverName, sourceApp, action)
          })

          document.getElementById('request-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('dismiss-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, '${isAdminOrOwner ? 'registered' : 'requested'}')
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              // Re-enable buttons if any items remain (e.g. after a partial failure)
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          document.getElementById('dismiss-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('request-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, 'dismissed')
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              // Re-enable buttons if any items remain (e.g. after a partial failure)
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          // Handle window close
          window.addEventListener('beforeunload', () => {
            ipcRenderer.invoke('mcp:serverActionComplete', results)
          })
        </script>
      </body>
      </html>
    `

    // Set up IPC handler for completion
    const completeHandler = (
      _event: Electron.IpcMainInvokeEvent,
      actionResults: ServerActionResult[]
    ): void => {
      results.push(...actionResults)
    }
    ipcMain.handle('mcp:serverActionComplete', completeHandler)

    serverActionWindow.on('closed', () => {
      ipcMain.removeHandler('mcp:serverActionComplete')
      serverActionWindow = null
      resolve(results)
    })

    serverActionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    serverActionWindow.once('ready-to-show', () => {
      serverActionWindow?.show()
    })
  })
}

/**
 * Close the server action dialog if open.
 */
export function closeServerActionDialog(): void {
  if (serverActionWindow && !serverActionWindow.isDestroyed()) {
    serverActionWindow.close()
    serverActionWindow = null
  }
}

// ---------------------------------------------------------------------------
// Server registration dialog (non-quarantine)
// ---------------------------------------------------------------------------

let serverRegistrationWindow: BrowserWindow | null = null

/**
 * Show a dialog to register/request approval for all locally discovered MCP servers.
 * Unlike the quarantine dialog, this does NOT quarantine or disable any servers --
 * it simply lets users submit approval requests for their installed servers.
 *
 * When isAdminOrOwner is true, buttons say "Add to Edison" and auto-approve.
 */
export async function showServerRegistrationDialog(
  parentWindow?: BrowserWindow,
  isAdminOrOwner = false
): Promise<ServerActionResult[]> {
  // Focus existing window if already open
  if (serverRegistrationWindow && !serverRegistrationWindow.isDestroyed()) {
    serverRegistrationWindow.focus()
    return []
  }

  const allServers = await discoverMcpServers()
  const servers = filterOutEdisonWatchServers(allServers)

  if (servers.length === 0) {
    const msgOpts = {
      type: 'info' as const,
      title: 'Register MCP Servers',
      message:
        'No new MCP servers found. All discovered servers are either already managed by Edison Watch or no MCP servers were detected on this machine.'
    }
    if (parentWindow && !parentWindow.isDestroyed()) {
      await dialog.showMessageBox(parentWindow, msgOpts)
    } else {
      await dialog.showMessageBox(msgOpts)
    }
    return []
  }

  return new Promise((resolve) => {
    const results: ServerActionResult[] = []

    // Build config map keyed by fingerprint
    const configMap: Record<string, { config: unknown; path: string }> = {}
    const serverEntries = servers.map((server) => {
      const fingerprint = getServerFingerprint(server)
      configMap[fingerprint] = { config: server.config, path: server.path }
      return { server, fingerprint }
    })

    const serversHtml = serverEntries
      .map(({ server, fingerprint }) => {
        const config = server.config
        const clientName = getClientDisplayName(server.client)
        const clientIcon = getClientIcon(server.client)

        let serverInfo = ''
        if ('command' in config && config.command) {
          const args = config.args?.slice(0, 3).join(' ') ?? ''
          serverInfo = escapeHtml(
            `${config.command} ${args}${config.args && config.args.length > 3 ? '...' : ''}`
          )
        } else if ('url' in config && config.url) {
          serverInfo = escapeHtml(config.url)
        }

        const safeName = escapeHtml(server.name)
        const safeFingerprint = escapeHtml(fingerprint)
        const safeClient = escapeHtml(server.client)

        return `
          <div class="server-item" data-fingerprint="${safeFingerprint}" data-name="${safeName}" data-source="${safeClient}">
            <div class="server-header">
              <div class="server-name">
                <strong>${safeName}</strong>
              </div>
              <div class="server-source">
                <span class="client-icon">${clientIcon}</span>
                <span class="client-name">${clientName}</span>
              </div>
            </div>
            <div class="server-info">${serverInfo}</div>
            <div class="server-actions">
              <button class="button button-request" data-action="${isAdminOrOwner ? 'registered' : 'requested'}" title="${isAdminOrOwner ? 'Add this server to Edison directly' : 'Submit request for IT admin approval'}">${isAdminOrOwner ? 'Add to Edison' : 'Request Approval'}</button>
              <button class="button button-dismiss" data-action="skipped" title="Skip this server for now">Skip</button>
            </div>
          </div>
        `
      })
      .join('')

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Register MCP Servers</title>
        <style>
          ${BASE_CSS}
          ${HEADER_CSS}
          ${SERVER_CARD_CSS}
          ${BUTTON_CSS}
          ${REGISTRATION_CSS}
        </style>
      </head>
      <body data-configs="${escapeHtml(JSON.stringify(configMap))}">
        <div class="header">
          <h1>${isAdminOrOwner ? 'Register' : 'Request'} MCP Servers <span class="count">(${servers.length})</span></h1>
          <div class="header-actions">
            <button class="button button-bulk button-request-all" id="request-all">${isAdminOrOwner ? 'Add All' : 'Request All'}</button>
            <button class="button button-bulk button-dismiss-all" id="dismiss-all">Skip All</button>
          </div>
        </div>
        <div class="description">
          ${isAdminOrOwner
            ? 'These MCP servers are installed on your machine. Add them to Edison to enable secure proxying.'
            : 'These MCP servers are installed on your machine. Request approval so your IT team can add them to Edison.'}
        </div>
        <div id="servers">${serversHtml}</div>
        <script>
          const { ipcRenderer } = require('electron')
          const results = []
          const serverConfigs = JSON.parse(document.body.dataset.configs || '{}')
          let bulkOperationInProgress = false

          function findItemByFingerprint(fingerprint) {
            const items = document.querySelectorAll('.server-item')
            for (const item of items) {
              if (item.dataset.fingerprint === fingerprint) return item
            }
            return null
          }

          function reenableButtons() {
            document.querySelectorAll('.server-item button').forEach(btn => {
              btn.disabled = false
              btn.style.opacity = '1'
            })
            const requestAll = document.getElementById('request-all')
            const dismissAll = document.getElementById('dismiss-all')
            if (requestAll) { requestAll.disabled = false; requestAll.style.opacity = '1' }
            if (dismissAll) { dismissAll.disabled = false; dismissAll.style.opacity = '1' }
          }

          function updateHeaderCount() {
            const remaining = document.querySelectorAll('.server-item').length
            const countSpan = document.querySelector('h1 .count')
            if (countSpan) {
              countSpan.textContent = '(' + remaining + ')'
            }
          }

          function removeServerItem(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }

            item.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
            item.style.transform = 'translateX(-100%)'
            item.style.opacity = '0'
            item.style.maxHeight = item.offsetHeight + 'px'

            setTimeout(() => {
              item.style.maxHeight = '0'
              item.style.marginBottom = '0'
              item.style.paddingTop = '0'
              item.style.paddingBottom = '0'
              item.style.borderWidth = '0'
            }, 100)

            setTimeout(() => {
              try {
                item.remove()
                updateHeaderCount()
                const remaining = document.querySelectorAll('.server-item').length
                if (remaining === 0) {
                  ipcRenderer.invoke('mcp:registrationComplete', results)
                  window.close()
                } else if (!bulkOperationInProgress) {
                  reenableButtons()
                }
              } catch (err) {
                console.error('Error removing server item:', err)
                if (!bulkOperationInProgress) reenableButtons()
              }
            }, 400)
          }

          function showAlreadyPendingBadge(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            const actionsEl = item.querySelector('.server-actions')
            if (actionsEl) {
              actionsEl.innerHTML = '<div class="already-pending-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>Request already pending with IT admin</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          async function handleAction(fingerprint, serverName, sourceApp, action) {
            const serverData = serverConfigs[fingerprint] || {}
            results.push({ fingerprint, serverName, sourceApp, action })
            if (action === 'requested' || action === 'registered') {
              let result
              try {
                result = await ipcRenderer.invoke('mcp:handleServerAction', {
                  fingerprint,
                  serverName,
                  sourceApp,
                  action,
                  config: serverData.config,
                  configPath: serverData.path
                })
              } catch (err) {
                if (!bulkOperationInProgress) reenableButtons()
                return
              }
              if (result && result.alreadyPending) {
                showAlreadyPendingBadge(fingerprint)
                return
              }
            }
            removeServerItem(fingerprint)
          }

          document.addEventListener('click', (e) => {
            const button = e.target.closest('button')
            if (!button || button.disabled) return

            document.querySelectorAll('button').forEach(btn => {
              btn.disabled = true
              btn.style.opacity = '0.5'
            })

            const action = button.dataset.action
            const item = button.closest('.server-item')
            if (!item || !action) {
              document.querySelectorAll('button').forEach(btn => {
                btn.disabled = false
                btn.style.opacity = '1'
              })
              return
            }
            const fingerprint = item.dataset.fingerprint
            const serverName = item.dataset.name
            const sourceApp = item.dataset.source
            handleAction(fingerprint, serverName, sourceApp, action)
          })

          document.getElementById('request-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('dismiss-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, '${isAdminOrOwner ? 'registered' : 'requested'}')
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          document.getElementById('dismiss-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('request-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, 'skipped')
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          window.addEventListener('beforeunload', () => {
            ipcRenderer.invoke('mcp:registrationComplete', results)
          })
        </script>
      </body>
      </html>
    `

    serverRegistrationWindow = new BrowserWindow({
      width: 500,
      height: Math.min(600, 200 + servers.length * 100),
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      modal: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    const completeHandler = (
      _event: Electron.IpcMainInvokeEvent,
      actionResults: ServerActionResult[]
    ): void => {
      results.push(...actionResults)
    }

    try {
      ipcMain.handle('mcp:registrationComplete', completeHandler)
    } catch {
      ipcMain.removeHandler('mcp:registrationComplete')
      ipcMain.handle('mcp:registrationComplete', completeHandler)
    }

    serverRegistrationWindow.on('closed', () => {
      ipcMain.removeHandler('mcp:registrationComplete')
      serverRegistrationWindow = null
      resolve(results)
    })

    serverRegistrationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    serverRegistrationWindow.once('ready-to-show', () => {
      serverRegistrationWindow?.show()
    })
  })
}
