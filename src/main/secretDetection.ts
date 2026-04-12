import type { McpServerConfig, DiscoveredMcpServer } from './mcpDiscovery'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TemplateFieldInfo {
  description: string
  example: string
}

export interface TemplateFields {
  args?: Record<string, TemplateFieldInfo>
  env?: Record<string, TemplateFieldInfo>
}

export interface TemplatizedConfig {
  config: McpServerConfig
  templateFields: TemplateFields
  secretValues: Record<string, string>
}

// ── Known secret prefixes ──────────────────────────────────────────────────────

const SECRET_PREFIXES = [
  'sk-',
  'sk_live_',
  'sk_test_',
  'ghp_',
  'gho_',
  'ghs_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
  'xoxs-',
  'xapp-',
  'eyJ'
]

const CONNECTION_STRING_PREFIXES = ['mongodb+srv://', 'postgres://', 'mysql://']

// ── Sensitive key/flag name patterns ───────────────────────────────────────────

const SENSITIVE_KEY_WORDS = ['key', 'token', 'secret', 'password', 'credential', 'auth', 'bearer']

/** Flags whose values are never secrets (package managers, boolean flags, etc.) */
const NON_SECRET_FLAGS = new Set([
  '-y', '--yes', '-n', '--no', '--verbose', '--debug', '--quiet', '-q',
  '--version', '-v', '--help', '-h', '--port', '-p', '--host', '--name',
  '--config', '-c', '--output', '-o', '--input', '-i', '--dir', '--cwd',
  '--format', '--level', '--log-level', '--timeout', '--retry', '--max-retries'
])

function isSensitiveKeyName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_KEY_WORDS.some((w) => lower.includes(w))
}

function isNonSecretFlag(flag: string): boolean {
  return NON_SECRET_FLAGS.has(flag.toLowerCase())
}

// ── Value-level detection ──────────────────────────────────────────────────────

function hasKnownSecretPrefix(value: string): boolean {
  return SECRET_PREFIXES.some((p) => value.startsWith(p))
}

function isConnectionString(value: string): boolean {
  return CONNECTION_STRING_PREFIXES.some((p) => value.startsWith(p))
}

/** Values that look like package names, file paths, or URLs - not secrets */
function looksLikeNonSecret(value: string): boolean {
  // URLs (http/https without embedded credentials)
  if (/^https?:\/\//.test(value)) return true
  // npm package names: @scope/package or bare package names
  if (/^@[\w-]+\/[\w.-]+/.test(value)) return true
  // Bare npm package names (lowercase, hyphens, dots - e.g. "typescript", "ts-node")
  if (/^[a-z][\w.-]*$/.test(value) && !hasKnownSecretPrefix(value)) return true
  // File paths
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('~')) return true
  // Windows paths
  if (/^[A-Z]:\\/.test(value)) return true
  return false
}

/** High-entropy / long alphanumeric string that looks like an API key */
function looksLikeApiKey(value: string): boolean {
  if (value.length < 32) return false
  if (looksLikeNonSecret(value)) return false
  // Must be mostly alphanumeric / base64 chars
  const alphanumCount = (value.match(/[A-Za-z0-9_\-+/=]/g) || []).length
  return alphanumCount / value.length > 0.85
}

/**
 * Extract an embedded auth token from a value like "Bearer xxx" or "Authorization: Bearer xxx".
 * Returns { prefix, token } if found, null otherwise. Only the token is the secret.
 */
function extractAuthToken(value: string): { prefix: string; token: string } | null {
  // Match "Authorization: Bearer xxx", "Authorization: Basic xxx", etc.
  const headerMatch = value.match(/^(.*?(?:Bearer|Basic)\s+)(.+)$/i)
  if (headerMatch) {
    const token = headerMatch[2]
    // Only treat as secret if the token itself looks like a secret
    if (hasKnownSecretPrefix(token) || looksLikeApiKey(token) || token.length >= 8) {
      return { prefix: headerMatch[1], token }
    }
  }
  return null
}

function isSecretValue(value: string): boolean {
  return hasKnownSecretPrefix(value) || isConnectionString(value) || looksLikeApiKey(value)
}

// ── Variable name derivation ───────────────────────────────────────────────────

/** Convert a flag name like --stripe-api-key to STRIPE_API_KEY */
function flagToVarName(flag: string): string {
  return flag
    .replace(/^-+/, '')
    .replace(/[-. ]/g, '_')
    .toUpperCase()
}

/** Generate a description string based on how the secret was found */
function descriptionFor(context: 'arg' | 'env' | 'header' | 'url', varName: string): string {
  switch (context) {
    case 'arg':
      return `Secret value detected in command-line argument (${varName})`
    case 'env':
      return `Environment variable ${varName}`
    case 'header':
      return `HTTP header value for ${varName}`
    case 'url':
      return `Credential embedded in server URL`
  }
}

// ── Arg parsing helpers ────────────────────────────────────────────────────────

interface ParsedFlag {
  index: number
  flag: string
  value: string
  /** Whether the value was in the next arg (--flag VALUE) vs --flag=VALUE */
  nextArg: boolean
}

/**
 * Parse args array to find flag-value pairs.
 * Handles --flag=VALUE and --flag VALUE patterns.
 */
function parseFlagValuePairs(args: string[]): ParsedFlag[] {
  const pairs: ParsedFlag[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('-')) continue

    // --flag=value
    const eqIdx = arg.indexOf('=')
    if (eqIdx !== -1) {
      pairs.push({
        index: i,
        flag: arg.slice(0, eqIdx),
        value: arg.slice(eqIdx + 1),
        nextArg: false
      })
      continue
    }

    // --flag value (next arg is the value, if it exists and doesn't look like a flag)
    if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
      pairs.push({
        index: i,
        flag: arg,
        value: args[i + 1],
        nextArg: true
      })
    }
  }
  return pairs
}

// ── Core detection ─────────────────────────────────────────────────────────────

function ensureUniqueVarName(
  desired: string,
  existing: Set<string>,
  serverName: string
): string {
  if (!existing.has(desired)) return desired
  // Prefix with server name
  const prefixed = `${serverName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_${desired}`
  if (!existing.has(prefixed)) return prefixed
  // Last resort: add numeric suffix
  let n = 2
  while (existing.has(`${desired}_${n}`)) n++
  return `${desired}_${n}`
}

export function detectSecrets(server: DiscoveredMcpServer): TemplatizedConfig {
  const config = server.config
  const usedNames = new Set<string>()
  const templateFields: TemplateFields = {}
  const secretValues: Record<string, string> = {}

  if ('command' in config && config.command) {
    // ── Stdio server ─────────────────────────────────────────────────────────
    const clonedArgs = config.args ? [...config.args] : undefined
    const clonedEnv = config.env ? { ...config.env } : undefined

    // 1. Scan args
    if (clonedArgs && clonedArgs.length > 0) {
      const argsFields: Record<string, TemplateFieldInfo> = {}
      const pairs = parseFlagValuePairs(clonedArgs)

      for (const pair of pairs) {
        // Skip flags whose values are never secrets (e.g. -y for npx, --port, etc.)
        if (isNonSecretFlag(pair.flag)) continue

        const flagIsSensitive = isSensitiveKeyName(pair.flag)

        // Check for embedded auth tokens (e.g. "Authorization: Bearer xxx")
        const authToken = extractAuthToken(pair.value)
        if (authToken) {
          const varName = ensureUniqueVarName(flagToVarName(pair.flag) + '_TOKEN', usedNames, server.name)
          usedNames.add(varName)
          argsFields[varName] = {
            description: descriptionFor('arg', varName),
            example: ''
          }
          secretValues[varName] = authToken.token
          const replaced = `${authToken.prefix}{${varName}}`
          if (pair.nextArg) {
            clonedArgs[pair.index + 1] = replaced
          } else {
            clonedArgs[pair.index] = `${pair.flag}=${replaced}`
          }
          continue
        }

        const valueIsSecret = isSecretValue(pair.value)
        if (flagIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(flagToVarName(pair.flag), usedNames, server.name)
          usedNames.add(varName)

          argsFields[varName] = {
            description: descriptionFor('arg', varName),
            example: ''
          }
          secretValues[varName] = pair.value

          // Replace in cloned args
          if (pair.nextArg) {
            clonedArgs[pair.index + 1] = `{${varName}}`
          } else {
            clonedArgs[pair.index] = `${pair.flag}={${varName}}`
          }
        }
      }

      // Also scan standalone args (not flag-value pairs) for secret values
      const pairIndices = new Set<number>()
      for (const p of pairs) {
        pairIndices.add(p.index)
        if (p.nextArg) pairIndices.add(p.index + 1)
      }
      for (let i = 0; i < clonedArgs.length; i++) {
        if (pairIndices.has(i)) continue
        const arg = clonedArgs[i]
        if (arg.startsWith('-') || arg.startsWith('{')) continue

        // Check for embedded auth tokens in standalone args
        const authToken = extractAuthToken(arg)
        if (authToken) {
          const varName = ensureUniqueVarName(
            `${server.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_TOKEN`,
            usedNames,
            server.name
          )
          usedNames.add(varName)
          argsFields[varName] = {
            description: descriptionFor('arg', varName),
            example: ''
          }
          secretValues[varName] = authToken.token
          clonedArgs[i] = `${authToken.prefix}{${varName}}`
          continue
        }

        if (isSecretValue(arg)) {
          const varName = ensureUniqueVarName(
            `${server.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_SECRET`,
            usedNames,
            server.name
          )
          usedNames.add(varName)
          argsFields[varName] = {
            description: descriptionFor('arg', varName),
            example: ''
          }
          secretValues[varName] = arg
          clonedArgs[i] = `{${varName}}`
        }
      }

      if (Object.keys(argsFields).length > 0) {
        templateFields.args = argsFields
      }
    }

    // 2. Scan env vars
    if (clonedEnv) {
      const envFields: Record<string, TemplateFieldInfo> = {}

      for (const [key, value] of Object.entries(clonedEnv)) {
        const keyIsSensitive = isSensitiveKeyName(key)

        // Check for embedded auth tokens
        const authToken = extractAuthToken(value)
        if (authToken) {
          const varName = ensureUniqueVarName(key + '_TOKEN', usedNames, server.name)
          usedNames.add(varName)
          envFields[varName] = {
            description: descriptionFor('env', key),
            example: ''
          }
          secretValues[varName] = authToken.token
          clonedEnv[key] = `${authToken.prefix}{${varName}}`
          continue
        }

        const valueIsSecret = isSecretValue(value)
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(key, usedNames, server.name)
          usedNames.add(varName)

          envFields[varName] = {
            description: descriptionFor('env', key),
            example: ''
          }
          secretValues[varName] = value
          clonedEnv[key] = `{${varName}}`
        }
      }

      if (Object.keys(envFields).length > 0) {
        templateFields.env = envFields
      }
    }

    const clonedConfig: McpServerConfig = {
      command: config.command,
      ...(clonedArgs && { args: clonedArgs }),
      ...(clonedEnv && { env: clonedEnv }),
      ...(config.envFile && { envFile: config.envFile })
    }

    return { config: clonedConfig, templateFields, secretValues }
  } else if ('url' in config && config.url) {
    // ── HTTP/SSE server ──────────────────────────────────────────────────────
    let clonedUrl = config.url
    const clonedHeaders = config.headers ? { ...config.headers } : undefined

    // 1. Scan URL for embedded credentials (user:pass@host)
    try {
      const parsed = new URL(clonedUrl)
      if (parsed.username || parsed.password) {
        if (parsed.password) {
          const varName = ensureUniqueVarName('URL_PASSWORD', usedNames, server.name)
          usedNames.add(varName)
          secretValues[varName] = parsed.password
          if (!templateFields.env) templateFields.env = {}
          templateFields.env[varName] = {
            description: descriptionFor('url', varName),
            example: ''
          }
          parsed.password = `{${varName}}`
        }
        if (parsed.username) {
          const varName = ensureUniqueVarName('URL_USERNAME', usedNames, server.name)
          usedNames.add(varName)
          secretValues[varName] = parsed.username
          if (!templateFields.env) templateFields.env = {}
          templateFields.env[varName] = {
            description: descriptionFor('url', varName),
            example: ''
          }
          parsed.username = `{${varName}}`
        }
        clonedUrl = parsed.toString()
      }

      // Scan query parameters for secrets (e.g. ?apiKey=xxx, ?token=xxx)
      for (const [key, value] of [...parsed.searchParams.entries()]) {
        const keyIsSensitive = isSensitiveKeyName(key)
        const valueIsSecret = isSecretValue(value)
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(
            key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase(),
            usedNames,
            server.name
          )
          usedNames.add(varName)
          secretValues[varName] = value
          if (!templateFields.env) templateFields.env = {}
          templateFields.env[varName] = {
            description: descriptionFor('url', varName),
            example: ''
          }
          // Replace directly in URL string to avoid URLSearchParams encoding the braces
          clonedUrl = clonedUrl.replace(
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
            `${encodeURIComponent(key)}={${varName}}`
          )
          // Also handle the case where the value wasn't encoded in the original URL
          clonedUrl = clonedUrl.replace(
            `${key}=${value}`,
            `${key}={${varName}}`
          )
        }
      }
    } catch {
      // Not a valid URL - skip URL credential extraction
    }

    // 2. Scan headers
    if (clonedHeaders) {
      const envFields: Record<string, TemplateFieldInfo> = templateFields.env ?? {}

      for (const [key, value] of Object.entries(clonedHeaders)) {
        const keyIsSensitive = isSensitiveKeyName(key)

        // Check for embedded auth tokens (e.g. "Bearer xxx")
        const authToken = extractAuthToken(value)
        if (authToken) {
          const varName = ensureUniqueVarName(
            `${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_TOKEN`,
            usedNames,
            server.name
          )
          usedNames.add(varName)
          envFields[varName] = {
            description: descriptionFor('header', key),
            example: ''
          }
          secretValues[varName] = authToken.token
          clonedHeaders[key] = `${authToken.prefix}{${varName}}`
          continue
        }

        const valueIsSecret = isSecretValue(value)
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(
            `${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_HEADER`,
            usedNames,
            server.name
          )
          usedNames.add(varName)
          envFields[varName] = {
            description: descriptionFor('header', key),
            example: ''
          }
          secretValues[varName] = value
          clonedHeaders[key] = `{${varName}}`
        }
      }

      if (Object.keys(envFields).length > 0) {
        templateFields.env = envFields
      }
    }

    const clonedConfig: McpServerConfig = config.type
      ? { type: config.type, url: clonedUrl, ...(clonedHeaders && { headers: clonedHeaders }) }
      : { url: clonedUrl, ...(clonedHeaders && { headers: clonedHeaders }) }

    return { config: clonedConfig, templateFields, secretValues }
  }

  // Fallback: no secrets detected, return as-is
  return { config: { ...config }, templateFields: {}, secretValues: {} }
}
