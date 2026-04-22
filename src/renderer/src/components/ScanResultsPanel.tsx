import { useState } from "react";

interface SubmitFailure {
  name: string;
  client: string;
  reason: "conflict" | "error";
  message: string;
  config?: Record<string, unknown>;
  configPath?: string;
}

export interface ScanResult {
  submitted: number;
  autoApproved: number;
  skipped: number;
  total: number;
  servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
  error?: string;
  errors?: string[];
  failures?: SubmitFailure[];
}

interface ScanResultsPanelProps {
  scanResult: ScanResult;
  apiBaseUrl: string;
  onResubmit: (originalName: string, newName: string) => void;
  resubmitting: string | null;
}

const NAME_PATTERN = /^[a-zA-Z0-9_]{1,32}$/;

export default function ScanResultsPanel({
  scanResult,
  apiBaseUrl,
  onResubmit,
  resubmitting,
}: ScanResultsPanelProps) {
  const [showServers, setShowServers] = useState(false);
  const [renameInputs, setRenameInputs] = useState<Record<string, string>>({});

  if (scanResult.error) {
    return (
      <div className="rounded-md bg-[var(--bg-input)] p-3 text-xs">
        <span className="text-[var(--danger)]">{scanResult.error}</span>
      </div>
    );
  }

  return (
    <div className="rounded-md bg-[var(--bg-input)] p-3 text-xs">
      <div className="flex flex-col gap-1">
        {scanResult.autoApproved > 0 && (
          <span className="text-green-400">
            {scanResult.autoApproved} server(s) auto-approved.
          </span>
        )}
        {scanResult.submitted > scanResult.autoApproved && (
          <span className="text-[var(--text-secondary)]">
            {scanResult.submitted - scanResult.autoApproved} server(s) pending approval.
          </span>
        )}
        {scanResult.submitted === 0 && scanResult.total === 0 && (
          <span className="text-[var(--text-muted)]">No MCP servers found to register.</span>
        )}
        {scanResult.submitted === 0 && scanResult.total > 0 && (
          <span className="text-[var(--text-muted)]">{scanResult.skipped} server(s) skipped.</span>
        )}

        {scanResult.servers && scanResult.servers.length > 0 && (
          <div className="mt-1">
            <button
              type="button"
              className="text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors"
              onClick={() => setShowServers((v) => !v)}
            >
              {showServers ? "Hide" : "Show"} {scanResult.servers.length} submitted server(s)
            </button>
            {showServers && (
              <div className="mt-2 flex flex-col gap-1 max-h-32 overflow-y-auto">
                {scanResult.servers.map((s) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className="text-[var(--text-primary)] font-medium truncate">{s.name}</span>
                    <span className="text-[var(--text-muted)] shrink-0">
                      {(s.clients && s.clients.length > 0 ? s.clients : [s.client]).join(", ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {scanResult.errors && scanResult.errors.length > 0 && (
          <div className="mt-1 text-[var(--danger)]">
            {scanResult.errors.slice(0, 3).map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        {scanResult.failures && scanResult.failures.length > 0 && (
          <div className="mt-2 pt-2 border-t border-[var(--border)]/50">
            <p className="text-xs font-medium text-red-400 mb-1.5">
              Failed to submit ({scanResult.failures.length})
            </p>
            <div className="flex flex-col gap-2">
              {scanResult.failures.map((f) => (
                <div key={f.name} className="rounded-md bg-red-500/5 border border-red-500/15 p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[var(--text-primary)] text-xs font-medium">{f.name}</span>
                    <span className="text-[var(--text-muted)] text-[10px]">{f.client}</span>
                  </div>
                  <p className="text-[10px] text-red-400/80 mt-0.5">
                    {f.reason === "conflict" ? "Conflict: " : "Error: "}{f.message}
                  </p>
                  {f.reason === "conflict" && (() => {
                    const val = renameInputs[f.name] ?? "";
                    const isValid = val.trim().length > 0 && NAME_PATTERN.test(val.trim());
                    const showError = val.length > 0 && !NAME_PATTERN.test(val.trim());
                    return (
                      <div className="mt-1.5 flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            maxLength={32}
                            placeholder="New name (a-z, 0-9, _)"
                            value={val}
                            onChange={(e) => {
                              const v = e.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                              setRenameInputs((prev) => ({ ...prev, [f.name]: v }));
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter" && isValid) onResubmit(f.name, val.trim()); }}
                            className={`flex-1 min-w-0 px-2 py-1 rounded text-[10px] bg-[var(--bg-input)] border text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none ${showError ? "border-red-500/50" : "border-[var(--border)] focus:border-[var(--accent-dim)]"}`}
                          />
                          <button
                            type="button"
                            disabled={!isValid || resubmitting === f.name}
                            className="shrink-0 text-[10px] px-2 py-1 rounded bg-[var(--accent-dim)] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-40"
                            onClick={() => onResubmit(f.name, val.trim())}
                          >
                            {resubmitting === f.name ? "Submitting..." : "Resubmit"}
                          </button>
                        </div>
                        {showError && (
                          <span className="text-[9px] text-red-400/70">Max 32 characters, letters, numbers and underscore only</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          </div>
        )}

        {scanResult.submitted > scanResult.autoApproved && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Your submitted servers are pending administrator approval.{" "}
            <button
              type="button"
              className="text-[var(--accent)] hover:underline"
              onClick={() => window.api.shell.openExternal(apiBaseUrl)}
            >
              Open the dashboard
            </button>
            {" "}to check status.
          </p>
        )}
      </div>
    </div>
  );
}
