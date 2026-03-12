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
  antigravity: "Antigravity",
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
  onComplete,
  onRestart,
}: FinishStepProps): React.ReactNode {
  const [completing, setCompleting] = useState(false);
  const [showConfigDetails, setShowConfigDetails] = useState(false);
  const [revertingAll, setRevertingAll] = useState(false);
  // Track which individual configs have been reverted (by configPath)
  const [revertedPaths, setRevertedPaths] = useState<Set<string>>(new Set());
  const [revertingPaths, setRevertingPaths] = useState<Set<string>>(new Set());

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
        modifiedConfigs,
      });
      onComplete();
    } catch {
      // Completion failed — window close is handled by main process
    } finally {
      setCompleting(false);
    }
  };

  const handleUndoOne = async (configPath: string, backupPath: string) => {
    if (revertingPaths.has(configPath) || revertedPaths.has(configPath)) return;
    setRevertingPaths((prev) => new Set(prev).add(configPath));
    try {
      const result = await window.api.mcp.revertAppIntegrations({
        configs: [{ configPath, backupPath }],
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
          backupPath: c.backupPath,
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
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)]/10 text-xl">
          &#10003;
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
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Account</span>
            <span className="text-sm text-[var(--text-primary)]">{email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">Server</span>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-primary)] truncate max-w-[180px]">
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
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)]">API Key</span>
            <span className="text-sm font-mono text-[var(--text-secondary)]">
              {apiKey.length >= 12 ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : apiKey}
            </span>
          </div>
        </div>
      </Card>

      {/* Modified configs summary with per-client undo */}
      {modifiedConfigs.length > 0 && (
        <Card>
          <p className="text-xs text-[var(--text-muted)] mb-2">
            Configuration changes applied:
          </p>
          <div className="flex flex-col gap-2">
            {modifiedConfigs.map((entry) => {
              const reverted = revertedPaths.has(entry.configPath);
              const reverting = revertingPaths.has(entry.configPath);
              return (
                <div key={entry.configPath} className="flex items-center gap-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className={`text-[var(--text-primary)] shrink-0 ${reverted ? "line-through opacity-50" : ""}`}>
                      {APP_ID_TO_NAME[entry.appId] ?? entry.appId}
                    </span>
                    {reverted && (
                      <span className="ml-2 text-xs text-[var(--text-muted)]">reverted</span>
                    )}
                  </div>
                  {!reverted && entry.backupPath && (
                    <button
                      type="button"
                      disabled={reverting}
                      onClick={() => handleUndoOne(entry.configPath, entry.backupPath)}
                      className="shrink-0 text-xs text-[var(--danger)]/70 hover:text-[var(--danger)] transition-colors disabled:opacity-50"
                    >
                      {reverting ? "Undoing…" : "Undo"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-[var(--accent-muted)] hover:text-[var(--accent)]"
            onClick={() => setShowConfigDetails((v) => !v)}
          >
            {showConfigDetails ? "Hide details" : "Show details"}
          </button>
          {showConfigDetails && (
            <div className="mt-2 flex flex-col gap-2">
              {modifiedConfigs.map((entry) => (
                <div key={entry.configPath} className="text-xs">
                  <strong className="text-[var(--text-primary)]">
                    {APP_ID_TO_NAME[entry.appId] ?? entry.appId}
                  </strong>
                  <div className="text-[var(--text-muted)]">
                    Config: <code className="select-text cursor-text">{entry.configPath}</code>
                  </div>
                  {entry.backupPath && (
                    <div className="text-[var(--text-muted)]">
                      Backup: <code className="select-text cursor-text">{entry.backupPath}</code>
                    </div>
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
