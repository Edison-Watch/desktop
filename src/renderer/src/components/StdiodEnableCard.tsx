import { useEffect, useState } from 'react'

import { Badge, Card } from '@edison/shared/ui'

import type { StdiodErrorCode, StdiodStatus } from '../../../main/stdiod/types'

interface StdiodEnableCardProps {
  apiBaseUrl: string
  apiKey: string
  edisonSecretKey?: string
}

// Pick a human-meaningful status line. We deliberately don't surface a
// generic "Connected" pill: by itself it doesn't tell the user whether
// any tunneled servers are running, which is the question they actually
// want answered.
function describeStatus(status: StdiodStatus): string {
  if (!status.binaryAvailable) return 'Daemon binary is missing from this build.'
  if (!status.installed)
    return 'Off. Toggle on to install the daemon and start tunneling local stdio MCP servers.'
  const conn = status.state?.connection_state
  if (conn === 'needs_reauth') return 'Signed out - toggle off then on to refresh credentials.'
  if (conn === 'needs_upgrade') return 'Daemon needs to be updated to talk to the current backend.'
  if (conn === 'reconnecting') {
    // The backend can push a friendly message via a device-wide tunnel_error
    // frame (e.g. "Stdio servers are not enabled for your organisation.").
    // The daemon persists that text into state.last_error, so prefer it over
    // the generic reconnect line whenever it's present.
    const friendly = status.state?.last_error?.trim()
    if (friendly) return friendly
    return 'Reconnecting to the backend…'
  }
  if (conn === 'starting' || conn === undefined) return 'Starting the daemon…'
  // conn === 'connected'
  const servers = status.state?.servers ?? []
  if (servers.length === 0) return 'Connected. No tunneled servers configured for this device yet.'
  const running = servers.filter((s) => s.state === 'running').length
  if (running === servers.length) {
    return `Connected. Tunneling ${running}/${servers.length} ${
      servers.length === 1 ? 'server' : 'servers'
    }.`
  }
  return `Connected. ${running}/${servers.length} servers running (${
    servers.length - running
  } starting or crashed).`
}

const ERROR_HINTS: Record<StdiodErrorCode, string> = {
  binary_missing: 'The stdiod binary is not bundled with this build.',
  not_installed: 'The launchd unit is not registered yet.',
  not_logged_in: 'Daemon needs an API key + edison_secret_key.',
  permission_denied: 'macOS denied the install action.',
  spawn_failed: 'Could not start the daemon binary.',
  unknown: 'See the daemon log for details.'
}

export default function StdiodEnableCard({
  apiBaseUrl,
  apiKey,
  edisonSecretKey
}: StdiodEnableCardProps): React.ReactNode {
  const [status, setStatus] = useState<StdiodStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // True while a reset is in flight, including one started from the tray
  // menu (signalled via stdiod.onResetting). Kept separate from `busy` so
  // the card can show "Resetting…" even when this window didn't start it.
  const [resetting, setResetting] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      try {
        const s = await window.api.stdiod.status()
        if (mounted) setStatus(s)
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err))
      }
    }
    refresh()
    // Mild polling so the row reflects the daemon's progress after
    // Enable is clicked (state.json may take a few seconds to appear).
    const handle = setInterval(refresh, 3000)
    // Live signals from the main process so a tray-initiated reset is
    // visible here immediately instead of being missed by the 3s poll.
    const offResetting = window.api.stdiod.onResetting(() => {
      if (!mounted) return
      setResetting(true)
      setError(null)
    })
    const offChanged = window.api.stdiod.onChanged(() => {
      if (!mounted) return
      setResetting(false)
      void refresh()
    })
    return () => {
      mounted = false
      clearInterval(handle)
      offResetting()
      offChanged()
    }
  }, [])

  const handleEnable = async () => {
    setBusy(true)
    setError(null)
    try {
      const loginResult = await window.api.stdiod.login({
        backend: apiBaseUrl,
        apiKey,
        edisonSecretKey
      })
      if (!loginResult.ok) {
        const code = loginResult.errorCode ?? 'unknown'
        setError(
          loginResult.errorMessage
            ? `${ERROR_HINTS[code]} ${loginResult.errorMessage}`
            : ERROR_HINTS[code]
        )
        return
      }
      const installResult = await window.api.stdiod.install()
      if (!installResult.ok) {
        const code = installResult.errorCode ?? 'unknown'
        setError(
          installResult.errorMessage
            ? `${ERROR_HINTS[code]} ${installResult.errorMessage}`
            : ERROR_HINTS[code]
        )
        return
      }
      // Refresh once eagerly so the user sees the transition without
      // waiting for the next poll tick.
      const fresh = await window.api.stdiod.status()
      setStatus(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDisable = async () => {
    setBusy(true)
    setError(null)
    try {
      // purge=false keeps ~/.config/edison-stdiod/config.toml around so a
      // future Enable doesn't have to re-ask for credentials.
      const result = await window.api.stdiod.uninstall({ purge: false })
      if (!result.ok) {
        const code = result.errorCode ?? 'unknown'
        setError(
          result.errorMessage ? `${ERROR_HINTS[code]} ${result.errorMessage}` : ERROR_HINTS[code]
        )
        return
      }
      const fresh = await window.api.stdiod.status()
      setStatus(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleReset = async () => {
    setConfirmingReset(false)
    setBusy(true)
    setResetting(true)
    setError(null)
    try {
      // Full teardown (purge) + re-login + reinstall, orchestrated in the
      // main process. Same path the tray "Reset Local Tunnel" action uses.
      const result = await window.api.stdiod.reset({
        backend: apiBaseUrl,
        apiKey,
        edisonSecretKey
      })
      if (!result.ok) {
        const code = result.errorCode ?? 'unknown'
        setError(
          result.errorMessage ? `${ERROR_HINTS[code]} ${result.errorMessage}` : ERROR_HINTS[code]
        )
      }
      const fresh = await window.api.stdiod.status()
      setStatus(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setResetting(false)
    }
  }

  if (status === null) {
    // First render before the initial fetch lands. Avoid flashing a
    // misleading "Not enabled" state on machines that *are* set up.
    return null
  }

  // The launchd unit being loaded is the authoritative "is it on" signal.
  // config.toml (loggedIn) is sticky across Disable so we can re-enable
  // in one click; it isn't a good signal for the toggle.
  const enabled = status.installed
  // While a reset is in flight (from here or the tray) lock the controls and
  // show a spinner, even though `busy` is only set for actions this window
  // started.
  const controlsDisabled = busy || resetting || !status.binaryAvailable
  const spinning = busy || resetting
  // Reset only makes sense when there's something to reset.
  const canReset = status.binaryAvailable && (enabled || status.loggedIn)
  const handleToggle = (nextChecked: boolean): void => {
    if (nextChecked) {
      void handleEnable()
    } else {
      void handleDisable()
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-[var(--text-primary)]">Local stdio tunnel</p>
              <Badge variant="neutral" size="sm">
                Optional
              </Badge>
            </div>
            <p className="text-xs text-[var(--text-primary)]/80">
              Run local stdio MCP servers (filesystem, git, sqlite, etc.) through Edison Watch.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={controlsDisabled}
            onClick={() => handleToggle(!enabled)}
            className={`relative inline-flex h-7 w-16 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              controlsDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            } ${
              enabled
                ? 'bg-[var(--accent)] border-[var(--accent)]'
                : 'bg-[var(--bg-base)] border-[var(--border)]'
            }`}
          >
            {/* "Off" label, dimmed when the toggle is on. */}
            <span
              className={`absolute right-2 text-[9px] font-semibold uppercase tracking-wider transition-opacity ${
                enabled ? 'opacity-0' : 'text-[var(--text-primary)] opacity-100'
              }`}
            >
              Off
            </span>
            {/* "On" label, dimmed when the toggle is off. */}
            <span
              className={`absolute left-2 text-[9px] font-semibold uppercase tracking-wider transition-opacity ${
                enabled ? 'text-[var(--bg-base)] opacity-100' : 'opacity-0'
              }`}
            >
              On
            </span>
            {/* Sliding thumb: 36px of travel across the 64px track keeps the
                slide unmistakable while staying compact. */}
            <span
              className={`pointer-events-none absolute top-[3px] inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white shadow transition-transform duration-200 ${
                enabled ? 'translate-x-[37px]' : 'translate-x-[3px]'
              }`}
            >
              {spinning && (
                <svg className="h-3 w-3 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="opacity-25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    className="opacity-75"
                  />
                </svg>
              )}
            </span>
          </button>
        </div>

        <p className="text-xs font-medium text-[var(--text-primary)]">
          {resetting ? 'Resetting the local tunnel…' : describeStatus(status)}
        </p>

        {enabled && status.state?.device_id && (
          <p className="text-xs text-[var(--text-primary)]/80">
            Device:{' '}
            <code className="select-text cursor-text text-[var(--text-primary)]">
              {status.state.device_id}
            </code>
          </p>
        )}

        {canReset &&
          (confirmingReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-primary)]/80">
                Reset the tunnel? This rebuilds the daemon from scratch.
              </span>
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() => void handleReset()}
                className="text-xs font-semibold text-[var(--danger)] hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setConfirmingReset(false)}
                className="text-xs text-[var(--text-primary)]/70 hover:underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setConfirmingReset(true)}
              className="self-start text-xs font-medium text-[var(--text-primary)]/70 hover:text-[var(--text-primary)] hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Reset tunnel
            </button>
          ))}

        {error && (
          <p className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 rounded px-2 py-1.5">
            {error}
          </p>
        )}
      </div>
    </Card>
  )
}
