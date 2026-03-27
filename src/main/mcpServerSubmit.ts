/**
 * Server submission, approval, and role-fetching helpers.
 *
 * Extracted from mcpConfigActions.ts to keep that file under the 800-line CI limit.
 */

import type { DiscoveredMcpServer } from './mcpDiscovery'
import { detectSecrets } from './secretDetection'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubmitResult {
  request_id: number
  secretValues?: Record<string, string>
  alreadyPending?: boolean
  alreadyExists?: boolean
  errorMessage?: string
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
    secretValues[ov.varName] = ov.selectedText

    // Track in template_fields
    const bucket = context === 'args' ? 'args' : 'env'
    if (!templateFields[bucket]) templateFields[bucket] = {}
    templateFields[bucket][ov.varName] = {
      description: `User-selected credential (${ov.varName})`,
      example: ''
    }

    // Replace substring in the cloned config value
    const replaceInValue = (raw: string): string =>
      raw.slice(0, ov.start) + `{${ov.varName}}` + raw.slice(ov.end)

    if (context === 'args') {
      const idx = parseInt(key.match(/\d+/)?.[0] ?? '0', 10)
      const args = cloned.args as string[] | undefined
      if (args && args[idx] !== undefined) {
        args[idx] = replaceInValue(args[idx])
      }
    } else if (context === 'env') {
      const env = cloned.env as Record<string, string> | undefined
      if (env && env[key] !== undefined) {
        env[key] = replaceInValue(env[key])
      }
    } else if (context === 'url') {
      cloned.url = replaceInValue(String(cloned.url))
    } else if (context === 'headers') {
      const headers = cloned.headers as Record<string, string> | undefined
      if (headers && headers[key] !== undefined) {
        headers[key] = replaceInValue(headers[key])
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

  if (Object.keys(templateFields).some(k => Object.keys(templateFields[k]).length > 0)) {
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

  const responseData = (await response.json()) as { request_id: number }
  const hasSecrets = Object.keys(secretValues).length > 0
  console.log(
    `[MCP Config] Submitted server request for "${serverName}" (id: ${responseData.request_id})` +
      (hasSecrets ? ` with ${Object.keys(secretValues).length} template_fields` : '')
  )
  return { request_id: responseData.request_id, ...(hasSecrets && { secretValues }) }
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
