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
  const [reverting, setReverting] = useState(false);

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

  const handleUndo = async () => {
    if (reverting || modifiedConfigs.length === 0) return;
    setReverting(true);
    try {
      const result = await window.api.mcp.revertAppIntegrations({
        configs: modifiedConfigs.map((c) => ({
          configPath: c.configPath,
          backupPath: c.backupPath,
        })),
      });
      if (result.errors?.length) {
        console.warn("Revert errors:", result.errors);
      }
      onRestart();
    } catch {
      // Revert failed
    } finally {
      setReverting(false);
    }
  };

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
              {apiKey.slice(0, 8)}...{apiKey.slice(-4)}
            </span>
          </div>
        </div>
      </Card>

      {/* Modified configs summary */}
      {modifiedConfigs.length > 0 && (
        <Card>
          <p className="text-xs text-[var(--text-muted)] mb-2">
            Configuration changes applied:
          </p>
          <div className="flex flex-col gap-1">
            {modifiedConfigs.map((entry) => (
              <div key={entry.configPath} className="flex items-center gap-2 text-sm">
                <span className="text-[var(--text-primary)] shrink-0">
                  {APP_ID_TO_NAME[entry.appId] ?? entry.appId}
                </span>
                <code className="text-xs text-[var(--text-muted)] truncate">
                  {entry.configPath}
                </code>
              </div>
            ))}
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
                    Config: <code>{entry.configPath}</code>
                  </div>
                  {entry.backupPath && (
                    <div className="text-[var(--text-muted)]">
                      Backup: <code>{entry.backupPath}</code>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          onClick={handleOpenDashboard}
          className="w-full"
        >
          Open Dashboard
        </Button>
        <Button
          variant="ghost"
          onClick={handleComplete}
          loading={completing}
          className="w-full"
        >
          Finish Setup
        </Button>
        {modifiedConfigs.length > 0 && (
          <Button
            variant="ghost"
            onClick={handleUndo}
            loading={reverting}
            className="w-full text-[var(--danger)]"
          >
            Undo Configuration Changes
          </Button>
        )}
      </div>
    </div>
  );
}
