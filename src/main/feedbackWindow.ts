import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { submitUserFeedback } from './sentry'
import { BASE_CSS } from './dialogStyles'

let feedbackWindow: BrowserWindow | null = null

function buildFeedbackHtml(): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Send Feedback</title>
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

        label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        textarea {
          width: 100%;
          height: 120px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          padding: 10px 12px;
          resize: vertical;
          outline: none;
          transition: border-color 0.15s ease;
        }

        textarea:focus {
          border-color: var(--accent);
        }

        .actions {
          display: flex;
          gap: 8px;
          margin-top: 16px;
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

        #submit-btn {
          background: var(--core-cyan-600);
          color: var(--baseline-black);
          border-color: var(--core-cyan-600);
          font-weight: 600;
        }

        #submit-btn:hover { filter: brightness(1.1); }

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
        <h1>Send Feedback</h1>
        <p class="subtitle">Tell us what's on your mind — bugs, suggestions, or anything else.</p>
        <label for="message">Message</label>
        <textarea id="message" placeholder="Describe the issue or share your thoughts..."></textarea>
        <div class="actions">
          <button id="cancel-btn">Cancel</button>
          <button id="submit-btn">Send Feedback</button>
        </div>
      </div>
      <div class="success" id="success-view">
        <div class="check">✓</div>
        <p>Thanks! Your feedback has been sent.</p>
      </div>
      <script>
        const { ipcRenderer } = require('electron')

        document.getElementById('cancel-btn').addEventListener('click', () => {
          window.close()
        })

        document.getElementById('submit-btn').addEventListener('click', async function () {
          const message = document.getElementById('message').value.trim()
          if (!message) {
            document.getElementById('message').focus()
            return
          }
          this.disabled = true
          document.getElementById('cancel-btn').disabled = true
          this.textContent = 'Sending...'
          try {
            await ipcRenderer.invoke('feedback:submit', { message })
            document.getElementById('form-view').style.display = 'none'
            document.getElementById('success-view').style.display = 'block'
            setTimeout(() => window.close(), 1500)
          } catch (err) {
            console.error('Feedback submit failed:', err)
            this.disabled = false
            document.getElementById('cancel-btn').disabled = false
            this.textContent = 'Send Feedback'
          }
        })
      </script>
    </body>
    </html>
  `
}

export function showFeedbackWindow(): void {
  if (feedbackWindow && !feedbackWindow.isDestroyed()) {
    feedbackWindow.focus()
    return
  }

  feedbackWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    title: 'Send Feedback',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const submitHandler = async (
    _event: Electron.IpcMainInvokeEvent,
    { message }: { message: string }
  ): Promise<{ ok: boolean }> => {
    submitUserFeedback(message)
    return { ok: true }
  }

  try {
    ipcMain.handle('feedback:submit', submitHandler)
  } catch {
    ipcMain.removeHandler('feedback:submit')
    ipcMain.handle('feedback:submit', submitHandler)
  }

  feedbackWindow.on('closed', () => {
    ipcMain.removeHandler('feedback:submit')
    feedbackWindow = null
  })

  const html = buildFeedbackHtml()
  feedbackWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  feedbackWindow.once('ready-to-show', () => feedbackWindow?.show())
}
