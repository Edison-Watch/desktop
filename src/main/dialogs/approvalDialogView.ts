/**
 * Pure rendering for the pending-approvals dialog: the risk block, severity
 * badge, tool-call inspector, and the full data-URL HTML document (CSS +
 * server-rendered items + the embedded client script).
 *
 * Kept separate from approvalsHandler.ts so that file stays under the 800-line
 * CI limit. No Electron window/state lives here - callers own the BrowserWindow.
 */

import { AGENT_REGISTRY, resolveAgentId } from '@edison-watch/shared/agent-registry'

import { BASE_CSS, HEADER_CSS, BUTTON_CSS } from './dialogStyles'
import type { PendingApproval, RiskInfo, RiskLegs, RiskLevel } from '../ipc/approvalsHandler'

/** Inline SVG for the agent icon, or empty string if unknown / unmapped. */
export function renderAgentIconSvg(agentName: string | undefined): string {
  if (!agentName) return ''
  const id = resolveAgentId(agentName)
  if (!id) return ''
  const entry = AGENT_REGISTRY[id]
  if (entry.svgPath) {
    return `<svg class="approval-agent-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${entry.svgPath}"/></svg>`
  }
  if (entry.customSvg) {
    const vb = entry.customViewBox ?? '0 0 24 24'
    return `<svg class="approval-agent-icon" viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${entry.customSvg}</svg>`
  }
  return ''
}

/** Escape a string for safe insertion into HTML. */
function escapeHtml(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Auto-deny window the countdown bar runs against. Must match APPROVAL_EXPIRY_MS
// in ipc/approvalsHandler.ts (and the backend EDISON_APPROVAL_TIMEOUT_S default).
const APPROVAL_TIMEOUT_MS = 30_000

// The three trifecta legs, in display order, with their literal colors
// (the dialog runs raw HTML without the dashboard's CSS color tokens).
const RISK_LEG_DEFS: ReadonlyArray<readonly [keyof RiskLegs, string, string]> = [
  ['private', 'Read private data', '#f59e0b'],
  ['untrusted', 'Saw untrusted content', '#3b82f6'],
  ['external', 'Can send data out', '#ef4444']
]

// Severity badge palette (lowest -> highest), literal hex for the raw-HTML dialog.
const RISK_LEVEL_DEFS: Record<RiskLevel, { label: string; color: string }> = {
  low: { label: 'Low risk', color: '#10b981' },
  medium: { label: 'Medium risk', color: '#f59e0b' },
  high: { label: 'High risk', color: '#f97316' },
  critical: { label: 'Critical risk', color: '#ef4444' }
}

/** Severity badge markup (mirrors riskBadge in the embedded script). */
function renderRiskBadgeHtml(level: RiskLevel | undefined): string {
  if (!level) return ''
  const def = RISK_LEVEL_DEFS[level]
  if (!def) return ''
  return (
    `<span class="risk-badge" style="color:${def.color};background:${def.color}29">` +
    `<span class="risk-badge-dot" style="background:${def.color}"></span>${escapeHtml(def.label)}</span>`
  )
}

/** Build the "why was this blocked" markup for the dialog (mirrors renderRisk in
 *  the embedded script so initial render and live-added items look identical). */
function renderRiskHtml(risk: RiskInfo | undefined): string {
  if (!risk) return ''
  const legRows: string[] = []
  if (risk.legs) {
    for (const [key, label, color] of RISK_LEG_DEFS) {
      const src = risk.legs[key]
      if (src === undefined) continue
      const source = src ? `<span class="risk-leg-source">· ${escapeHtml(src)}</span>` : ''
      legRows.push(
        `<li class="risk-leg"><span class="risk-dot" style="background:${color}"></span>` +
          `<span class="risk-leg-label">${escapeHtml(label)}</span>${source}</li>`
      )
    }
  }
  const legsHtml = legRows.length ? `<ul class="risk-legs">${legRows.join('')}</ul>` : ''
  const badge = renderRiskBadgeHtml(risk.risk_level)
  const headlineHtml = risk.headline
    ? `<div class="risk-headline">${escapeHtml(risk.headline)}${badge}</div>`
    : badge
      ? `<div class="risk-headline">${badge}</div>`
      : ''
  const aiTag = risk.source === 'llm' ? `<span class="risk-ai">✦ AI</span>` : ''
  const summaryHtml = risk.summary
    ? `<p class="risk-summary">${escapeHtml(risk.summary)}${aiTag}</p>`
    : ''
  return `<div class="risk-block">${headlineHtml}${legsHtml}${summaryHtml}</div>`
}

/** Collapsible "exact tool call" inspector (mirrors renderArgs in the script). */
function renderArgumentsHtml(argsPreview: string | undefined): string {
  if (!argsPreview) return ''
  return (
    `<details class="approval-args"><summary>View tool call details</summary>` +
    `<pre class="approval-args-pre">${escapeHtml(argsPreview)}</pre></details>`
  )
}

/** Auto-deny countdown bar (mirrors renderCountdown in the embedded script). The
 *  embedded updateCountdowns() ticks the seconds + bar width off data-timestamp. */
function renderCountdownHtml(timestamp: number): string {
  return (
    `<div class="approval-expiry" data-timestamp="${escapeHtml(String(timestamp))}">` +
    `<div class="approval-expiry-note">Auto-denies in ` +
    `<span class="approval-expiry-secs"></span> if you don&#39;t respond.</div>` +
    `<div class="approval-expiry-bar"><div class="approval-expiry-bar-fill"></div></div>` +
    `</div>`
  )
}

/** Server-rendered markup for one approval card. */
function renderApprovalItem(a: PendingApproval): string {
  const toolName = a.name.replace(/^agent_/, '').replace(/_/g, ' ')
  const readableName = toolName
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
  const agentIconSvg = renderAgentIconSvg(a.agentName)
  const headerName = a.risk?.title ?? readableName
  return `
        <div class="approval-item" data-approval-id="${escapeHtml(a.id)}">
          <div class="approval-header">
            <div class="approval-title">${agentIconSvg}<strong>${escapeHtml(headerName)}</strong></div>
            <span class="approval-kind">${escapeHtml(a.kind)}</span>
          </div>
          <div class="approval-risk">${renderRiskHtml(a.risk)}</div>
          ${renderArgumentsHtml(a.argumentsPreview)}
          <div class="approval-timestamp" data-timestamp="${escapeHtml(String(a.timestamp))}"></div>
          <div class="approval-actions">
            <button class="button button-deny" data-command="deny">Deny - block</button>
            <button class="button button-approve" data-command="approve">Approve once</button>
          </div>
          ${renderCountdownHtml(a.timestamp)}
        </div>`
}

/** Scoped CSS for the dialog (appended after the shared base/header/button CSS). */
const APPROVAL_DIALOG_CSS = `
.approval-item {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.approval-item:hover {
  border-color: var(--text-muted);
}

.approval-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.approval-header strong {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.approval-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-agent-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.approval-kind {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 2px 8px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.risk-block {
  margin: 4px 0 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.risk-headline {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}

.risk-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.risk-legs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.risk-leg {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary);
}

.risk-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.risk-leg-source {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.risk-summary {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  margin: 2px 0 0;
}

.risk-ai {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}

.approval-args {
  margin: 0 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  overflow: hidden;
}

.approval-args summary {
  cursor: pointer;
  list-style: none;
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  user-select: none;
}

.approval-args summary::-webkit-details-marker {
  display: none;
}

.approval-args summary::before {
  content: "▸ ";
  display: inline-block;
  transition: transform 0.15s;
}

.approval-args[open] summary::before {
  content: "▾ ";
}

.approval-args-pre {
  margin: 0;
  padding: 10px;
  border-top: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

.approval-timestamp {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.approval-expiry {
  margin-top: 10px;
}

.approval-expiry-note {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.approval-expiry-bar {
  height: 2px;
  width: 100%;
  background: var(--border);
  border-radius: 9999px;
  overflow: hidden;
}

.approval-expiry-bar-fill {
  height: 100%;
  width: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}

.approval-actions {
  display: flex;
  gap: 8px;
}

/* Brand colours: red = deny/block, green = approve. */
.button-deny,
.button-deny-all {
  background: var(--danger) !important;
  color: var(--bg-base) !important;
  border-color: var(--danger) !important;
  font-weight: 600 !important;
}

.button-deny:hover,
.button-deny-all:hover {
  filter: brightness(1.1) !important;
}

.button-approve,
.button-approve-all {
  background: var(--success) !important;
  color: var(--bg-base) !important;
  border-color: var(--success) !important;
  font-weight: 600 !important;
}

.button-approve:hover,
.button-approve-all:hover {
  filter: brightness(1.1) !important;
}`

// Embedded client script: mirrors the server-render helpers so live-added items
// (via the approval:added IPC) look identical to the initial render.
const APPROVAL_DIALOG_SCRIPT = `
const{ipcRenderer}=require('electron');
function requestResize(){try{ipcRenderer.send('approval:resize',document.documentElement.scrollHeight)}catch(e){}}
function updateHeaderCount(){const r=document.querySelectorAll('.approval-item').length;const h=document.querySelector('h1');if(h)h.innerHTML='Pending Approvals <span class="count">('+r+')</span>'}
function formatTimestamp(ts){const d=new Date(ts),now=new Date(),diff=Math.floor((now-d)/1000);const ds=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});const ts2=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});let rel='';if(diff<60)rel=diff+' second'+(diff!==1?'s':'')+' ago';else if(diff<3600){const m=Math.floor(diff/60);rel=m+' minute'+(m!==1?'s':'')+' ago'}else if(diff<86400){const h=Math.floor(diff/3600);rel=h+' hour'+(h!==1?'s':'')+' ago'}else{const dy=Math.floor(diff/86400);rel=dy+' day'+(dy!==1?'s':'')+' ago'}return ds+', '+ts2+' ('+rel+')'}
function updateTimestamps(){document.querySelectorAll('.approval-timestamp').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(t)el.textContent=formatTimestamp(t)})}
setInterval(updateTimestamps,1000);updateTimestamps();
var APPROVAL_TIMEOUT_MS=${APPROVAL_TIMEOUT_MS};
function renderCountdown(ts){return '<div class="approval-expiry" data-timestamp="'+escapeHtml(ts)+'"><div class="approval-expiry-note">Auto-denies in <span class="approval-expiry-secs"></span> if you don&#39;t respond.</div><div class="approval-expiry-bar"><div class="approval-expiry-bar-fill"></div></div></div>'}
function updateCountdowns(){const now=Date.now();document.querySelectorAll('.approval-expiry').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(!t)return;const left=Math.max(0,APPROVAL_TIMEOUT_MS-(now-t));const secs=Math.ceil(left/1000);const sEl=el.querySelector('.approval-expiry-secs');if(sEl)sEl.textContent=secs+'s';const fill=el.querySelector('.approval-expiry-bar-fill');if(fill)fill.style.width=(left/APPROVAL_TIMEOUT_MS*100)+'%'})}
setInterval(updateCountdowns,200);updateCountdowns();requestResize();
function removeApprovalItem(id){const item=document.querySelector('[data-approval-id="'+CSS.escape(id)+'"]');if(!item)return;item.style.transition='all .4s cubic-bezier(.4,0,.2,1)';item.style.transform='translateX(-100%)';item.style.opacity='0';item.style.maxHeight=item.offsetHeight+'px';setTimeout(()=>{item.style.maxHeight='0';item.style.marginBottom='0';item.style.paddingTop='0';item.style.paddingBottom='0';item.style.borderWidth='0'},100);setTimeout(()=>{item.remove();updateHeaderCount();requestResize();if(document.querySelectorAll('.approval-item').length===0)setTimeout(()=>window.close(),300)},400)}
document.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn)return;const item=btn.closest('.approval-item');if(!item)return;const aId=item.dataset.approvalId,cmd=btn.dataset.command;if(aId&&cmd){item.querySelectorAll('button').forEach(b=>{b.disabled=true;b.style.opacity='0.5'});const ch='approval:'+cmd;ipcRenderer.invoke(ch,aId).catch(err=>{alert('Failed: '+(err.message||String(err)));item.querySelectorAll('button').forEach(b=>{b.disabled=false;b.style.opacity='1'})})}});
function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
var RISK_LEGS=[['private','Read private data','#f59e0b'],['untrusted','Saw untrusted content','#3b82f6'],['external','Can send data out','#ef4444']];
var RISK_LEVELS={low:['Low risk','#10b981'],medium:['Medium risk','#f59e0b'],high:['High risk','#f97316'],critical:['Critical risk','#ef4444']};
function riskBadge(l){var d=l&&RISK_LEVELS[l];if(!d)return'';return '<span class="risk-badge" style="color:'+d[1]+';background:'+d[1]+'29"><span class="risk-badge-dot" style="background:'+d[1]+'"></span>'+escapeHtml(d[0])+'</span>'}
function renderArgs(p){if(!p)return'';return '<details class="approval-args"><summary>View tool call details</summary><pre class="approval-args-pre">'+escapeHtml(p)+'</pre></details>'}
function renderRisk(risk){if(!risk)return'';var rows='';if(risk.legs){for(var i=0;i<RISK_LEGS.length;i++){var k=RISK_LEGS[i][0],lbl=RISK_LEGS[i][1],col=RISK_LEGS[i][2];var src=risk.legs[k];if(src===undefined)continue;var s=src?'<span class="risk-leg-source">· '+escapeHtml(src)+'</span>':'';rows+='<li class="risk-leg"><span class="risk-dot" style="background:'+col+'"></span><span class="risk-leg-label">'+escapeHtml(lbl)+'</span>'+s+'</li>'}}var legs=rows?'<ul class="risk-legs">'+rows+'</ul>':'';var bdg=riskBadge(risk.risk_level);var head=(risk.headline||bdg)?'<div class="risk-headline">'+(risk.headline?escapeHtml(risk.headline):'')+bdg+'</div>':'';var ai=risk.source==='llm'?'<span class="risk-ai">✦ AI</span>':'';var sum=risk.summary?'<p class="risk-summary">'+escapeHtml(risk.summary)+ai+'</p>':'';return '<div class="risk-block">'+head+legs+sum+'</div>'}
function addApprovalItem(a){const c=document.getElementById('approvals');if(!c)return;const tn=(a.name||'').replace(/^agent_/,'').replace(/_/g,' ');const rn=tn.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');const hdr=(a.risk&&a.risk.title)?a.risk.title:rn;const icon=a.agentIconSvg||'';const item=document.createElement('div');item.className='approval-item';item.setAttribute('data-approval-id',a.id);item.style.opacity='0';item.style.transform='translateY(-20px)';item.innerHTML='<div class="approval-header"><div class="approval-title">'+icon+'<strong>'+escapeHtml(hdr)+'</strong></div><span class="approval-kind">'+escapeHtml(a.kind)+'</span></div><div class="approval-risk">'+renderRisk(a.risk)+'</div>'+renderArgs(a.argumentsPreview)+'<div class="approval-timestamp" data-timestamp="'+escapeHtml(a.timestamp)+'"></div><div class="approval-actions"><button class="button button-deny" data-command="deny">Deny - block</button><button class="button button-approve" data-command="approve">Approve once</button></div>'+renderCountdown(a.timestamp)+'';c.appendChild(item);setTimeout(()=>{item.style.transition='all .3s cubic-bezier(.4,0,.2,1)';item.style.opacity='1';item.style.transform='translateY(0)'},10);const tel=item.querySelector('.approval-timestamp');if(tel)tel.textContent=formatTimestamp(a.timestamp);updateCountdowns();updateHeaderCount();requestResize()}
ipcRenderer.on('approval:removed',(_e,id)=>removeApprovalItem(id));
ipcRenderer.on('approval:added',(_e,a)=>addApprovalItem(a));
document.getElementById('approve-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-approve');if(b&&!b.disabled)b.click()})});
document.getElementById('deny-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-deny');if(b&&!b.disabled)b.click()})});
`

/** Build the full data-URL HTML document for the pending-approvals window. */
export function buildApprovalDialogHtml(approvals: PendingApproval[]): string {
  const approvalsHtml = approvals.map(renderApprovalItem).join('')
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Pending Approvals</title>
<style>
${BASE_CSS}
${HEADER_CSS}
${BUTTON_CSS}
${APPROVAL_DIALOG_CSS}
</style></head>
<body>
<div class="header">
  <h1>Pending Approvals <span class="count">(${approvals.length})</span></h1>
  <div class="header-actions">
    <button class="button button-bulk button-approve-all" id="approve-all">Approve All</button>
    <button class="button button-bulk button-deny-all" id="deny-all">Deny All</button>
  </div>
</div>
<div id="approvals">${approvalsHtml}</div>
<script>${APPROVAL_DIALOG_SCRIPT}</script></body></html>`
}
