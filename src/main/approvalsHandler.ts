/**
 * SSE event subscription, approval handling, and the pending-approvals dialog.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import { BrowserWindow, Notification } from "electron";

// eslint-disable-next-line @typescript-eslint/no-require-imports
import trayIconPath from "../../resources/icon_tray.png?asset";

import { getApprovalUrl, getEventsUrl, getSetupData } from "./setupConfig";

// ── SSE state ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eventSource: any = null;
export const pendingApprovals: Map<string, PendingApproval> = new Map();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 1000;

export interface PendingApproval {
  id: string;
  sessionId: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  reason?: string;
  timestamp: number;
}

export interface TrifectaEventData {
  session_id: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  reason?: string;
  user_id?: string;
}

// References to windows managed by the caller (index.ts) — populated via initApprovalsHandler.
let _getMainWindow: () => BrowserWindow | null = () => null;
let _getApprovalWindow: () => BrowserWindow | null = () => null;
let _setApprovalWindow: (w: BrowserWindow | null) => void = () => {};
let _onPendingChanged: (() => void) | null = null;

export function initApprovalsHandler(
  getMainWindow: () => BrowserWindow | null,
  getApprovalWindowRef: () => BrowserWindow | null,
  setApprovalWindowRef: (w: BrowserWindow | null) => void,
  onPendingChanged: () => void,
): void {
  _getMainWindow = getMainWindow;
  _getApprovalWindow = getApprovalWindowRef;
  _setApprovalWindow = setApprovalWindowRef;
  _onPendingChanged = onPendingChanged;
}

// ── SSE event subscription ──────────────────────────────────────────

export function startEventSubscription(onQuarantineEnabled: (domain?: string) => void): void {
  const setupData = getSetupData();
  const apiKey = setupData.apiKey;
  const userId = setupData.userId;

  if (!apiKey || !userId) {
    console.warn("Cannot start event subscription: missing apiKey or userId");
    return;
  }

  const eventsUrl = getEventsUrl(apiKey);
  if (!eventsUrl) {
    console.warn("Cannot start event subscription: cannot construct events URL");
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  console.log(`Connecting to SSE endpoint: ${eventsUrl.replace(/api_key=[^&]+/, "api_key=***")}`);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventSource } = require("eventsource");
    eventSource = new EventSource(eventsUrl);

    eventSource.onmessage = (event: { data: string }) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "mcp_pre_block") {
          handleTrifectaEvent(data);
        } else if (data.type === "quarantine_enabled") {
          const userDomain = getSetupData().userEmail?.split("@")[1];
          if (!data.domain || data.domain === userDomain) {
            onQuarantineEnabled(data.domain);
          }
        }
      } catch (err) {
        console.error("Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = () => {
      handleReconnect(onQuarantineEnabled);
    };

    eventSource.onopen = () => {
      console.log("SSE connection established");
      reconnectAttempts = 0;
    };
  } catch (err) {
    console.error("Failed to create EventSource:", err);
    handleReconnect(onQuarantineEnabled);
  }
}

export function stopEventSubscription(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempts = 0;
}

function handleReconnect(onQuarantineEnabled: (domain?: string) => void): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("Max reconnect attempts reached, stopping SSE subscription");
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  setTimeout(() => {
    startEventSubscription(onQuarantineEnabled);
  }, delay);
}

function handleTrifectaEvent(data: TrifectaEventData): void {
  const mainWindow = _getMainWindow();
  const approvalWindow = _getApprovalWindow();
  const { session_id, kind, name, reason } = data;
  const approvalId = `${session_id}::${kind}::${name}::${Date.now()}`;

  const pending: PendingApproval = {
    id: approvalId,
    sessionId: session_id,
    kind,
    name,
    reason,
    timestamp: Date.now(),
  };
  pendingApprovals.set(approvalId, pending);
  _onPendingChanged?.();

  // Notify approval window if open
  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.webContents.send("approval:added", {
      id: approvalId,
      sessionId: session_id,
      kind,
      name,
      reason,
      timestamp: pending.timestamp,
    });
  }

  // Show native notification
  try {
    if (!Notification.isSupported()) return;

    const toolName = name.replace(/^agent_/, "").replace(/_/g, " ");
    const readableName = toolName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    const notificationOptions: Electron.NotificationConstructorOptions = {
      title: "Edison Watch - Security Block",
      body: `${readableName} has been blocked.\nThis action requires your approval to proceed.`,
      urgency: "normal",
      ...(process.platform !== "darwin" && { icon: trayIconPath }),
    };

    if (process.platform === "darwin") {
      notificationOptions.actions = [
        { type: "button", text: "Approve" },
        { type: "button", text: "Auto-Approve" },
        { type: "button", text: "Deny" },
      ];
    }

    const notification = new Notification(notificationOptions);

    if (process.platform === "darwin") {
      notification.on("action", (_event, index) => {
        const commands: Array<"approve" | "approve_and_remember" | "deny"> = [
          "approve",
          "approve_and_remember",
          "deny",
        ];
        const command = commands[index];
        if (command) handleApproval(approvalId, command);
      });
    }

    notification.on("click", () => {
      showPendingApprovalsDialog(mainWindow);
    });

    notification.show();
    setTimeout(() => notification.close(), 30000);
  } catch (err) {
    console.error("Failed to show notification:", err);
  }
}

// ── Approval handling ───────────────────────────────────────────────

export async function handleApproval(
  approvalId: string,
  command: "approve" | "deny" | "approve_and_remember",
): Promise<void> {
  const approvalWindow = _getApprovalWindow();
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return;

  const setupData = getSetupData();
  const apiKey = setupData.apiKey;
  if (!apiKey) return;

  const approvalUrl = getApprovalUrl();
  if (!approvalUrl) return;

  try {
    const response = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        session_id: pending.sessionId,
        kind: pending.kind,
        name: pending.name,
        command,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Approval failed: ${response.status} ${errorText}`);
    }

    pendingApprovals.delete(approvalId);
    _onPendingChanged?.();

    // Show success notification
    if (Notification.isSupported()) {
      const actionLabel =
        command === "approve"
          ? "approved"
          : command === "approve_and_remember"
            ? "approved and remembered"
            : "denied";
      const n = new Notification({
        title: "Edison Watch",
        body: `Successfully ${actionLabel} ${pending.kind} '${pending.name}'`,
        ...(process.platform !== "darwin" && { icon: trayIconPath }),
      });
      n.show();
    }

    if (approvalWindow && !approvalWindow.isDestroyed()) {
      approvalWindow.webContents.send("approval:removed", approvalId);
      if (pendingApprovals.size === 0) {
        setTimeout(() => {
          if (approvalWindow && !approvalWindow.isDestroyed()) approvalWindow.close();
        }, 500);
      }
    }
  } catch (err) {
    console.error(`Failed to ${command} ${pending.kind} '${pending.name}':`, err);
  }
}

// ── Pending approvals dialog ────────────────────────────────────────

export function showPendingApprovalsDialog(mainWindow: BrowserWindow | null): void {
  const approvalWindow = _getApprovalWindow();
  const approvals = Array.from(pendingApprovals.values());
  if (approvals.length === 0) return;

  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.focus();
    return;
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
      contextIsolation: false,
    },
  });
  _setApprovalWindow(newApprovalWindow);

  const approvalsHtml = approvals
    .map((a) => {
      const toolName = a.name.replace(/^agent_/, "").replace(/_/g, " ");
      const readableName = toolName
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      return `
        <div class="approval-item" data-approval-id="${a.id}">
          <div class="approval-header">
            <strong>${readableName}</strong>
            <span class="approval-kind">${a.kind}</span>
          </div>
          <div class="approval-session">Session: ${a.sessionId.substring(0, 8)}...</div>
          <div class="approval-timestamp" data-timestamp="${a.timestamp}"></div>
          <div class="approval-actions">
            <button class="button button-approve" data-command="approve">Approve</button>
            <button class="button button-approve-remember" data-command="approve_and_remember">Auto-Approve</button>
            <button class="button button-deny" data-command="deny">Deny</button>
          </div>
        </div>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Pending Approvals</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0b0c10;--card:#111318;--border:#1f2430;--text:#e6e6e6;--muted:#a0a7b4}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
h1{font-size:20px}
.header-actions{display:flex;gap:8px}
.approval-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;overflow:hidden;transition:all .4s cubic-bezier(.4,0,.2,1)}
.approval-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.approval-header strong{font-size:16px}
.approval-kind{font-size:12px;color:var(--muted);text-transform:uppercase}
.approval-session{font-size:12px;color:var(--muted);margin-bottom:4px}
.approval-timestamp{font-size:11px;color:var(--muted);margin-bottom:12px}
.approval-actions{display:flex;gap:8px}
.button{border:1px solid var(--border);background:var(--card);color:var(--text);padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;transition:filter .2s}
.button:hover{filter:brightness(1.05)}
.button:disabled{opacity:.5;cursor:not-allowed}
.button-approve{background:#22c55e!important;color:#fff!important;border-color:#22c55e!important}
.button-approve-remember{background:#2563eb!important;color:#fff!important;border-color:#2563eb!important}
.button-deny{background:rgba(239,68,68,.1)!important;border-color:var(--border)!important}
.button-approve-all{background:#22c55e!important;color:#fff!important;border-color:#22c55e!important}
.button-deny-all{background:rgba(239,68,68,.1)!important;border-color:var(--border)!important}
</style></head>
<body>
<div class="header">
  <h1>Pending Approvals (${approvals.length})</h1>
  <div class="header-actions">
    <button class="button button-approve-all" id="approve-all">Approve All</button>
    <button class="button button-deny-all" id="deny-all">Deny All</button>
  </div>
</div>
<div id="approvals">${approvalsHtml}</div>
<script>
const{ipcRenderer}=require('electron');
function updateHeaderCount(){const r=document.querySelectorAll('.approval-item').length;const h=document.querySelector('h1');if(h)h.textContent='Pending Approvals ('+r+')'}
function formatTimestamp(ts){const d=new Date(ts),now=new Date(),diff=Math.floor((now-d)/1000);const ds=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});const ts2=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});let rel='';if(diff<60)rel=diff+' second'+(diff!==1?'s':'')+' ago';else if(diff<3600){const m=Math.floor(diff/60);rel=m+' minute'+(m!==1?'s':'')+' ago'}else if(diff<86400){const h=Math.floor(diff/3600);rel=h+' hour'+(h!==1?'s':'')+' ago'}else{const dy=Math.floor(diff/86400);rel=dy+' day'+(dy!==1?'s':'')+' ago'}return ds+', '+ts2+' ('+rel+')'}
function updateTimestamps(){document.querySelectorAll('.approval-timestamp').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(t)el.textContent=formatTimestamp(t)})}
setInterval(updateTimestamps,1000);updateTimestamps();
function removeApprovalItem(id){const item=document.querySelector('[data-approval-id="'+id+'"]');if(!item)return;item.style.transition='all .4s cubic-bezier(.4,0,.2,1)';item.style.transform='translateX(-100%)';item.style.opacity='0';item.style.maxHeight=item.offsetHeight+'px';setTimeout(()=>{item.style.maxHeight='0';item.style.marginBottom='0';item.style.paddingTop='0';item.style.paddingBottom='0';item.style.borderWidth='0'},100);setTimeout(()=>{item.remove();updateHeaderCount();if(document.querySelectorAll('.approval-item').length===0)setTimeout(()=>window.close(),300)},400)}
document.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn)return;const item=btn.closest('.approval-item');if(!item)return;const aId=item.dataset.approvalId,cmd=btn.dataset.command;if(aId&&cmd){item.querySelectorAll('button').forEach(b=>{b.disabled=true;b.style.opacity='0.5'});const ch=cmd==='approve_and_remember'?'approval:approve-remember':'approval:'+cmd;ipcRenderer.invoke(ch,aId).catch(err=>{alert('Failed: '+(err.message||String(err)));item.querySelectorAll('button').forEach(b=>{b.disabled=false;b.style.opacity='1'})})}});
function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function addApprovalItem(a){const c=document.getElementById('approvals');if(!c)return;const tn=(a.name||'').replace(/^agent_/,'').replace(/_/g,' ');const rn=tn.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');const item=document.createElement('div');item.className='approval-item';item.setAttribute('data-approval-id',a.id);item.style.opacity='0';item.style.transform='translateY(-20px)';item.innerHTML='<div class="approval-header"><strong>'+escapeHtml(rn)+'</strong><span class="approval-kind">'+escapeHtml(a.kind)+'</span></div><div class="approval-session">Session: '+escapeHtml((a.sessionId||'').substring(0,8))+'...</div><div class="approval-timestamp" data-timestamp="'+escapeHtml(a.timestamp)+'"></div><div class="approval-actions"><button class="button button-approve" data-command="approve">Approve</button><button class="button button-approve-remember" data-command="approve_and_remember">Auto-Approve</button><button class="button button-deny" data-command="deny">Deny</button></div>';c.appendChild(item);setTimeout(()=>{item.style.transition='all .3s cubic-bezier(.4,0,.2,1)';item.style.opacity='1';item.style.transform='translateY(0)'},10);const tel=item.querySelector('.approval-timestamp');if(tel)tel.textContent=formatTimestamp(a.timestamp);updateHeaderCount()}
ipcRenderer.on('approval:removed',(_e,id)=>removeApprovalItem(id));
ipcRenderer.on('approval:added',(_e,a)=>addApprovalItem(a));
document.getElementById('approve-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-approve');if(b&&!b.disabled)b.click()})});
document.getElementById('deny-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-deny');if(b&&!b.disabled)b.click()})});
</script></body></html>`;

  newApprovalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  newApprovalWindow.once("ready-to-show", () => newApprovalWindow.show());
  newApprovalWindow.on("closed", () => { _setApprovalWindow(null); });
}
