// Bootstrap the detector daemon: install + launch it (on every client run),
// enroll it with the app's credentials, and mirror everything it does into the
// client's log streams. In primary mode (the default) the daemon owns detection,
// quarantine, install, and hooks — the TS pipeline stands down.
//
// Logging: we emit console.log with the SAME prefixes the TS pipeline uses
// (`[Monitor]`, `[Quarantine]`, `[SeenStore]`) so monitorLog's tee captures them
// into /tmp/ew-monitor.log — the client "still produces the detection and
// quarantine logs" even though the daemon is the one doing the work. Install /
// enroll use a `[detectord]` prefix.

import {
  getApiBaseUrl,
  getCredentialsForEnv,
  getMcpBaseUrl,
  getSetupData,
  isSetupComplete
} from '../infra/setupConfig'

import { showDaemonApprovalDialog } from './approvalDialog'
import { detectordBinaryExists, getDetectordBinaryPath } from './binary'
import { ensureDetectord } from './lifecycle'
import { detectordPrimary } from './mode'
import type { DetectordEvent, SecretOutcome, ServerView } from './protocol'
import type { DetectordClient } from './socket'

// App ids use dashes (`claude-code`); daemon agent names use underscores.
const toAgent = (appId: string): string => appId.replace(/-/g, '_')

let eventsSubscribed = false

/**
 * Credentials pushed from the renderer right after sign-in. A returning login
 * keeps its API key in the renderer's auth state and never persists it to the
 * main-process setup file, so `getCredentialsForEnv()` is empty at app-ready.
 * The renderer therefore pushes them here (mirroring `stdiod.login`) so the
 * daemon can enroll on login instead of only after onboarding.
 */
export interface DetectordEnrollInput {
  apiUrl?: string
  mcpUrl?: string
  apiKey?: string
  edisonSecretKey?: string
}

/**
 * Install + enroll + start logging the daemon. Idempotent — safe to call
 * unconditionally on app-ready, on setup:complete, after account switches, and
 * from the renderer's post-login push (install is once-per-session; enroll is
 * additive). Without `creds` it reads persisted setup; enroll is skipped (with
 * a log) until credentials are available from either source.
 */
export async function bootstrapDetectord(creds?: DetectordEnrollInput): Promise<void> {
  const primary = detectordPrimary()
  console.log(
    `[detectord] bootstrap mode=${primary ? 'primary (enforce)' : 'shadow (detect-only)'} ` +
      `binary=${getDetectordBinaryPath()} available=${detectordBinaryExists()}`
  )
  const ensured = await ensureDetectord((m) => console.log(m), primary)
  if (!ensured.ok) {
    console.error(`[detectord] bootstrap skipped: ${ensured.reason}`)
    return
  }
  const client = ensured.client

  // Enroll is safe to run on every login: it's additive (agents union with the
  // existing set — never removed) and non-destructive (a missing secret keeps
  // the existing one). So we always (re-)enroll whenever credentials are
  // available rather than guarding on prior state; agent/key *additions* still
  // come through here (union) and removals go through unenroll.
  if (!(await enrollDaemon(client, primary, creds))) return

  if (!eventsSubscribed) {
    eventsSubscribed = true
    client.onEvent((ev) => void handleDaemonEvent(client, ev))
  }

  await logInitialDetection(client)
}

/**
 * Register/adopt the org secret key with the daemon when the user enters or
 * changes it (OrgKeyCard). `verify_secret` validates against the backend and
 * adopts it into the enrollment — the explicit "enroll key" state change. The
 * daemon must already be enrolled; if it isn't, this is a non-fatal no-op.
 */
export async function setDetectordSecret(
  key: string
): Promise<{ ok: boolean; outcome?: SecretOutcome; reason?: string }> {
  const ensured = await ensureDetectord((m) => console.log(m), detectordPrimary())
  if (!ensured.ok) {
    console.warn(`[detectord] set secret skipped: ${ensured.reason}`)
    return { ok: false, reason: ensured.reason }
  }
  try {
    const outcome = await ensured.client.verifySecret(key)
    console.log(`[detectord] secret adopted valid=${outcome.valid ?? '?'}`)
    return { ok: true, outcome }
  } catch (err) {
    console.error(`[detectord] set secret failed: ${String(err)}`)
    return { ok: false, reason: String(err) }
  }
}

async function enrollDaemon(
  client: DetectordClient,
  primary: boolean,
  override?: DetectordEnrollInput
): Promise<boolean> {
  const stored = getCredentialsForEnv()
  const apiUrl = override?.apiUrl ?? getApiBaseUrl()
  const mcpUrl = override?.mcpUrl ?? getMcpBaseUrl()
  const apiKey = override?.apiKey ?? stored?.apiKey
  const edisonSecretKey = override?.edisonSecretKey ?? stored?.edisonSecretKey
  const setup = getSetupData()
  if (!apiUrl || !apiKey) {
    console.warn('[detectord] not enrolling — no api url / key yet')
    return false
  }
  // Only the apps the user has actually configured. Empty (e.g. a new user who
  // hasn't reached the app-selection step yet) => a base enroll with no agents:
  // the daemon installs edison-watch on nothing until onboarding adds them.
  // Agents are additive daemon-side, so an empty set never removes any.
  const appIds = setup.configuredApps ?? []
  const agents = appIds.map(toAgent)
  // Arm auto-quarantine only once onboarding is complete. While a new user is
  // still in onboarding the daemon stays detect-only (lists/reports, quarantines
  // nothing) so onboarding can review + send-to-EW first. setup:complete runs
  // markSetupComplete before this, so it re-enrolls armed.
  const armed = isSetupComplete()
  try {
    const status = await client.enroll({
      url: apiUrl,
      key: apiKey,
      mcpUrl: mcpUrl ?? undefined,
      agents,
      secret: edisonSecretKey,
      // primary => the daemon installs edison-watch + hooks; shadow => detect-only.
      install: primary,
      armed
    })
    console.log(
      `[detectord] enrolled org=${status.org_name ?? '?'} role=${status.role ?? '?'} ` +
        `policy.quarantine=${status.quarantine} armed=${armed} agents=${agents.join(',')}`
    )
    return true
  } catch (err) {
    console.error(`[detectord] enroll failed: ${String(err)}`)
    return false
  }
}

async function logInitialDetection(client: DetectordClient): Promise<void> {
  try {
    const servers = await client.listServers()
    const actionable = servers.filter((s) => s.state !== 'edison')
    console.log(`[Monitor] daemon discovered ${actionable.length} MCP server(s)`)
    for (const s of actionable) logServer('[Monitor]', s)
  } catch (err) {
    console.error(`[detectord] list_servers failed: ${String(err)}`)
  }
}

function logServer(prefix: string, s: ServerView): void {
  const fp = s.fingerprint ? ` fp=${s.fingerprint}` : ''
  console.log(`${prefix}   ${s.name} (${s.agent}) ${s.kind} state=${s.state}${fp}`)
}

// Batch quarantine prompts into ONE window: the daemon quarantines a whole
// batch of new servers in a single reconcile pass and fires a quarantine-prompt
// event for each, (near-)simultaneously. We debounce the burst and show all of
// them in one dialog (a row each), so the user reviews the whole set at once.
// Anything that arrives while a window is open is collected into the next batch.
const pendingBatch: ServerView[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
let dialogOpen = false
const BATCH_DEBOUNCE_MS = 400

function enqueuePrompt(client: DetectordClient, s: ServerView): void {
  // Dedup by name+agent: repeated fs events can re-emit before the user acts.
  const key = `${s.name}:${s.agent}`
  if (pendingBatch.some((q) => `${q.name}:${q.agent}` === key)) return
  pendingBatch.push(s)
  scheduleBatch(client)
}

function scheduleBatch(client: DetectordClient): void {
  if (dialogOpen) return // shown when the current window closes
  if (batchTimer) clearTimeout(batchTimer)
  batchTimer = setTimeout(() => void flushBatch(client), BATCH_DEBOUNCE_MS)
}

async function flushBatch(client: DetectordClient): Promise<void> {
  batchTimer = null
  if (dialogOpen || pendingBatch.length === 0) return
  const batch = pendingBatch.splice(0, pendingBatch.length)
  // Owners/admins register directly ("Add to Edison"); everyone else files a
  // request. The daemon enforces this by role regardless — this is the label.
  let isAdminOrOwner = false
  try {
    const status = await client.status()
    isAdminOrOwner = status.role === 'owner' || status.role === 'admin'
  } catch {
    /* label defaults to "Request Approval" */
  }
  dialogOpen = true
  try {
    await showDaemonApprovalDialog(client, batch, isAdminOrOwner)
  } finally {
    dialogOpen = false
    if (pendingBatch.length > 0) scheduleBatch(client)
  }
}

async function handleDaemonEvent(client: DetectordClient, ev: DetectordEvent): Promise<void> {
  switch (ev.event) {
    case 'quarantined':
      console.log(
        `[Quarantine] daemon quarantined ${ev.name} (${ev.agent}) state=${ev.state}` +
          (ev.fingerprint ? ` fp=${ev.fingerprint}` : '')
      )
      // New (unknown) servers need the user's call: send to EW or keep quarantined.
      if (ev.state === 'quarantine-prompt') {
        enqueuePrompt(client, ev)
      }
      break
    case 'discovered':
      logServer('[Monitor] daemon discovered', ev)
      break
    case 'policy_changed':
      console.log(`[Quarantine] daemon policy.quarantine=${ev.quarantine}`)
      break
  }
}
