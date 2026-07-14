// Daemon-driven quarantine approval window.
//
// In primary mode the daemon auto-quarantines new servers and emits a
// `quarantine-prompt` event for each. The client's job is the human decision:
// send to Edison Watch (register/request) or keep quarantined, plus
// rename-on-conflict. A whole batch of newly-quarantined servers is shown in a
// SINGLE window (one row each, with bulk actions), driving the daemon's
// `disposition` op directly (the daemon owns config, submit, secret-templatizing,
// seen-store and removal), rather than the local-discovery path which can't see
// a server the daemon has already removed.

import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

import { getClientDisplayName } from '../runtime/mcpConfigMonitor'
import {
  BASE_CSS,
  HEADER_CSS,
  SERVER_CARD_CSS,
  BUTTON_CSS,
  REGISTRATION_CSS
} from '../dialogs/dialogStyles'
import { escapeHtml, getClientIcon } from '../dialogs/dialogIcons'

import type { ServerView } from './protocol'
import type { DetectordClient } from './socket'

let approvalWindow: BrowserWindow | null = null
let channelSeq = 0

// Daemon agent names use underscores (`claude_code`); the client's display /
// icon helpers key off the dashed client ids (`claude-code`).
const toClientId = (agent: string): string => agent.replace(/_/g, '-')

/**
 * Show one window listing every server in `servers` (a batch of newly
 * quarantined ones), each with Send-to-EW / Keep-quarantined + inline
 * rename-on-conflict. Resolves when the window closes. Only one window at a
 * time. The caller batches; a second call while one is open is ignored.
 */
export function showDaemonApprovalDialog(
  client: DetectordClient,
  servers: ServerView[],
  isAdminOrOwner: boolean,
  parentWindow?: BrowserWindow
): Promise<void> {
  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.focus()
    return Promise.resolve()
  }
  if (servers.length === 0) return Promise.resolve()

  const channel = `detectord:disposition:${(channelSeq += 1)}`

  return new Promise<void>((resolve) => {
    // Disposition one server (by its index in `servers`). Success => acted;
    // a backend 409 => conflict so the row can offer a rename.
    const handler = async (
      _e: Electron.IpcMainInvokeEvent,
      req: { index: number; skip?: boolean; rename?: string }
    ): Promise<{ ok: boolean; conflict?: boolean; message?: string }> => {
      const s = servers[req.index]
      if (!s) return { ok: false, message: 'unknown server' }
      if (req.skip) {
        try {
          await client.disposition(s.name, 'skip', s.agent)
          console.log(`[Quarantine] disposition ${s.name} (${s.agent}) -> skip`)
          return { ok: true }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[detectord] disposition skip ${s.name} failed: ${message}`)
          return { ok: false, message }
        }
      }
      try {
        await client.disposition(s.name, 'send_to_ew', s.agent, req.rename)
        console.log(`[Quarantine] disposition ${s.name} (${s.agent}) -> send_to_ew`)
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/conflict/i.test(message)) return { ok: false, conflict: true, message }
        return { ok: false, message }
      }
    }

    try {
      ipcMain.handle(channel, handler)
    } catch {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }

    approvalWindow = new BrowserWindow({
      width: 520,
      height: Math.min(720, 150 + servers.length * 132),
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

    approvalWindow.on('closed', () => {
      ipcMain.removeHandler(channel)
      approvalWindow = null
      resolve()
    })

    approvalWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(servers, isAdminOrOwner, channel))}`
    )
    approvalWindow.once('ready-to-show', () => approvalWindow?.show())
    // Linux-only fallback: `ready-to-show` is unreliable there (may never fire),
    // which would leave this `show: false` window hidden forever - the event and
    // handler still run (the quarantine is logged) but no window appears. win/mac
    // rely on ready-to-show for anti-flash timing, so only show here on Linux.
    // The dialog loads a data: URL once and never navigates, so `once` is safe.
    if (process.platform === 'linux') {
      approvalWindow.webContents.once('did-finish-load', () => approvalWindow?.show())
    }
  })
}

function serverInfoLine(server: ServerView): string {
  return escapeHtml([server.kind, server.path].filter(Boolean).join(' · '))
}

function rowHtml(server: ServerView, index: number, primaryLabel: string): string {
  const clientId = toClientId(server.agent)
  const clientName = getClientDisplayName(clientId as never)
  const clientIcon = getClientIcon(clientId as never, server.fingerprint ?? '')
  return `
    <div class="server-item" data-index="${index}">
      <div class="server-header">
        <div class="server-name"><strong>${escapeHtml(server.name)}</strong></div>
        <div class="server-source">
          <span class="client-icon">${clientIcon}</span>
          <span class="client-name">${escapeHtml(clientName)}</span>
        </div>
      </div>
      <div class="server-info">${serverInfoLine(server)}</div>
      <div class="msg" style="display:none"></div>
      <div class="rename-row" style="display:none">
        <input type="text" class="rename-input" maxlength="32" placeholder="New name (a-z, 0-9, _)" />
        <button class="button button-request resubmit">Resubmit</button>
      </div>
      <div class="server-actions">
        <button class="button button-request send">${escapeHtml(primaryLabel)}</button>
        <button class="button button-dismiss skip">Keep Quarantined</button>
      </div>
    </div>`
}

function buildHtml(servers: ServerView[], isAdminOrOwner: boolean, channel: string): string {
  const primaryLabel = isAdminOrOwner ? 'Add to Edison' : 'Request Approval'
  const bulkLabel = isAdminOrOwner ? 'Add all to Edison' : 'Request all'
  const rows = servers.map((s, i) => rowHtml(s, i, primaryLabel)).join('')
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>MCP Servers Quarantined</title>
<style>
  ${BASE_CSS}
  ${HEADER_CSS}
  ${SERVER_CARD_CSS}
  ${BUTTON_CSS}
  ${REGISTRATION_CSS}
  .rename-row { display:flex; gap:6px; margin-top:8px; }
  .rename-input { flex:1; min-width:0; padding:4px 8px; border-radius:4px; border:1px solid var(--border,#333); background:var(--bg-input,#1a1a1a); color:var(--text-primary,#eee); font-size:12px; outline:none; }
  .msg { font-size:11px; margin-top:8px; }
  .msg.error { color: var(--danger,#e53e3e); }
  .msg.done { color: var(--success,#38a169); }
  .server-item.resolved { opacity:0.55; }
  .header-actions { display:flex; gap:8px; margin-top:8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>MCP Servers Quarantined <span class="count">(${servers.length})</span></h1>
    <div class="header-actions">
      <button class="button button-bulk" id="send-all">${escapeHtml(bulkLabel)}</button>
      <button class="button button-bulk" id="skip-all">Keep all quarantined</button>
    </div>
  </div>
  ${rows}
  <script>
    const { ipcRenderer } = require('electron')
    const CHANNEL = ${JSON.stringify(channel)}
    let remaining = ${servers.length}

    function rowOf(el) { return el.closest('.server-item') }
    function setMsg(item, text, cls) {
      const m = item.querySelector('.msg')
      m.textContent = text
      m.className = 'msg ' + (cls || '')
      m.style.display = text ? 'block' : 'none'
    }
    function markResolved(item, text) {
      item.classList.add('resolved')
      item.querySelector('.server-actions').style.display = 'none'
      item.querySelector('.rename-row').style.display = 'none'
      setMsg(item, text, 'done')
      remaining -= 1
      if (remaining <= 0) setTimeout(() => window.close(), 600)
    }

    async function send(item, rename) {
      const idx = Number(item.dataset.index)
      item.querySelectorAll('button').forEach(b => b.disabled = true)
      let res
      try { res = await ipcRenderer.invoke(CHANNEL, rename ? { index: idx, rename } : { index: idx }) }
      catch (e) { setMsg(item, String(e), 'error'); item.querySelectorAll('button').forEach(b => b.disabled = false); return }
      if (res.ok) { markResolved(item, 'Sent to Edison Watch'); return }
      if (res.conflict) {
        item.querySelector('.rename-row').style.display = 'flex'
        setMsg(item, (res.message || 'Name already taken') + '. Choose a different name.', 'error')
        item.querySelectorAll('button').forEach(b => b.disabled = false)
        item.querySelector('.rename-input').focus()
        return
      }
      setMsg(item, res.message || 'Failed to send to Edison Watch.', 'error')
      item.querySelectorAll('button').forEach(b => b.disabled = false)
    }

    async function skip(item) {
      const idx = Number(item.dataset.index)
      item.querySelectorAll('button').forEach(b => b.disabled = true)
      let res
      try { res = await ipcRenderer.invoke(CHANNEL, { index: idx, skip: true }) }
      catch (e) { setMsg(item, String(e), 'error'); item.querySelectorAll('button').forEach(b => b.disabled = false); return }
      if (res.ok) { markResolved(item, 'Kept quarantined'); return }
      setMsg(item, res.message || 'Failed to keep quarantined.', 'error')
      item.querySelectorAll('button').forEach(b => b.disabled = false)
    }

    document.querySelectorAll('.server-item').forEach(item => {
      item.querySelector('.send').addEventListener('click', () => send(item))
      item.querySelector('.skip').addEventListener('click', () => skip(item))
      item.querySelector('.resubmit').addEventListener('click', () => {
        const v = (item.querySelector('.rename-input').value || '').trim()
        if (!/^[a-z0-9_]{1,32}$/.test(v)) { setMsg(item, 'Use 1-32 chars: a-z, 0-9, underscore.', 'error'); return }
        send(item, v)
      })
    })

    document.getElementById('send-all').addEventListener('click', function () {
      this.disabled = true
      document.querySelectorAll('.server-item:not(.resolved) .send').forEach(b => b.click())
    })
    document.getElementById('skip-all').addEventListener('click', function () {
      this.disabled = true
      document.querySelectorAll('.server-item:not(.resolved) .skip').forEach(b => b.click())
    })
  </script>
</body>
</html>`
}
