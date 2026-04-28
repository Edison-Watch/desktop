import { useState, useEffect, useCallback } from 'react'
import { Badge } from '@edison/shared/ui'
import ServerIcon from './ServerIcon'

// Mirrors fields from ServerSummary in src/api/v1/schemas/servers.py.
// Duplicated here because the renderer doesn't consume the webapp's
// generated OpenAPI types and doesn't need the full ServerDetail shape.
interface ServerSummary {
  id: number
  name: string
  display_name: string
  enabled: boolean
  tool_count: number
  needs_config: boolean
  is_builtin: boolean
  user_enabled: boolean | null
  config_warnings: string[]
  icon_url: string | null
}

type ServerStatus = 'active' | 'unverified' | 'needs-config' | 'user-disabled' | 'disabled'

function isUnverified(s: ServerSummary): boolean {
  return s.enabled && s.user_enabled !== false && !s.needs_config && !s.is_builtin && s.tool_count === 0
}

function getServerStatus(s: ServerSummary): ServerStatus {
  if (!s.enabled && s.user_enabled === false) return 'user-disabled'
  if (!s.enabled) return 'disabled'
  if (s.needs_config) return 'needs-config'
  if (isUnverified(s)) return 'unverified'
  return 'active'
}

// Sort priority: active first (the green, working servers the user cares
// about), then unverified and needs-config amber states, then user-disabled,
// then admin-disabled last.
const STATUS_ORDER: Record<ServerStatus, number> = {
  active: 0,
  unverified: 1,
  'needs-config': 2,
  'user-disabled': 3,
  disabled: 4
}

function StatusDot({ status }: { status: ServerStatus }): React.ReactNode {
  const colors: Record<ServerStatus, string> = {
    active: 'bg-emerald-400',
    unverified: 'bg-amber-400',
    'needs-config': 'bg-amber-400',
    'user-disabled': 'bg-gray-500',
    disabled: 'bg-gray-500'
  }
  return (
    <span className="relative flex h-2 w-2">
      {status === 'active' && (
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colors[status]}`} />
    </span>
  )
}

const STATUS_LABEL: Record<ServerStatus, string> = {
  active: 'Active',
  unverified: 'Unverified',
  'needs-config': 'Needs Config',
  'user-disabled': 'Disabled by You',
  disabled: 'Disabled'
}

const STATUS_VARIANT: Record<ServerStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  unverified: 'warning',
  'needs-config': 'warning',
  'user-disabled': 'neutral',
  disabled: 'neutral'
}

const STATUS_BORDER: Record<ServerStatus, string> = {
  active: 'border-emerald-500/20 bg-emerald-500/5',
  unverified: 'border-amber-500/15 bg-amber-500/5',
  'needs-config': 'border-amber-500/15 bg-amber-500/5',
  'user-disabled': 'border-[var(--border)] bg-[var(--bg-raised)] opacity-70',
  disabled: 'border-[var(--border)] bg-[var(--bg-raised)] opacity-60'
}

interface SetupData {
  apiBaseUrl?: string
  apiKey?: string
}

async function fetchServers(
  apiBaseUrl: string,
  apiKey: string,
  signal: AbortSignal
): Promise<ServerSummary[]> {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/servers?per_page=100`
  const res = await fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { items?: ServerSummary[] }
  return data.items ?? []
}

export default function MyMcpsView(): React.ReactNode {
  const [servers, setServers] = useState<ServerSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dashboardUrl, setDashboardUrl] = useState<string>('')

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const setup = (await window.api.setup.getData()) as SetupData
      const urls = await window.api.config.getEffectiveBaseUrls()
      const apiBaseUrl = urls.apiBaseUrl ?? setup.apiBaseUrl ?? ''
      const apiKey = setup.apiKey ?? ''
      if (!apiBaseUrl || !apiKey) {
        setError('Missing API credentials. Please re-run setup.')
        setServers([])
        return
      }
      setDashboardUrl(apiBaseUrl)
      const items = await fetchServers(apiBaseUrl, apiKey, signal)
      setServers(items)
      setError(null)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError('Failed to load your MCP servers.')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const interval = setInterval(() => {
      void refresh(controller.signal)
    }, 30000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [refresh])

  const handleOpenDashboard = async (): Promise<void> => {
    let url = dashboardUrl
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    const target = `${url.replace(/\/$/, '')}/dashboard/my-mcps`
    await window.api.shell.openExternal(target)
  }

  if (servers === null && !error) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    )
  }

  if (error && (servers === null || servers.length === 0)) {
    return <p className="text-center text-xs text-[var(--danger)] py-4">{error}</p>
  }

  const list = (servers ?? []).slice().sort((a, b) => {
    const statusA = getServerStatus(a)
    const statusB = getServerStatus(b)
    const d = STATUS_ORDER[statusA] - STATUS_ORDER[statusB]
    if (d !== 0) return d
    // Within the active group, rank by element count desc so the
    // most-capable servers surface first.
    if (statusA === 'active') {
      const byCount = b.tool_count - a.tool_count
      if (byCount !== 0) return byCount
    }
    return a.display_name.localeCompare(b.display_name)
  })

  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
        <p className="text-center text-xs text-[var(--text-muted)] py-6">
          No MCP servers registered for your account yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((s) => {
            const status = getServerStatus(s)
            const warning =
              status === 'needs-config' ? (s.config_warnings?.[0] ?? 'Needs Config') : null
            return (
              <div
                key={s.id}
                className={`group relative flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${STATUS_BORDER[status]}`}
              >
                <ServerIcon
                  name={s.name}
                  iconUrl={s.icon_url}
                  isBuiltin={s.is_builtin}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                      {s.display_name}
                    </span>
                    {s.is_builtin && (
                      <Badge variant="info" size="sm">
                        built-in
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                    <span>
                      {s.tool_count} {s.tool_count === 1 ? 'element' : 'elements'}
                    </span>
                    {warning && (
                      <span
                        className="truncate text-amber-400/80"
                        title={s.config_warnings?.join('\n')}
                      >
                        {warning}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusDot status={status} />
                  <Badge variant={STATUS_VARIANT[status]} size="sm">
                    {STATUS_LABEL[status]}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {dashboardUrl && (
        <button
          type="button"
          onClick={handleOpenDashboard}
          className="mt-1 self-center text-[11px] font-medium text-[var(--accent)] hover:text-[var(--accent-muted)] transition-colors"
        >
          Manage in dashboard →
        </button>
      )}
    </div>
  )
}
