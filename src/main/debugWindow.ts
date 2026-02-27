import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { discoverMcpServers } from './mcpDiscovery'
import type { DiscoveredMcpServer } from './mcpDiscovery'
import { getClientDisplayName } from './mcpConfigMonitor'
import { escapeHtml, getClientIcon } from './mcpServerActionDialog'
import { BASE_CSS, HEADER_CSS, SERVER_CARD_CSS, DEBUG_CSS } from './dialogStyles'

let debugWindow: BrowserWindow | null = null

/**
 * Build the server info string (command+args or url) from a discovered server config.
 */
function getServerInfoHtml(server: DiscoveredMcpServer): string {
  const config = server.config
  if ('command' in config && config.command) {
    const parts = [config.command, ...(config.args ?? [])].join(' ')
    return escapeHtml(parts)
  }
  if ('url' in config && config.url) {
    return escapeHtml(config.url)
  }
  return '<span style="opacity:0.5">No config details</span>'
}

/**
 * Get a human-readable transport label for a server config.
 */
function getTransportLabel(server: DiscoveredMcpServer): string {
  const config = server.config
  if ('type' in config && config.type) {
    return config.type.toUpperCase()
  }
  if ('command' in config && config.command) {
    return 'STDIO'
  }
  return 'UNKNOWN'
}

/**
 * Build the full HTML for the debug window content.
 */
function buildDebugHtml(servers: DiscoveredMcpServer[]): string {
  // Count unique clients
  const uniqueClients = new Set(servers.map((s) => s.client))

  const serversHtml = servers
    .map((server) => {
      const safeName = escapeHtml(server.name)
      const clientName = getClientDisplayName(server.client)
      const clientIcon = getClientIcon(server.client)
      const serverInfo = getServerInfoHtml(server)
      const transport = getTransportLabel(server)
      const safePath = escapeHtml(server.path)
      const safeSource = escapeHtml(server.source)

      return `
        <div class="server-item">
          <div class="server-header">
            <div class="server-name">
              <strong>${safeName}</strong>
              <span class="transport-badge">${transport}</span>
            </div>
            <div class="server-source">
              <span class="client-icon">${clientIcon}</span>
              <span class="client-name">${clientName}</span>
            </div>
          </div>
          <div class="server-info">${serverInfo}</div>
          <div class="server-meta">
            <span class="meta-label">Source:</span> <span class="meta-value">${safeSource}</span>
            <span class="meta-separator">|</span>
            <span class="meta-label">Config:</span> <span class="meta-value path">${safePath}</span>
          </div>
        </div>
      `
    })
    .join('')

  const emptyState =
    servers.length === 0
      ? `<div class="empty-state">
           <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>
           <p>No MCP servers found on this machine.</p>
         </div>`
      : ''

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Debug: Discovered MCP Servers</title>
      <style>
        ${BASE_CSS}
        ${HEADER_CSS}
        ${SERVER_CARD_CSS}
        ${DEBUG_CSS}
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Discovered MCP Servers</h1>
        <button class="refresh-btn" id="refresh-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>
      <div class="summary">
        Found <span class="count">${servers.length}</span> server${servers.length !== 1 ? 's' : ''}
        across <span class="count">${uniqueClients.size}</span> client${uniqueClients.size !== 1 ? 's' : ''}
      </div>
      <div class="debug-actions">
        <h2>Debug Actions</h2>
        <div class="actions-row">
          <button class="action-btn" id="run-quarantine">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg>
            Run Quarantine Workflow
          </button>
          <button class="action-btn" id="reset-quarantine">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Reset Quarantine
          </button>
        </div>
      </div>
      <div id="servers">${serversHtml}${emptyState}</div>
      <script>
        const { ipcRenderer } = require('electron')

        document.getElementById('run-quarantine').addEventListener('click', async function () {
          if (this.disabled) return
          this.disabled = true
          const originalHtml = this.innerHTML
          this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Running... <span class="status">(quarantine dialog will appear)</span>'
          try {
            const result = await ipcRenderer.invoke('debug:runQuarantine')
            if (!result.success) {
              this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Failed: ' + (result.error || 'unknown error')
              setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
              return
            }
            this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Done'
            setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 2000)
          } catch (err) {
            console.error('Quarantine failed:', err)
            this.innerHTML = originalHtml
            this.disabled = false
          }
        })

        document.getElementById('reset-quarantine').addEventListener('click', async function () {
          if (this.disabled) return
          this.disabled = true
          const resetIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
          const originalHtml = this.innerHTML
          this.innerHTML = resetIcon + ' Restoring...'
          try {
            const result = await ipcRenderer.invoke('debug:resetQuarantine')
            if (!result.success) {
              this.innerHTML = resetIcon + ' Failed: ' + (result.error || 'unknown error')
              setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
              return
            }
            const msg = result.restored > 0
              ? ' Restored ' + result.restored + ' server' + (result.restored !== 1 ? 's' : '')
              : ' No quarantined servers found'
            this.innerHTML = resetIcon + msg
            // Also refresh the server list since configs changed
            try {
              const html = await ipcRenderer.invoke('debug:refreshServers')
              document.getElementById('servers').innerHTML = html.serversHtml
              document.querySelector('.summary').innerHTML = html.summaryHtml
            } catch (e) { console.error('Refresh after reset failed:', e) }
            setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
          } catch (err) {
            console.error('Reset failed:', err)
            this.innerHTML = originalHtml
            this.disabled = false
          }
        })

        document.getElementById('refresh-btn').addEventListener('click', async function () {
          this.classList.add('loading')
          this.textContent = ''
          this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refreshing...'
          try {
            const html = await ipcRenderer.invoke('debug:refreshServers')
            document.getElementById('servers').innerHTML = html.serversHtml
            document.querySelector('.summary').innerHTML = html.summaryHtml
          } catch (err) {
            console.error('Refresh failed:', err)
          } finally {
            this.classList.remove('loading')
            this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refresh'
          }
        })
      </script>
    </body>
    </html>
  `
}

/**
 * Build partial HTML fragments for the refresh IPC handler.
 */
function buildRefreshData(servers: DiscoveredMcpServer[]): {
  serversHtml: string
  summaryHtml: string
} {
  const uniqueClients = new Set(servers.map((s) => s.client))

  const serversHtml =
    servers.length === 0
      ? `<div class="empty-state">
           <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>
           <p>No MCP servers found on this machine.</p>
         </div>`
      : servers
          .map((server) => {
            const safeName = escapeHtml(server.name)
            const clientName = getClientDisplayName(server.client)
            const clientIcon = getClientIcon(server.client)
            const serverInfo = getServerInfoHtml(server)
            const transport = getTransportLabel(server)
            const safePath = escapeHtml(server.path)
            const safeSource = escapeHtml(server.source)

            return `
              <div class="server-item">
                <div class="server-header">
                  <div class="server-name">
                    <strong>${safeName}</strong>
                    <span class="transport-badge">${transport}</span>
                  </div>
                  <div class="server-source">
                    <span class="client-icon">${clientIcon}</span>
                    <span class="client-name">${clientName}</span>
                  </div>
                </div>
                <div class="server-info">${serverInfo}</div>
                <div class="server-meta">
                  <span class="meta-label">Source:</span> <span class="meta-value">${safeSource}</span>
                  <span class="meta-separator">|</span>
                  <span class="meta-label">Config:</span> <span class="meta-value path">${safePath}</span>
                </div>
              </div>
            `
          })
          .join('')

  const summaryHtml = `Found <span class="count">${servers.length}</span> server${servers.length !== 1 ? 's' : ''} across <span class="count">${uniqueClients.size}</span> client${uniqueClients.size !== 1 ? 's' : ''}`

  return { serversHtml, summaryHtml }
}

/**
 * Show the debug window with discovered MCP servers.
 * Opens a read-only informational dialog -- no quarantine or removal actions.
 */
export async function showDebugWindow(parentWindow?: BrowserWindow): Promise<void> {
  // Focus existing window if already open
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus()
    return
  }

  const servers = await discoverMcpServers()

  debugWindow = new BrowserWindow({
    width: 560,
    height: Math.min(700, 180 + servers.length * 100),
    minWidth: 400,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: 'Debug: Discovered MCP Servers',
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  // IPC handler for refresh -- re-discovers servers and returns updated HTML fragments
  const refreshHandler = async (): Promise<{
    serversHtml: string
    summaryHtml: string
  }> => {
    const freshServers = await discoverMcpServers()
    return buildRefreshData(freshServers)
  }

  // Register the handler only if not already registered (guards against double-open race)
  try {
    ipcMain.handle('debug:refreshServers', refreshHandler)
  } catch {
    // Handler already registered; replace it
    ipcMain.removeHandler('debug:refreshServers')
    ipcMain.handle('debug:refreshServers', refreshHandler)
  }

  debugWindow.on('closed', () => {
    ipcMain.removeHandler('debug:refreshServers')
    debugWindow = null
  })

  const html = buildDebugHtml(servers)
  debugWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  debugWindow.once('ready-to-show', () => {
    debugWindow?.show()
  })
}
