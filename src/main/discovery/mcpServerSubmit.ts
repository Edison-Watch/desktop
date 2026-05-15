/**
 * Server submission, approval, and role-fetching helpers.
 *
 * Extracted from mcpConfigActions.ts to keep that file under the 800-line CI limit.
 */

import type { DiscoveredMcpServer } from './types'
import { detectSecrets } from './secretDetection'
import { getServerFingerprint } from './seenServersStore'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubmitResult {
  request_id: number
  secretValues?: Record<string, string>
  alreadyPending?: boolean
  alreadyExists?: boolean
  errorMessage?: string
  // True when the backend immediately approved the request (admin/owner
  // submitter). Callers must skip the follow-up /admin/.../approve call -
  // it would 400 because the row is no longer pending.
  autoApproved?: boolean
}

/**
 * Backend's authoritative fingerprint list - approved templates ('registered')
 * and pending admin-review requests ('requested'). Returned by GET /servers/fingerprints.
 * Names are included so we can distinguish "fingerprint match" (same server already
 * on backend) from "name match with different config" (must rename).
 */
export interface BackendFingerprintEntry {
  name: string
  fingerprint: string
  status: 'registered' | 'requested'
}

export type BackendFingerprintIndex = {
  byFingerprint: Map<string, BackendFingerprintEntry>
  byName: Map<string, BackendFingerprintEntry>
}

const EMPTY_INDEX: BackendFingerprintIndex = {
  byFingerprint: new Map(),
  byName: new Map(),
}

/**
 * Pull the org's fingerprint list once per submit batch. Returns an empty index
 * on any error - the caller falls back to the existing 409-driven flow.
 *
 * Fingerprinting is server-level, not user-level: name + url (or
 * name + command + args) is the same for everyone in the org, regardless of
 * what each user has filled in for templated secrets like Authorization
 * headers. So no `X-Edison-Secret-Key` is sent or needed.
 */
export async function fetchBackendFingerprints(
  apiBaseUrl: string,
  apiKey: string,
): Promise<BackendFingerprintIndex> {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/servers/fingerprints`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      console.warn(`[preflight] GET ${url} → ${response.status}; preflight disabled (will fall through to 409 path)`)
      return EMPTY_INDEX
    }
    const data = (await response.json()) as { fingerprints?: BackendFingerprintEntry[] }
    const list = data.fingerprints ?? []
    const byFingerprint = new Map<string, BackendFingerprintEntry>()
    const byName = new Map<string, BackendFingerprintEntry>()
    for (const entry of list) {
      byFingerprint.set(entry.fingerprint, entry)
      byName.set(entry.name, entry)
    }
    console.log(`[preflight] backend has ${list.length} fingerprint(s):`)
    for (const entry of list) {
      console.log(`[preflight]   ${entry.name} → ${entry.fingerprint} (${entry.status})`)
    }
    return { byFingerprint, byName }
  } catch (err) {
    console.warn(`[preflight] GET ${url} failed:`, err)
    return EMPTY_INDEX
  }
}

/**
 * Look up `server` in the backend index.
 *
 * Fingerprint match means the exact same `(name, command/args | url)` tuple is
 * already on the backend - the caller should skip submission and surface
 * "already exists on backend". Anything else (incl. same-name-different-config)
 * falls through and the existing 409 path drives the rename dialog.
 *
 * Logs the comparison so a "rename was expected, got conflict instead"
 * mismatch can be diagnosed - usually it's the URL stored on the backend
 * differing from the URL in the user's mcp.json (trailing slash, https vs
 * http, /sse vs /mcp suffix, etc.).
 */
export function findBackendFingerprintMatch(
  server: DiscoveredMcpServer,
  index: BackendFingerprintIndex,
): BackendFingerprintEntry | null {
  if (index.byFingerprint.size === 0) return null
  const fp = getServerFingerprint(server)
  const match = index.byFingerprint.get(fp) ?? null
  if (match) {
    console.log(`[preflight]   ✓ ${server.name} fp=${fp} matches backend "${match.name}" (${match.status})`)
  } else {
    const sameName = index.byName.get(server.name)
    if (sameName) {
      console.log(`[preflight]   ✗ ${server.name} fp=${fp} differs from backend "${sameName.name}" fp=${sameName.fingerprint} (same name, different config → 409 will drive rename)`)
    } else {
      console.log(`[preflight]   - ${server.name} fp=${fp} not on backend; will submit fresh`)
    }
  }
  return match
}

export interface TemplateOverride {
  entryId: string
  varName: string
  selectedText: string
  start: number
  end: number
}

// ── Submit with auto-detection ──────────────────────────────────────────────

export async function submitServerRequest(
  server: DiscoveredMcpServer,
  apiBaseUrl: string,
  apiKey: string,
  userId?: string
): Promise<SubmitResult> {
  const serverConfig = server.config

  // Validate that server has either command (stdio) or url (HTTP/SSE).
  // Stdio servers are identified by presence of command (McpServerConfig uses type?: undefined for stdio).
  const hasCommand = 'command' in serverConfig && !!serverConfig.command
  const hasUrl = 'url' in serverConfig && !!serverConfig.url

  if (!hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server config has neither 'command' (for stdio servers) nor 'url' (for HTTP/SSE servers). The config may be malformed.`
    )
  }
  // Reject malformed stdio: configs that claim type 'stdio' but have no command (e.g. loose JSON).
  const typeVal = (serverConfig as Record<string, unknown>).type
  if (typeVal === 'stdio' && !hasCommand) {
    throw new Error(
      `Cannot request server "${server.name}": stdio server must have a 'command' field.`
    )
  }
  // Servers without explicit type (or type undefined) are assumed stdio and must have command.
  if (!('type' in serverConfig) && !hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server appears to be stdio type but has no 'command' field.`
    )
  }

  // Detect secrets and produce templatized config + template_fields
  const { config: templatizedConfig, templateFields, secretValues } = detectSecrets(server)

  // Build request payload
  const payload: Record<string, unknown> = {
    name: server.name,
    source_app: server.client,
    source_path: server.path,
    justification: `Detected in ${server.client} configuration`,
    user_id: userId
  }

  // Add config details with secrets replaced by {PLACEHOLDER} variables.
  // Include template_fields so the backend knows the schema of required secrets.
  if (hasCommand) {
    payload.command = (templatizedConfig as { command: string }).command
    payload.args = (templatizedConfig as { args?: string[] }).args
    // Send templatized env (with {PLACEHOLDERS}) so backend knows env var names
    const tEnv = (templatizedConfig as { env?: Record<string, string> }).env
    if (tEnv && Object.keys(tEnv).length > 0) {
      payload.env = tEnv
    }
  } else if (hasUrl) {
    payload.url = (templatizedConfig as { url: string }).url
    payload.type = (templatizedConfig as { type: string }).type
    const tHeaders = (templatizedConfig as { headers?: Record<string, string> }).headers
    if (tHeaders && Object.keys(tHeaders).length > 0) {
      payload.headers = tHeaders
    }
  }

  // Include template_fields if any secrets were detected
  if (
    (templateFields.args && Object.keys(templateFields.args).length > 0) ||
    (templateFields.env && Object.keys(templateFields.env).length > 0)
  ) {
    payload.template_fields = templateFields
  }

  return _postServerRequest(payload, server.name, secretValues, apiBaseUrl, apiKey)
}

// ── Submit with user-provided overrides ─────────────────────────────────────

/**
 * Submit a server request using user-provided template overrides instead of auto-detection.
 * Each override specifies which substring of which config entry is the secret.
 */
export async function submitServerWithOverrides(
  server: DiscoveredMcpServer,
  overrides: TemplateOverride[],
  apiBaseUrl: string,
  apiKey: string,
  userId?: string
): Promise<SubmitResult> {
  const serverConfig = server.config
  const hasCommand = 'command' in serverConfig && !!serverConfig.command
  const hasUrl = 'url' in serverConfig && !!serverConfig.url

  if (!hasCommand && !hasUrl) {
    throw new Error(`Cannot request server "${server.name}": no command or url.`)
  }

  // Build templatized config by applying user overrides
  const secretValues: Record<string, string> = {}
  const templateFields: Record<string, Record<string, { description: string; example: string }>> = {}

  // Deep clone the config for modification
  const cloned = JSON.parse(JSON.stringify(serverConfig)) as Record<string, unknown>

  for (const ov of overrides) {
    const [context, key] = ov.entryId.split(':', 2)
    if (context === undefined || key === undefined) continue
    secretValues[ov.varName] = ov.selectedText

    // Track in template_fields
    const bucket = context === 'args' ? 'args' : 'env'
    const bucketFields = (templateFields[bucket] ??= {})
    bucketFields[ov.varName] = {
      description: `User-selected credential (${ov.varName})`,
      example: ''
    }

    // Replace substring in the cloned config value
    const replaceInValue = (raw: string): string =>
      raw.slice(0, ov.start) + `{${ov.varName}}` + raw.slice(ov.end)

    if (context === 'args') {
      const idx = parseInt(key.match(/\d+/)?.[0] ?? '0', 10)
      const args = cloned.args as string[] | undefined
      const current = args?.[idx]
      if (args && current !== undefined) {
        args[idx] = replaceInValue(current)
      }
    } else if (context === 'env') {
      const env = cloned.env as Record<string, string> | undefined
      const current = env?.[key]
      if (env && current !== undefined) {
        env[key] = replaceInValue(current)
      }
    } else if (context === 'url') {
      cloned.url = replaceInValue(String(cloned.url))
    } else if (context === 'headers') {
      const headers = cloned.headers as Record<string, string> | undefined
      const current = headers?.[key]
      if (headers && current !== undefined) {
        headers[key] = replaceInValue(current)
      }
    }
  }

  // Build request payload
  const payload: Record<string, unknown> = {
    name: server.name,
    source_app: server.client,
    source_path: server.path,
    justification: `Detected in ${server.client} configuration`,
    user_id: userId
  }

  if (hasCommand) {
    payload.command = cloned.command
    payload.args = cloned.args
    const env = cloned.env as Record<string, string> | undefined
    if (env && Object.keys(env).length > 0) payload.env = env
  } else if (hasUrl) {
    payload.url = cloned.url
    payload.type = cloned.type
    const headers = cloned.headers as Record<string, string> | undefined
    if (headers && Object.keys(headers).length > 0) payload.headers = headers
  }

  if (Object.values(templateFields).some(v => Object.keys(v).length > 0)) {
    payload.template_fields = templateFields
  }

  return _postServerRequest(payload, server.name, secretValues, apiBaseUrl, apiKey)
}

// ── Shared POST helper ──────────────────────────────────────────────────────

async function _postServerRequest(
  payload: Record<string, unknown>,
  serverName: string,
  secretValues: Record<string, string>,
  apiBaseUrl: string,
  apiKey: string
): Promise<SubmitResult> {
  const requestUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/mcp-requests`
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const errorText = await response.text()
    if (response.status === 409) {
      let detail = errorText
      try { detail = (JSON.parse(errorText) as { detail?: string })?.detail ?? errorText } catch { /* use raw text */ }
      if (detail.includes('already have a pending request')) return { request_id: 0, alreadyPending: true }
      return { request_id: 0, alreadyExists: true, errorMessage: detail }
    }
    throw new Error(`Failed to submit server request: ${response.status} ${errorText}`)
  }

  const responseData = (await response.json()) as { request_id: number; auto_approved?: boolean }
  const hasSecrets = Object.keys(secretValues).length > 0
  const autoApproved = responseData.auto_approved === true
  console.log(
    `[MCP Config] Submitted server request for "${serverName}" (id: ${responseData.request_id}${autoApproved ? ', auto-approved' : ''})` +
      (hasSecrets ? ` with ${Object.keys(secretValues).length} template_fields` : '')
  )
  return {
    request_id: responseData.request_id,
    ...(hasSecrets && { secretValues }),
    ...(autoApproved && { autoApproved: true }),
  }
}

// ── Approve / Role ──────────────────────────────────────────────────────────

/**
 * Approve an MCP server request (admin/owner only).
 * Called after submitServerRequest to auto-approve when the user is admin/owner.
 */
export async function approveServerRequest(
  requestId: number,
  apiBaseUrl: string,
  apiKey: string
): Promise<void> {
  const approveUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/admin/mcp-requests/${requestId}/approve`

  const response = await fetch(approveUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ reviewer_notes: '' })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to approve server request: ${response.status} ${errorText}`)
  }

  console.log(`[MCP Config] Auto-approved server request ${requestId}`)
}

/**
 * Fetch the current user's role from the Edison Watch API.
 * Returns the role string ('admin', 'owner', 'user') or null if unavailable.
 */
export async function fetchUserRole(
  apiBaseUrl: string,
  apiKey: string
): Promise<string | null> {
  try {
    const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/user/profile`
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    })
    if (!response.ok) return null
    const data = (await response.json()) as { role?: string }
    return data.role ?? null
  } catch {
    return null
  }
}
