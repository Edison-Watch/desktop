import { useEffect, useState } from "react";

/** Mirror of the main-process UpdateState (see infra/updateManager.ts). */
interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version: string | null;
  percent: number | null;
  error: string | null;
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
}

/**
 * In-window banner surfacing a pending update. Shows for available/downloading/
 * downloaded states only; checking/idle/error are silent (the tray covers the
 * "check" action). Mirrors the tray flow: download on demand, then restart.
 */
export default function UpdateBanner(): React.ReactNode {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    window.api.updates.getState().then((s) => {
      if (mounted) setState(s as UpdateState);
    });
    const off = window.api.updates.onStatus((s) => setState(s as UpdateState));
    return () => {
      mounted = false;
      off();
    };
  }, []);

  if (!state) return null;
  const { status, version } = state;
  const show = status === "available" || status === "downloading" || status === "downloaded";
  if (!show) return null;
  if (status === "available" && version && version === dismissedVersion) return null;

  const handleDownload = async () => {
    setBusy(true);
    try {
      await window.api.updates.download();
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    setBusy(true);
    await window.api.updates.install();
  };

  return (
    <div className="flex items-center gap-3 border-b border-[var(--accent-dim)] bg-[var(--bg-overlay)] px-4 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">
        <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
          <path
            d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div className="min-w-0 flex-1">
        {status === "downloading" ? (
          <>
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Downloading update{version ? ` v${version}` : ""}…{" "}
              {state.percent != null ? `${state.percent}%` : ""}
            </p>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-input)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-all"
                style={{ width: `${state.percent ?? 0}%` }}
              />
            </div>
          </>
        ) : status === "downloaded" ? (
          <p className="text-xs font-medium text-[var(--text-primary)]">
            Update ready{version ? ` (v${version})` : ""} - restart to install
          </p>
        ) : (
          <>
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Update available{version ? `: v${version}` : ""}
            </p>
            {state.error && (
              <p className="text-[11px] text-[var(--danger)]">Download failed - try again</p>
            )}
          </>
        )}
      </div>

      {status === "downloaded" && (
        <button
          type="button"
          onClick={handleInstall}
          disabled={busy}
          className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--bg-base)] transition-all hover:brightness-110 disabled:opacity-50"
        >
          Restart to update
        </button>
      )}

      {status === "available" && (
        <>
          <button
            type="button"
            onClick={handleDownload}
            disabled={busy}
            className="shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--bg-base)] transition-all hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Starting…" : state.error ? "Retry" : "Download"}
          </button>
          <button
            type="button"
            onClick={() => setDismissedVersion(version)}
            className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            title="Dismiss"
          >
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
              <path
                d="M3 3l6 6M9 3l-6 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
