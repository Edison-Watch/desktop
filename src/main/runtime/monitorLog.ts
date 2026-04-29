import { appendFileSync } from 'fs'

const MONITOR_LOG = '/tmp/ew-monitor.log'

const RELEVANT_PREFIXES = [
  '[Monitor]',
  '[McpConfigMonitor]',
  '[Quarantine]',
  '[MCP Quarantine]',
  '[SeenStore]',
  '[getCursorPluginMcpPaths]',
  '[claude-cli]',
]

function shouldCapture(msg: string): boolean {
  for (const p of RELEVANT_PREFIXES) {
    if (msg.includes(p)) return true
  }
  return false
}

function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  try { return JSON.stringify(arg) } catch { return String(arg) }
}

function formatLine(level: string, args: unknown[]): string {
  const text = args.map(stringify).join(' ')
  const prefix = level === 'log' ? '' : ` [${level.toUpperCase()}]`
  return `[${new Date().toISOString()}]${prefix} ${text}\n`
}

let installed = false

/**
 * Patch console.log/warn/error/info so that any call whose first string arg
 * contains one of the relevant log prefixes is also appended to
 * /tmp/ew-monitor.log. Original console output is preserved.
 *
 * Idempotent - calling more than once is a no-op.
 */
export function installMonitorTee(): void {
  if (installed) return
  installed = true

  const levels = ['log', 'warn', 'error', 'info'] as const
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      try {
        const first = args[0]
        if (typeof first === 'string' && shouldCapture(first)) {
          appendFileSync(MONITOR_LOG, formatLine(level, args))
        }
      } catch {
        /* never break console */
      }
      original(...args)
    }
  }
}

/**
 * Format a `claude <args>` invocation for logging - quotes args containing
 * whitespace or quote chars so the line is roughly copy-pasteable.
 */
export function formatClaudeCmd(args: readonly string[]): string {
  const quoted = args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
  return `claude ${quoted.join(' ')}`
}

/**
 * Log a `claude` CLI invocation with full args (and cwd if provided) under the
 * `[claude-cli]` prefix so it lands in /tmp/ew-monitor.log via the console tee.
 */
export function logClaudeCmd(args: readonly string[], opts?: { cwd?: string }): void {
  const cwdSuffix = opts?.cwd ? ` (cwd=${opts.cwd})` : ''
  console.log(`[claude-cli] $ ${formatClaudeCmd(args)}${cwdSuffix}`)
}
