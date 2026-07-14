import { createHash } from 'crypto'
import { BrowserWindow, ipcMain } from 'electron'
import { BASE_CSS } from './dialogStyles'

let updateKeysWindow: BrowserWindow | null = null

function buildUpdateKeysHtml(currentSecretKey: string, canRoll: boolean): string {
  // Parse existing composite key to determine stored key state
  const hasPersonalKey = currentSecretKey.includes('user:')
  const hasOrgKey = currentSecretKey.includes('.admin:')

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Update Keys</title>
      <style>
        ${BASE_CSS}

        h1 {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 6px;
        }

        .subtitle {
          font-size: 13px;
          color: var(--muted);
          margin-bottom: 20px;
          line-height: 1.5;
        }

        .field {
          margin-bottom: 14px;
        }

        label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .label-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .label-row label { margin-bottom: 0; }

        .generate-link {
          font-size: 11px;
          color: var(--accent);
          cursor: pointer;
          background: none;
          border: none;
          padding: 0;
          font-family: inherit;
          text-decoration: underline;
        }

        .generate-link:hover { opacity: 0.8; }

        input[type="password"], input[type="text"] {
          width: 100%;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
          font-size: 12px;
          padding: 9px 12px;
          outline: none;
          transition: border-color 0.15s ease;
        }

        input:focus { border-color: var(--accent); }

        .hint {
          font-size: 11px;
          color: var(--muted);
          margin-top: 4px;
          opacity: 0.7;
        }

        .actions {
          display: flex;
          gap: 8px;
          margin-top: 20px;
          justify-content: flex-end;
        }

        button {
          border: 1px solid var(--border);
          background: var(--graphene-grey-800);
          color: var(--text);
          padding: 8px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          font-family: 'Archivo', sans-serif;
          transition: all 0.15s ease;
        }

        button:hover { filter: brightness(1.15); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        #save-btn {
          background: var(--core-cyan-600);
          color: var(--baseline-black);
          border-color: var(--core-cyan-600);
          font-weight: 600;
          transition: all 0.15s ease, box-shadow 0.2s ease;
        }

        #save-btn:hover { filter: brightness(1.1); }

        #save-btn.has-changes {
          box-shadow: 0 0 0 3px rgba(0, 220, 200, 0.35);
          animation: pulse-glow 1.8s ease-in-out infinite;
        }

        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 0 3px rgba(0, 220, 200, 0.35); }
          50%       { box-shadow: 0 0 0 6px rgba(0, 220, 200, 0.10); }
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.3px;
          padding: 2px 7px;
          border-radius: 99px;
        }

        .status-badge.stored {
          background: rgba(0, 220, 130, 0.12);
          color: var(--circuit-green-500, #00dc82);
          border: 1px solid rgba(0, 220, 130, 0.25);
        }

        .status-badge.not-stored {
          background: rgba(255, 160, 60, 0.10);
          color: var(--graphene-grey-300, #aaa);
          border: 1px solid rgba(180, 180, 180, 0.18);
        }

        .copy-composite-btn {
          width: 100%;
          background: var(--graphene-grey-800);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 8px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          font-family: 'Archivo', sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
          margin-bottom: 14px;
        }

        .copy-composite-btn:hover { filter: brightness(1.15); }

        .error {
          font-size: 12px;
          color: var(--infra-red-400);
          margin-top: 12px;
          display: none;
        }

        .success {
          text-align: center;
          padding: 32px 20px;
          display: none;
        }

        .success .check {
          font-size: 32px;
          color: var(--circuit-green-500);
          margin-bottom: 12px;
        }

        .success p {
          font-size: 14px;
          color: var(--muted);
        }
      </style>
    </head>
    <body>
      <div id="form-view">
        <h1>Update Encryption Keys</h1>
        <p class="subtitle">Update your personal or organisation key. MCP configs will be refreshed automatically.</p>

        ${currentSecretKey ? `
        <button class="copy-composite-btn" id="copy-current-btn" type="button">
          <span>⎘</span> Copy Composite Key
        </button>
        ` : ''}

        <div class="field">
          <div class="label-row">
            <label for="personal-key">Personal Key</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="status-badge ${hasPersonalKey ? 'stored' : 'not-stored'}">${hasPersonalKey ? '● Stored' : '○ Not stored'}</span>
              <button class="generate-link" id="generate-btn" type="button">Generate new</button>
            </div>
          </div>
          <input type="password" id="personal-key" placeholder="Your personal encryption key" autocomplete="off" />
          <div class="hint">Leave blank to keep your existing personal key.</div>
        </div>

        <div class="field">
          <div class="label-row">
            <label for="org-key">Organisation Key ${hasOrgKey ? '' : '(optional)'}</label>
            <span class="status-badge ${hasOrgKey ? 'stored' : 'not-stored'}">${hasOrgKey ? '● Stored' : '○ Not stored'}</span>
          </div>
          <input type="password" id="org-key" placeholder="${hasOrgKey ? 'Replace existing organisation key' : 'Organisation key (provided by admin)'}" autocomplete="off" />
          <div class="hint">Leave blank to keep your existing organisation key.</div>
        </div>

        <div class="error" id="error-msg"></div>

        <div id="overwrite-warning" style="display:none;margin-top:12px;padding:10px 12px;border-radius:6px;background:rgba(255,160,60,0.10);border:1px solid rgba(255,160,60,0.30);font-size:12px;color:#e8a030;line-height:1.5;">
          <strong>Re-encrypt stored credentials?</strong><br>
          Your existing encrypted credentials will be re-encrypted with the new key. This is safe as long as you save the new key now.
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="overwrite-cancel-btn" style="flex:1;">Go back</button>
            <button id="overwrite-confirm-btn" style="flex:1;background:#e8a030;color:#1a1a1a;border-color:#e8a030;font-weight:600;">Yes, re-encrypt</button>
          </div>
        </div>

        <div id="fresh-key-warning" style="display:none;margin-top:12px;padding:10px 12px;border-radius:6px;background:rgba(255,160,60,0.10);border:1px solid rgba(255,160,60,0.30);font-size:12px;color:#e8a030;line-height:1.5;">
          <strong>Delete &amp; overwrite existing encrypted data?</strong><br>
          Any previously encrypted credentials stored on the server will be deleted. This cannot be undone.
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="fresh-cancel-btn" style="flex:1;">Go back</button>
            <button id="fresh-confirm-btn" style="flex:1;background:#e8a030;color:#1a1a1a;border-color:#e8a030;font-weight:600;">Yes, delete &amp; overwrite</button>
          </div>
        </div>

        <div class="actions" id="actions-row">
          <button id="cancel-btn">Cancel</button>
          <button id="save-btn">Save &amp; Apply</button>
        </div>
      </div>

      <div class="success" id="success-view">
        <div class="check">✓</div>
        <p>Keys updated and MCP configs refreshed.</p>
      </div>

      <script>
        const { ipcRenderer } = require('electron')

        const CURRENT_SECRET_KEY = ${JSON.stringify(currentSecretKey)}
        const CAN_ROLL = ${canRoll}

        function parseCompositeKey(key) {
          let userPart = null
          let domainPart = null
          if (!key) return { userPart: null, domainPart: null }
          for (const segment of key.split('.')) {
            if (segment.startsWith('user:')) userPart = segment.slice(5)
            else if (segment.startsWith('admin:')) domainPart = segment.slice(6)
          }
          return { userPart, domainPart }
        }

        function buildCompositeKey(userPart, domainPart) {
          const parts = ['user:' + userPart]
          if (domainPart) parts.push('admin:' + domainPart)
          return parts.join('.')
        }

        function generateKey() {
          const bytes = new Uint8Array(32)
          crypto.getRandomValues(bytes)
          return btoa(String.fromCharCode(...bytes))
        }

        const copyCurrentBtn = document.getElementById('copy-current-btn')
        if (copyCurrentBtn) {
          copyCurrentBtn.addEventListener('click', () => {
            require('electron').clipboard.writeText(CURRENT_SECRET_KEY)
            const orig = copyCurrentBtn.innerHTML
            copyCurrentBtn.innerHTML = '<span>✓</span> Copied!'
            setTimeout(() => { copyCurrentBtn.innerHTML = orig }, 2000)
          })
        }

        function updateSaveBtnState() {
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const orgKeyInput = document.getElementById('org-key').value.trim()
          const hasChanges = !!(personalKeyInput || orgKeyInput)
          document.getElementById('save-btn').classList.toggle('has-changes', hasChanges)
        }

        document.getElementById('personal-key').addEventListener('input', updateSaveBtnState)
        document.getElementById('org-key').addEventListener('input', updateSaveBtnState)

        document.getElementById('generate-btn').addEventListener('click', () => {
          const input = document.getElementById('personal-key')
          input.type = 'text'
          input.value = generateKey()
          setTimeout(() => { input.type = 'password' }, 3000)
          updateSaveBtnState()
        })

        document.getElementById('cancel-btn').addEventListener('click', () => window.close())

        const overwriteWarning = document.getElementById('overwrite-warning')
        const freshKeyWarning = document.getElementById('fresh-key-warning')
        const actionsRow = document.getElementById('actions-row')
        const errorEl = document.getElementById('error-msg')

        function hideWarnings() {
          overwriteWarning.style.display = 'none'
          freshKeyWarning.style.display = 'none'
          actionsRow.style.display = 'flex'
        }

        document.getElementById('overwrite-cancel-btn').addEventListener('click', hideWarnings)
        document.getElementById('fresh-cancel-btn').addEventListener('click', hideWarnings)

        async function doSave() {
          const saveBtn = document.getElementById('save-btn')
          const cancelBtn = document.getElementById('cancel-btn')
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const orgKeyInput = document.getElementById('org-key').value.trim()

          overwriteWarning.style.display = 'none'
          actionsRow.style.display = 'flex'
          errorEl.style.display = 'none'

          saveBtn.disabled = true
          cancelBtn.disabled = true
          saveBtn.textContent = 'Saving...'

          const existing = parseCompositeKey(CURRENT_SECRET_KEY)

          try {
            const newUserPart = personalKeyInput || null
            const newDomainPart = orgKeyInput || null

            const finalUserPart = newUserPart ?? existing.userPart
            const finalDomainPart = newDomainPart ?? existing.domainPart

            const compositeKey = buildCompositeKey(finalUserPart, finalDomainPart)
            const isOverwrite = !!(newUserPart && existing.userPart)

            await ipcRenderer.invoke('update-keys:save', {
              compositeKey,
              isOverwrite,
              newUserPart: isOverwrite ? newUserPart : undefined,
            })

            document.getElementById('form-view').style.display = 'none'
            document.getElementById('success-view').style.display = 'block'
            setTimeout(() => window.close(), 1500)
          } catch (err) {
            errorEl.textContent = err.message || 'Failed to update keys.'
            errorEl.style.display = 'block'
            saveBtn.disabled = false
            cancelBtn.disabled = false
            saveBtn.textContent = 'Save & Apply'
          }
        }

        document.getElementById('overwrite-confirm-btn').addEventListener('click', doSave)
        document.getElementById('fresh-confirm-btn').addEventListener('click', doSave)

        document.getElementById('save-btn').addEventListener('click', function () {
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const existing = parseCompositeKey(CURRENT_SECRET_KEY)
          errorEl.style.display = 'none'

          // Must have at least one of: new personal key, or an existing one
          if (!personalKeyInput && !existing.userPart) {
            errorEl.textContent = 'Please enter your personal key.'
            errorEl.style.display = 'block'
            return
          }

          // Overwriting an existing personal key
          if (personalKeyInput && existing.userPart) {
            actionsRow.style.display = 'none'
            if (CAN_ROLL) {
              overwriteWarning.style.display = 'block'
            } else {
              freshKeyWarning.style.display = 'block'
            }
            return
          }

          // Setting a personal key for the first time - warn that server data may be cleared
          if (personalKeyInput && !existing.userPart) {
            actionsRow.style.display = 'none'
            freshKeyWarning.style.display = 'block'
            return
          }

          doSave()
        })
      </script>
    </body>
    </html>
  `
}

export function showUpdateKeysWindow(
  getSetupData: () => {
    apiBaseUrl?: string
    mcpBaseUrl?: string
    apiKey?: string
    edisonSecretKey?: string
  },
  saveEdisonSecretKey: (key: string) => void,
  runApplyAppIntegrations: (compositeKey: string) => Promise<void>,
): void {
  if (updateKeysWindow && !updateKeysWindow.isDestroyed()) {
    updateKeysWindow.focus()
    return
  }

  const setupData = getSetupData()
  const currentSecretKey = setupData.edisonSecretKey ?? ''
  // Roll is possible only if we have the old key and backend credentials to authenticate
  const canRoll = !!(currentSecretKey && setupData.apiBaseUrl && setupData.apiKey)

  updateKeysWindow = new BrowserWindow({
    width: 420,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Update Keys',
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const saveHandler = async (
    _event: Electron.IpcMainInvokeEvent,
    { compositeKey, isOverwrite, newUserPart }: {
      compositeKey: string
      isOverwrite: boolean
      newUserPart?: string
    },
  ): Promise<void> => {
    const setup = getSetupData()
    const oldCompositeKey = setup.edisonSecretKey

    // Save locally and apply configs immediately - never blocked by backend
    saveEdisonSecretKey(compositeKey)
    await runApplyAppIntegrations(compositeKey)

    // Best-effort backend key roll when overwriting:
    // re-encrypts stored values with the new key, deletes any it can't re-encrypt.
    if (isOverwrite && newUserPart && oldCompositeKey && setup.apiBaseUrl && setup.apiKey) {
      const newUserPartHash = createHash('sha256').update(newUserPart).digest('hex')
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setup.apiKey}`,
      }
      try {
        const rollRes = await fetch(`${setup.apiBaseUrl}/api/v1/user/secret-key/roll`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            old_key: oldCompositeKey,
            new_user_part: newUserPart,
            new_user_part_hash: newUserPartHash,
          }),
        })
        if (!rollRes.ok) {
          // Roll failed (e.g. old key hash mismatch) - wipe encrypted values instead
          await fetch(`${setup.apiBaseUrl}/api/v1/user/secret-key/reset`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ new_key_hash: newUserPartHash, confirm: true }),
          }).catch(() => {})
        }
      } catch {
        // Backend unreachable - encrypted values will be orphaned until next roll
      }
    }
  }

  try {
    ipcMain.handle('update-keys:save', saveHandler)
  } catch {
    ipcMain.removeHandler('update-keys:save')
    ipcMain.handle('update-keys:save', saveHandler)
  }

  updateKeysWindow.on('closed', () => {
    ipcMain.removeHandler('update-keys:save')
    updateKeysWindow = null
  })

  const html = buildUpdateKeysHtml(currentSecretKey, canRoll)
  updateKeysWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  updateKeysWindow.once('ready-to-show', () => updateKeysWindow?.show())
  // Linux-only fallback: `ready-to-show` may never fire there, leaving this
  // `show: false` window hidden forever. See detectord/approvalDialog.ts.
  if (process.platform === 'linux') {
    updateKeysWindow.webContents.once('did-finish-load', () => updateKeysWindow?.show())
  }
}
