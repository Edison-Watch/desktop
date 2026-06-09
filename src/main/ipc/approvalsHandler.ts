/**
 * SSE event subscription, approval handling, and the pending-approvals dialog.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import { app, BrowserWindow, Notification } from 'electron'

// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from '../../../resources/icon_tray.png?asset'

import {
  getApiBaseUrl,
  getApprovalUrl,
  getEventsUrl,
  getSetupData,
  getCredentialsForEnv
} from '../infra/setupConfig'
import { buildApprovalDialogHtml, renderAgentIconSvg } from '../dialogs/approvalDialogView'

// ── SSE state ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eventSource: any = null
export const pendingApprovals: Map<string, PendingApproval> = new Map()
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
let desktopLoginRegistered = false
const RECONNECT_DELAY_MS = 1000
const APPROVAL_EXPIRY_MS = 2 * 60 * 1000 // 2 minutes - matches backend pending cutoff
let expiryTimer: ReturnType<typeof setInterval> | null = null

// SSE connection status - exposed for tray menu
let sseConnected = false
let _onSseStatusChanged: (() => void) | null = null

export function isSseConnected(): boolean {
  return sseConnected
}

export function setSseStatusCallback(cb: () => void): void {
  _onSseStatusChanged = cb
}

function updateSseStatus(connected: boolean): void {
  if (sseConnected === connected) return
  sseConnected = connected
  _onSseStatusChanged?.()
}

/** Humanised "why was this blocked" block, built server-side. */
export interface RiskLegs {
  private?: string
  untrusted?: string
  external?: string
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface RiskInfo {
  title: string
  headline: string
  summary: string
  legs: RiskLegs | null
  server_name: string
  acl_level: string
  /** LLM-judged severity (falls back to a template default per block reason). */
  risk_level?: RiskLevel
  source: 'template' | 'llm'
}

export interface PendingApproval {
  id: string
  sessionId: string
  kind: 'tool' | 'resource' | 'prompt'
  name: string
  reason?: string
  risk?: RiskInfo
  /** Pretty-printed tool-call arguments, shown in an expandable details block. */
  argumentsPreview?: string
  timestamp: number
  agentName?: string
}

export interface TrifectaEventData {
  session_id: string
  kind: 'tool' | 'resource' | 'prompt'
  name: string
  reason?: string
  risk?: RiskInfo
  arguments_preview?: string
  user_id?: string
  agent_name?: string
}

// References to windows managed by the caller (index.ts) - populated via initApprovalsHandler.
let _getMainWindow: () => BrowserWindow | null = () => null
let _getApprovalWindow: () => BrowserWindow | null = () => null
let _setApprovalWindow: (w: BrowserWindow | null) => void = () => {}
let _onPendingChanged: (() => void) | null = null

export function initApprovalsHandler(
  getMainWindow: () => BrowserWindow | null,
  getApprovalWindowRef: () => BrowserWindow | null,
  setApprovalWindowRef: (w: BrowserWindow | null) => void,
  onPendingChanged: () => void
): void {
  _getMainWindow = getMainWindow
  _getApprovalWindow = getApprovalWindowRef
  _setApprovalWindow = setApprovalWindowRef
  _onPendingChanged = onPendingChanged
}

// ── SSE event subscription ──────────────────────────────────────────

export function startEventSubscription(
  onQuarantineEnabled: (domain?: string) => void,
  onQuarantineDisabled?: (domain?: string) => void,
  onReconnected?: () => void
): void {
  const setupData = getSetupData()
  const apiKey = getCredentialsForEnv()?.apiKey
  const userId = setupData.userId

  if (!apiKey || !userId) {
    console.warn('Cannot start event subscription: missing apiKey or userId')
    return
  }

  const eventsUrl = getEventsUrl(apiKey)
  if (!eventsUrl) {
    console.warn('Cannot start event subscription: cannot construct events URL')
    return
  }

  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  // desktopLoginRegistered is intentionally NOT reset here; it is a
  // one-per-launch flag that should survive reconnects.

  console.log(`Connecting to SSE endpoint: ${eventsUrl.replace(/api_key=[^&]+/, 'api_key=***')}`)

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventSource } = require('eventsource')
    eventSource = new EventSource(eventsUrl)

    eventSource.onmessage = (event: { data: string }) => {
      try {
        const data = JSON.parse(event.data)
        console.log(`[SSE] event received: type=${data.type}`)
        if (data.type === 'mcp_pre_block') {
          // mcp_pre_block is strictly user-scoped on the backend, so anything
          // arriving here is targeted at this desktop's user. Admins observe
          // other users' approvals via the org-scoped approval_state_changed
          // channel, which only the dashboard's inline banner consumes.
          handleTrifectaEvent(data)
        } else if (data.type === 'mcp_approve_or_deny_once') {
          handleRemoteApprovalDismiss(data)
        } else if (data.type === 'quarantine_enabled') {
          const userDomain = getSetupData().userEmail?.split('@')[1]
          if (!data.domain || data.domain === userDomain) {
            onQuarantineEnabled(data.domain)
          }
        } else if (data.type === 'quarantine_disabled') {
          const userDomain = getSetupData().userEmail?.split('@')[1]
          if (!data.domain || data.domain === userDomain) {
            onQuarantineDisabled?.(data.domain)
          }
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err)
      }
    }

    eventSource.onerror = () => {
      updateSseStatus(false)
      handleReconnect(onQuarantineEnabled, onQuarantineDisabled, onReconnected)
    }

    eventSource.onopen = () => {
      console.log('SSE connection established')
      const wasReconnect = reconnectAttempts > 0
      reconnectAttempts = 0
      updateSseStatus(true)

      // Sync quarantine state on reconnect - we may have missed events while disconnected
      if (wasReconnect) {
        onReconnected?.()
      }

      // Register desktop login once per app launch so the onboarding
      // checklist knows the user has signed in to the desktop app.
      if (!desktopLoginRegistered) {
        desktopLoginRegistered = true
        const baseUrl = getApiBaseUrl()
        if (baseUrl && apiKey) {
          fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/user/register-desktop-login`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` }
          }).catch((err) => console.warn('Failed to register desktop login:', err))
        }
      }
    }
  } catch (err) {
    console.error('Failed to create EventSource:', err)
    updateSseStatus(false)
    handleReconnect(onQuarantineEnabled, onQuarantineDisabled, onReconnected)
  }
}

export function stopEventSubscription(): void {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  reconnectAttempts = 0
  desktopLoginRegistered = false // allow re-registration after logout/account switch
  updateSseStatus(false)
}

function handleReconnect(
  onQuarantineEnabled: (domain?: string) => void,
  onQuarantineDisabled?: (domain?: string) => void,
  onReconnected?: () => void
): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnect attempts reached, stopping SSE subscription')
    return
  }

  reconnectAttempts++
  const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1)
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

  setTimeout(() => {
    startEventSubscription(onQuarantineEnabled, onQuarantineDisabled, onReconnected)
  }, delay)
}

/** Safely check if the window exists and is usable. */
function isAlive(w: BrowserWindow | null): w is BrowserWindow {
  return w !== null && !w.isDestroyed()
}

function handleTrifectaEvent(data: TrifectaEventData): void {
  const mainWindow = _getMainWindow()
  const approvalWindow = _getApprovalWindow()
  const { session_id, kind, name, reason, risk, arguments_preview, agent_name } = data
  const approvalId = `${session_id}::${kind}::${name}::${Date.now()}`

  const pending: PendingApproval = {
    id: approvalId,
    sessionId: session_id,
    kind,
    name,
    reason,
    risk,
    argumentsPreview: arguments_preview,
    timestamp: Date.now(),
    agentName: agent_name
  }
  pendingApprovals.set(approvalId, pending)
  _onPendingChanged?.()
  startExpirySweep()

  // Notify approval window if open
  if (isAlive(approvalWindow)) {
    approvalWindow.webContents.send('approval:added', {
      id: approvalId,
      sessionId: session_id,
      kind,
      name,
      reason,
      risk,
      argumentsPreview: arguments_preview,
      timestamp: pending.timestamp,
      agentName: agent_name,
      agentIconSvg: renderAgentIconSvg(agent_name)
    })
  }

  // Show native notification
  try {
    const supported = Notification.isSupported()
    console.log(`[SSE] Notification.isSupported()=${supported}, approvalId=${approvalId}`)
    if (!supported) throw new Error('notifications not supported')

    const toolName = name.replace(/^agent_/, '').replace(/_/g, ' ')
    const readableName = toolName
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title: risk?.title ?? 'Edison Watch - Security Block',
      body: risk
        ? `${risk.headline} Approve only if you trust this.`
        : `${readableName} has been blocked.\nThis action requires your approval to proceed.`,
      urgency: 'normal',
      ...(process.platform !== 'darwin' && { icon: trayIconPath })
    }

    if (process.platform === 'darwin') {
      // Deny first to match the dialog, where blocking is the safe default.
      notificationOptions.actions = [
        { type: 'button', text: 'Deny' },
        { type: 'button', text: 'Approve' }
      ]
    }

    const notification = new Notification(notificationOptions)

    if (process.platform === 'darwin') {
      notification.on('action', (_event, index) => {
        const commands: Array<'approve' | 'deny'> = ['deny', 'approve']
        const command = commands[index]
        if (command) {
          handleApproval(approvalId, command)
          // The notification has served its purpose; dismiss it so it doesn't
          // linger in Notification Center until the user manually clears it.
          notification.close()
        }
      })
    }

    notification.on('click', () => {
      showPendingApprovalsDialog(_getMainWindow())
    })

    console.log(`[SSE] Showing notification for: ${readableName}`)
    notification.show()
    // Bounce dock icon so the user notices even if macOS suppresses the notification banner
    if (!isAlive(mainWindow) || !mainWindow.isFocused()) app.dock?.bounce('informational')
    setTimeout(() => notification.close(), 60000)
  } catch (err) {
    console.error('Failed to show notification:', err)
  }

  // Always pop the approval dialog as a reliable fallback - macOS can silently suppress notifications
  showPendingApprovalsDialog(_getMainWindow())
}

function handleRemoteApprovalDismiss(data: {
  session_id: string
  kind: string
  name: string
}): void {
  const { session_id, kind, name } = data
  for (const [id, approval] of pendingApprovals) {
    if (approval.sessionId === session_id && approval.kind === kind && approval.name === name) {
      pendingApprovals.delete(id)
      _onPendingChanged?.()
      const approvalWindow = _getApprovalWindow()
      if (isAlive(approvalWindow)) {
        approvalWindow.webContents.send('approval:removed', id)
        if (pendingApprovals.size === 0) {
          setTimeout(() => {
            if (isAlive(approvalWindow) && pendingApprovals.size === 0) approvalWindow.close()
          }, 500)
        }
      }
      break
    }
  }
}

// ── Auto-expiry sweep ───────────────────────────────────────────────

function sweepExpiredApprovals(): void {
  const now = Date.now()
  const expired: string[] = []
  for (const [id, approval] of pendingApprovals) {
    if (now - approval.timestamp >= APPROVAL_EXPIRY_MS) {
      expired.push(id)
    }
  }
  if (expired.length === 0) return

  const approvalWindow = _getApprovalWindow()
  for (const id of expired) {
    pendingApprovals.delete(id)
    if (isAlive(approvalWindow)) {
      approvalWindow.webContents.send('approval:removed', id)
    }
  }
  _onPendingChanged?.()

  if (pendingApprovals.size === 0) {
    stopExpirySweep()
    if (isAlive(approvalWindow)) {
      setTimeout(() => {
        if (isAlive(approvalWindow) && pendingApprovals.size === 0) approvalWindow.close()
      }, 500)
    }
  }
}

function startExpirySweep(): void {
  if (expiryTimer) return
  expiryTimer = setInterval(sweepExpiredApprovals, 15_000) // check every 15s
}

function stopExpirySweep(): void {
  if (expiryTimer) {
    clearInterval(expiryTimer)
    expiryTimer = null
  }
}

// ── Approval handling ───────────────────────────────────────────────

const inFlightApprovals = new Set<string>()

export async function handleApproval(
  approvalId: string,
  command: 'approve' | 'deny'
): Promise<void> {
  const pending = pendingApprovals.get(approvalId)
  if (!pending) {
    console.warn(`[approval] No pending approval found for id=${approvalId}`)
    return
  }

  if (inFlightApprovals.has(approvalId)) {
    console.log(`[approval] Skipping ${command} for ${approvalId} - already in-flight`)
    return
  }

  const apiKey = getCredentialsForEnv()?.apiKey
  if (!apiKey) {
    console.warn('[approval] No API key available')
    return
  }

  const approvalUrl = getApprovalUrl()
  if (!approvalUrl) {
    console.warn('[approval] Cannot construct approval URL')
    return
  }

  inFlightApprovals.add(approvalId)
  console.log(
    `[approval] Sending ${command} for ${pending.kind}:${pending.name} (session=${pending.sessionId.substring(0, 8)}...)`
  )

  try {
    const response = await fetch(approvalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        session_id: pending.sessionId,
        kind: pending.kind,
        name: pending.name,
        command
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[approval] Server returned ${response.status}: ${errorText}`)
      throw new Error(`Approval failed: ${response.status} ${errorText}`)
    }

    console.log(`[approval] Server accepted ${command}`)

    // Show success notification (best-effort)
    try {
      if (Notification.isSupported()) {
        const actionLabel = command === 'approve' ? 'approved' : 'denied'
        const n = new Notification({
          title: 'Edison Watch',
          body: `Successfully ${actionLabel} ${pending.kind} '${pending.name}'`,
          ...(process.platform !== 'darwin' && { icon: trayIconPath })
        })
        n.show()
        setTimeout(() => n.close(), 15_000)
      }
    } catch {
      // Don't let a notification failure block the UI cleanup
    }
  } catch (err) {
    console.error(`[approval] Failed to ${command} ${pending.kind} '${pending.name}':`, err)
  } finally {
    // Always remove from local state and UI, even if the POST failed -
    // a stale item the user can't dismiss is worse than a missed approval
    inFlightApprovals.delete(approvalId)
    pendingApprovals.delete(approvalId)
    _onPendingChanged?.()
    const approvalWindow = _getApprovalWindow()
    if (isAlive(approvalWindow)) {
      approvalWindow.webContents.send('approval:removed', approvalId)
      if (pendingApprovals.size === 0) {
        setTimeout(() => {
          if (isAlive(approvalWindow) && pendingApprovals.size === 0) approvalWindow.close()
        }, 500)
      }
    }
  }
}

// ── Pending approvals dialog ────────────────────────────────────────

export function showPendingApprovalsDialog(mainWindow: BrowserWindow | null): void {
  const approvalWindow = _getApprovalWindow()
  const approvals = Array.from(pendingApprovals.values())
  if (approvals.length === 0) return

  if (isAlive(approvalWindow)) {
    approvalWindow.focus()
    return
  }

  const newApprovalWindow = new BrowserWindow({
    width: 500,
    height: Math.min(600, 200 + approvals.length * 80),
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  _setApprovalWindow(newApprovalWindow)

  const html = buildApprovalDialogHtml(approvals)

  newApprovalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  newApprovalWindow.once('ready-to-show', () => newApprovalWindow.show())
  newApprovalWindow.on('closed', () => {
    // Snapshot and clear pending approvals atomically before firing async
    // denials. This prevents a new SSE event from re-opening the window
    // during the brief period while deny requests are in-flight.
    const remaining = Array.from(pendingApprovals.values()).filter(
      (p) => !inFlightApprovals.has(p.id)
    )
    pendingApprovals.clear()
    _onPendingChanged?.()
    _setApprovalWindow(null)

    // Send deny requests directly - we already cleared the map so
    // handleApproval would early-return.
    const apiKey = getCredentialsForEnv()?.apiKey
    const approvalUrl = getApprovalUrl()
    if (!apiKey || !approvalUrl) return
    for (const pending of remaining) {
      fetch(approvalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          session_id: pending.sessionId,
          kind: pending.kind,
          name: pending.name,
          command: 'deny'
        })
      })
        .then((res) => {
          if (!res.ok)
            console.error(`[approval] Close-deny for ${pending.name} returned ${res.status}`)
        })
        .catch((err) => console.error(`[approval] Failed to deny ${pending.name} on close:`, err))
    }
  })
}
