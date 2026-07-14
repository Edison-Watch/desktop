/**
 * Server registration dialog (non-quarantine).
 *
 * Extracted from mcpServerActionDialog.ts to keep both files under the
 * 800-line CI limit. Unlike the quarantine dialog, this does NOT quarantine
 * or disable any servers - it simply lets users submit approval requests for
 * their installed servers.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { getClientDisplayName, filterOutEdisonWatchServers } from '../runtime/mcpConfigMonitor'
import type { ServerActionResult } from './mcpServerActionDialog'
import { discoverMcpServers, getServerFingerprint } from '../discovery/mcpDiscovery'
import {
  BASE_CSS,
  HEADER_CSS,
  SERVER_CARD_CSS,
  BUTTON_CSS,
  REGISTRATION_CSS,
  CREDENTIAL_REVIEW_CSS
} from './dialogStyles'
import { CREDENTIAL_REVIEW_JS } from './dialogCredentialReviewJs'
import { escapeHtml, getClientIcon } from './dialogIcons'

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
          ${CREDENTIAL_REVIEW_CSS}
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
          let activePopup = null

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
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            const actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (actionsEl) {
              actionsEl.style.display = ''
              actionsEl.innerHTML = '<div class="already-pending-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>Request already pending with IT admin</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/

          function showConflictRename(fingerprint, serverName, sourceApp, action, errorMessage) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) { if (!bulkOperationInProgress) reenableButtons(); return }
            // Remove credential review panel if present
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            let actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (!actionsEl) { actionsEl = document.createElement('div'); actionsEl.className = 'server-actions'; item.appendChild(actionsEl) }
            actionsEl.style.display = ''
            actionsEl.innerHTML = \`
              <div style="display:flex;flex-direction:column;gap:6px;width:100%">
                <div style="color:var(--danger, #e53e3e);font-size:11px;display:flex;align-items:center;gap:4px">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                  Conflict: \${errorMessage || 'A server with this name already exists'}
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <input type="text" class="rename-input" maxlength="32" placeholder="New name (a-z, 0-9, _)" style="flex:1;min-width:0;padding:4px 8px;border-radius:4px;border:1px solid var(--border, #333);background:var(--bg-input, #1a1a1a);color:var(--text-primary, #eee);font-size:11px;outline:none" />
                  <button class="button button-request rename-btn" disabled style="white-space:nowrap;padding:4px 10px;font-size:11px;opacity:0.4">Resubmit</button>
                </div>
                <div class="rename-error" style="font-size:10px;color:var(--danger, #e53e3e);display:none">Max 32 characters, letters, numbers and underscore only</div>
              </div>
            \`
            const input = actionsEl.querySelector('.rename-input')
            const btn = actionsEl.querySelector('.rename-btn')
            const errEl = actionsEl.querySelector('.rename-error')
            input.addEventListener('input', () => {
              input.value = input.value.replace(/[^a-zA-Z0-9_]/g, '')
              const valid = NAME_RE.test(input.value.trim())
              btn.disabled = !valid
              btn.style.opacity = valid ? '1' : '0.4'
              errEl.style.display = (input.value.length > 0 && !valid) ? 'block' : 'none'
            })
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && !btn.disabled) btn.click()
            })
            btn.addEventListener('click', async (e) => {
              e.stopPropagation()
              const newName = input.value.trim()
              if (!NAME_RE.test(newName)) return
              btn.disabled = true
              btn.textContent = 'Submitting...'
              try {
                const serverData = serverConfigs[fingerprint] || {}
                const result = await ipcRenderer.invoke('mcp:resubmitServer', {
                  originalName: serverName,
                  newName: newName,
                  config: serverData.config,
                  client: sourceApp,
                  configPath: serverData.path
                })
                if (result && result.success) {
                  results.push({ fingerprint, serverName: newName, sourceApp, action })
                  removeServerItem(fingerprint)
                } else {
                  showConflictRename(fingerprint, serverName, sourceApp, action, (result && result.error) || 'Failed')
                }
              } catch (err) {
                const msg = (err && err.message) ? err.message : 'Resubmit failed'
                showConflictRename(fingerprint, serverName, sourceApp, action, msg)
              }
            })
            if (!bulkOperationInProgress) reenableButtons()
          }

          ${CREDENTIAL_REVIEW_JS}

          function showCredentialReview(fingerprint, serverName, sourceApp, action, analysis) {
            buildCredentialReviewPanel(fingerprint, serverName, sourceApp, action, analysis, {
              onConfirm: async (fp, sn, sa, act, overrides) => {
                const serverData = serverConfigs[fp] || {}
                let result
                try {
                  result = await ipcRenderer.invoke('mcp:handleServerAction', {
                    fingerprint: fp, serverName: sn, sourceApp: sa, action: act,
                    config: serverData.config, configPath: serverData.path,
                    templateOverrides: overrides
                  })
                } catch (err) {
                  if (!bulkOperationInProgress) reenableButtons()
                  return
                }
                if (result && result.alreadyPending) { showConflictRename(fp, sn, sa, act, 'A server with this name already has a pending approval request'); return }
                if (result && result.alreadyExists) { showConflictRename(fp, sn, sa, act, result.errorMessage); return }
                results.push({ fingerprint: fp, serverName: sn, sourceApp: sa, action: act })
                removeServerItem(fp)
              }
            })
          }

          // ── Main action handler ────────────────────────────────────

          async function handleAction(fingerprint, serverName, sourceApp, action, skipReview) {
            const serverData = serverConfigs[fingerprint] || {}

            if ((action === 'registered' || action === 'requested') && !skipReview) {
              try {
                const analysis = await ipcRenderer.invoke('mcp:analyzeServerSecrets', {
                  serverName, sourceApp,
                  config: serverData.config,
                  configPath: serverData.path
                })
                showCredentialReview(fingerprint, serverName, sourceApp, action, analysis)
                return
              } catch (err) {
                console.error('Secret analysis failed, submitting directly:', err)
              }
            }

            if (action === 'requested' || action === 'registered') {
              let result
              try {
                result = await ipcRenderer.invoke('mcp:handleServerAction', {
                  fingerprint, serverName, sourceApp, action,
                  config: serverData.config, configPath: serverData.path
                })
              } catch (err) {
                if (!bulkOperationInProgress) reenableButtons()
                return
              }
              if (result && result.alreadyPending) {
                showConflictRename(fingerprint, serverName, sourceApp, action, 'A server with this name already has a pending approval request')
                return
              }
              if (result && result.alreadyExists) {
                showConflictRename(fingerprint, serverName, sourceApp, action, result.errorMessage)
                return
              }
            }
            results.push({ fingerprint, serverName, sourceApp, action })
            removeServerItem(fingerprint)
          }

          document.addEventListener('click', (e) => {
            const button = e.target.closest('button')
            if (!button || button.disabled) return
            if (button.closest('.credential-review') || button.closest('.cr-popup')) return

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
            handleAction(fingerprint, serverName, sourceApp, action, false)
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
                  return handleAction(fingerprint, serverName, sourceApp, '${isAdminOrOwner ? 'registered' : 'requested'}', true)
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
                  return handleAction(fingerprint, serverName, sourceApp, 'skipped', true)
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
    // Linux-only fallback: `ready-to-show` may never fire there, leaving this
    // `show: false` window hidden forever. See detectord/approvalDialog.ts.
    if (process.platform === 'linux') {
      serverRegistrationWindow.webContents.once('did-finish-load', () =>
        serverRegistrationWindow?.show()
      )
    }
  })
}
