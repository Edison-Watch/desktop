import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import type { QuarantinedServerEvent } from './mcpConfigMonitor'
import { getClientDisplayName, filterOutEdisonWatchServers } from './mcpConfigMonitor'
import type { ServerAction } from './seenServersStore'
import { discoverMcpServers, getServerFingerprint } from './mcpDiscovery'
import {
  BASE_CSS,
  HEADER_CSS,
  SERVER_CARD_CSS,
  BUTTON_CSS,
  QUARANTINE_CSS,
  REGISTRATION_CSS
} from './dialogStyles'
import { escapeHtml, getClientIcon } from './dialogIcons'

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
        const clientIcon = getClientIcon(server.client, event.fingerprint)

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

          window.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); document.getElementById('request-all')?.click() } })

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

          function showStatusBadge(fingerprint, message, isError) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            const actionsEl = item.querySelector('.server-actions')
            if (actionsEl) {
              const color = isError ? 'var(--danger, #e53e3e)' : 'var(--text-muted, #888)'
              const icon = isError
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>'
              actionsEl.innerHTML = '<div class="already-pending-badge" style="color:' + color + '">' + icon + message + '</div>'
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
              const msg = (err && err.message) ? err.message : 'Something went wrong'
              showStatusBadge(fingerprint, msg, true)
              return
            }
            if (result && result.alreadyPending) {
              showAlreadyPendingBadge(fingerprint)
              return
            }
            if (result && result.alreadyExists) {
              showStatusBadge(fingerprint, result.errorMessage || 'Server already exists in your org', false)
              return
            }
            if (result && result.approveError) {
              showStatusBadge(fingerprint, 'Request submitted — auto-approval failed', true)
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
        const clientIcon = getClientIcon(server.client, fingerprint)

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

          window.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); document.getElementById('request-all')?.click() } })

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
