import { useState, useEffect } from "react";
import { Button, Card, Badge } from "@edison/shared/ui";

const DOCS_URL = "https://docs.edison.watch";

interface SetupData {
  completed?: boolean;
  userEmail?: string;
  mcpBaseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

export default function MainMenu(): React.ReactNode {
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    (async () => {
      const data = (await window.api.setup.getData()) as SetupData;
      setSetupData(data);
      const status = await window.api.health.check();
      setOnline(status);
      const ver = await window.api.menu.getVersion();
      setVersion(ver);
      // Resize window to fit the compact menu
      await window.api.menu.resizeWindow(400, 380);
    })();
    const interval = setInterval(async () => {
      const status = await window.api.health.check();
      setOnline(status);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!setupData) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-base)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  const mcpUrl =
    setupData.mcpBaseUrl && setupData.apiKey
      ? `${setupData.mcpBaseUrl.replace(/\/$/, "")}/mcp/${setupData.apiKey}`
      : null;

  const handleOpenDashboard = async () => {
    // Use the live effective URL from main (handles dev overrides); fall back
    // to what was saved in setup.json in case the IPC call fails.
    let url = "";
    try {
      const effective = await window.api.config.getEffectiveBaseUrls();
      url = effective.apiBaseUrl ?? "";
    } catch {
      // ignore
    }
    if (!url) url = setupData.apiBaseUrl ?? "";
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (url) await window.api.shell.openExternal(url);
  };

  const handleCopyMcpConfig = async () => {
    if (!mcpUrl) return;
    const config = await window.api.menu.getMcpConfig();
    if (config) {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenDocs = () => {
    window.api.shell.openExternal(DOCS_URL);
  };

  const handleOpenFeedback = () => {
    window.api.menu.openFeedback();
  };

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-base)]">
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-sm flex-col gap-3">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/10 text-sm">
              &#10003;
            </div>
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                Edison Watch
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                {setupData.userEmail || ""}
              </p>
            </div>
            <div className="ml-auto">
              <Badge
                variant={
                  online === true
                    ? "success"
                    : online === false
                      ? "danger"
                      : "warning"
                }
                size="sm"
              >
                {online === true
                  ? "Connected"
                  : online === false
                    ? "Disconnected"
                    : "Checking"}
              </Badge>
            </div>
          </div>

          {/* Server info */}
          {setupData.mcpBaseUrl && (
            <Card>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-muted)]">Server</span>
                <span className="text-sm text-[var(--text-primary)] truncate max-w-[200px]">
                  {setupData.mcpBaseUrl}
                </span>
              </div>
            </Card>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              onClick={handleOpenDashboard}
              className="w-full"
            >
              Open Dashboard
            </Button>
            {mcpUrl && (
              <Button
                variant="ghost"
                onClick={handleCopyMcpConfig}
                className="w-full"
              >
                {copied ? "Copied!" : "Copy EdisonWatch MCP config"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Footer: version (left), docs + feedback (right) */}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
        <span className="text-xs text-[var(--text-muted)]">
          {version ? `v${version}` : ""}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleOpenDocs}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title="Documentation"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM8.94 6.94a.75.75 0 11-1.061-1.061 3 3 0 112.871 5.026v.345a.75.75 0 01-1.5 0v-.5c0-.72.57-1.172 1.081-1.287A1.5 1.5 0 108.94 6.94zM10 15a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleOpenFeedback}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title="Send Feedback"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path
                fillRule="evenodd"
                d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 001.33 0l1.713-3.293a.783.783 0 01.642-.413 41.102 41.102 0 003.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0010 2zM6.75 6a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 2.5a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
