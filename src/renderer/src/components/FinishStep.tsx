import { useState } from "react";
import { Button, Card, Badge } from "@edison/shared/ui";

const APP_ID_TO_NAME: Record<string, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  windsurf: "Windsurf",
  zed: "Zed",
  intellij: "IntelliJ IDEA",
  pycharm: "PyCharm",
  webstorm: "WebStorm",
};

interface FinishStepProps {
  email: string;
  userId: string;
  apiKey: string;
  mcpBaseUrl: string;
  apiBaseUrl: string;
  serverStatus: "checking" | "online" | "offline";
  modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }>;
  edisonSecretKey?: string;
  selectedApps: string[];
  onComplete: () => void;
  onRestart: () => void;
}

export default function FinishStep({
  email,
  userId,
  apiKey,
  mcpBaseUrl,
  apiBaseUrl,
  serverStatus,
  modifiedConfigs,
  edisonSecretKey,
  selectedApps,
  onComplete,
  onRestart,
}: FinishStepProps): React.ReactNode {
  const [completing, setCompleting] = useState(false);
  const [showConfigDetails, setShowConfigDetails] = useState(false);
  const [revertingAll, setRevertingAll] = useState(false);
  // Track which individual configs have been reverted (by configPath)
  const [revertedPaths, setRevertedPaths] = useState<Set<string>>(new Set());
  const [revertingPaths, setRevertingPaths] = useState<Set<string>>(new Set());
  const [redoingPaths, setRedoingPaths] = useState<Set<string>>(new Set());
  // Updated backup paths after redo (re-apply creates a new backup)
  const [updatedBackupPaths, setUpdatedBackupPaths] = useState<Map<string, string>>(new Map());

  const handleOpenDashboard = async () => {
    let dashUrl = apiBaseUrl.replace(/\/$/, "");
    if (dashUrl && !/^https?:\/\//i.test(dashUrl)) {
      dashUrl = `https://${dashUrl}`;
    }
    if (!dashUrl) return;
    await window.api.shell.openExternal(dashUrl);
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await window.api.setup.complete({
        userEmail: email,
        userId,
        apiKey,
        mcpBaseUrl,
        apiBaseUrl,
        edisonSecretKey: edisonSecretKey || undefined,
        configuredApps: selectedApps,
      });
      onComplete();
    } catch {
      // Completion failed — window close is handled by main process
    } finally {
      setCompleting(false);
    }
  };

  const handleUndoOne = async (configPath: string, backupPath: string, appId?: string) => {
    if (revertingPaths.has(configPath) || revertedPaths.has(configPath)) return;
    setRevertingPaths((prev) => new Set(prev).add(configPath));
    try {
      const result = await window.api.mcp.revertAppIntegrations({
        configs: [{ configPath, backupPath, appId }],
      });
      if (result.reverted > 0) {
        setRevertedPaths((prev) => new Set(prev).add(configPath));
      }
      if (result.errors?.length) {
        console.warn("Revert errors:", result.errors);
      }
    } catch {
      // Revert failed
    } finally {
      setRevertingPaths((prev) => {
        const next = new Set(prev);
        next.delete(configPath);
        return next;
      });
    }
  };

  const handleRedoOne = async (appId: string, configPath: string) => {
    if (redoingPaths.has(configPath)) return;
    setRedoingPaths((prev) => new Set(prev).add(configPath));
    try {
      const result = await window.api.mcp.applyAppIntegrations({
        serverAddress: mcpBaseUrl,
        mcpBaseUrl,
        apiKey,
        edisonSecretKey: edisonSecretKey || undefined,
        apps: [appId],
      });
      if (result.success && result.modifiedConfigs.length > 0) {
        const newBackupPath = result.modifiedConfigs[0].backupPath;
        setRevertedPaths((prev) => {
          const next = new Set(prev);
          next.delete(configPath);
          return next;
        });
        setUpdatedBackupPaths((prev) => {
          const next = new Map(prev);
          if (newBackupPath) next.set(configPath, newBackupPath);
          else next.delete(configPath); // clear stale path so original backupPath is used
          return next;
        });
      }
    } catch (err) {
      console.warn("Redo failed:", err);
    } finally {
      setRedoingPaths((prev) => {
        const next = new Set(prev);
        next.delete(configPath);
        return next;
      });
    }
  };

  const handleUndoAll = async () => {
    const remaining = modifiedConfigs.filter(
      (c) => !revertedPaths.has(c.configPath) && !revertingPaths.has(c.configPath),
    );
    if (revertingAll || remaining.length === 0) return;
    setRevertingAll(true);
    try {
      const result = await window.api.mcp.revertAppIntegrations({
        configs: remaining.map((c) => ({
          configPath: c.configPath,
          backupPath: updatedBackupPaths.get(c.configPath) ?? c.backupPath,
          appId: c.appId,
        })),
      });
      if (result.errors?.length) {
        console.warn("Revert errors:", result.errors);
      }
      if (result.reverted > 0) {
        onRestart();
      }
    } catch {
      // Revert failed
    } finally {
      setRevertingAll(false);
    }
  };

  const activeConfigs = modifiedConfigs.filter((c) => !revertedPaths.has(c.configPath));

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10 text-[var(--accent)]">
          <svg viewBox="0 0 16 16" fill="none" className="h-5 w-5" aria-hidden="true">
            <path d="M3 8l3.5 3.5 6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Setup Complete
        </h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Edison Watch is ready to protect your MCP connections.
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--text-muted)] shrink-0">Account</span>
            <span className="text-xs text-[var(--text-primary)] truncate">{email}</span>
          </div>
          <div className="h-px bg-[var(--border)]/50" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--text-muted)] shrink-0">Server</span>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-[var(--text-primary)] truncate font-mono">
                {mcpBaseUrl}
              </span>
              <Badge
                variant={serverStatus === "online" ? "success" : serverStatus === "checking" ? "warning" : "danger"}
                size="sm"
              >
                {serverStatus}
              </Badge>
            </div>
          </div>
          <div className="h-px bg-[var(--border)]/50" />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--text-muted)] shrink-0">API Key</span>
            <span className="text-xs font-mono text-[var(--text-secondary)]">
              {apiKey.length >= 12 ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : apiKey}
            </span>
          </div>
        </div>
      </Card>

      {/* Modified configs summary with per-client undo */}
      {modifiedConfigs.length > 0 && (
        <Card>
          <p className="text-xs font-medium text-[var(--text-muted)] mb-3">
            Configuration changes applied
          </p>
          <div className="flex flex-col gap-1.5">
            {modifiedConfigs.map((entry) => {
              const reverted = revertedPaths.has(entry.configPath);
              const reverting = revertingPaths.has(entry.configPath);
              const redoing = redoingPaths.has(entry.configPath);
              const currentBackupPath = updatedBackupPaths.get(entry.configPath) ?? entry.backupPath;
              return (
                <div key={entry.configPath} className="flex items-center justify-between gap-3 py-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${reverted ? "bg-[var(--text-muted)]" : "bg-[var(--accent)]"}`} />
                    <span className={`text-sm text-[var(--text-primary)] ${reverted ? "line-through opacity-50" : ""}`}>
                      {APP_ID_TO_NAME[entry.appId] ?? entry.appId}
                    </span>
                    {reverted && (
                      <span className="text-[11px] text-[var(--text-muted)]">reverted</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {reverted && (
                      <button
                        type="button"
                        disabled={redoing}
                        onClick={() => handleRedoOne(entry.appId, entry.configPath)}
                        className="text-xs text-[var(--accent)]/70 hover:text-[var(--accent)] transition-colors disabled:opacity-50"
                      >
                        {redoing ? "Redoing…" : "Redo"}
                      </button>
                    )}
                    {!reverted && (currentBackupPath || entry.appId === "claude-code") && (
                      <button
                        type="button"
                        disabled={reverting}
                        onClick={() => handleUndoOne(entry.configPath, currentBackupPath, entry.appId)}
                        className="text-xs text-[var(--danger)]/70 hover:text-[var(--danger)] transition-colors disabled:opacity-50"
                      >
                        {reverting ? "Undoing…" : "Undo"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-3 text-xs text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors"
            onClick={() => setShowConfigDetails((v) => !v)}
          >
            {showConfigDetails ? "Hide details" : "Show details"}
          </button>
          {showConfigDetails && (
            <div className="mt-3 flex flex-col gap-3 pt-3 border-t border-[var(--border)]/50">
              {modifiedConfigs.map((entry) => (
                <div key={entry.configPath} className="text-xs space-y-0.5">
                  <p className="font-medium text-[var(--text-primary)]">
                    {APP_ID_TO_NAME[entry.appId] ?? entry.appId}
                  </p>
                  <p className="text-[var(--text-muted)]">
                    Config: <code className="select-text cursor-text text-[var(--text-secondary)]">{entry.configPath}</code>
                  </p>
                  {entry.backupPath && (
                    <p className="text-[var(--text-muted)]">
                      Backup: <code className="select-text cursor-text text-[var(--text-secondary)]">{entry.backupPath}</code>
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-2">
        {/* Primary action: finish setup (close window) */}
        <Button
          variant="primary"
          onClick={handleComplete}
          loading={completing}
          className="w-full"
        >
          Finish Setup
        </Button>
        {/* Secondary: open dashboard in browser */}
        <Button
          variant="ghost"
          onClick={handleOpenDashboard}
          className="w-full"
        >
          Open Dashboard
        </Button>
        {/* Undo all remaining configs */}
        {activeConfigs.length > 0 && (
          <Button
            variant="ghost"
            onClick={handleUndoAll}
            loading={revertingAll}
            className="w-full text-[var(--danger)]"
          >
            Undo All Configuration Changes
          </Button>
        )}
      </div>
    </div>
  );
}
