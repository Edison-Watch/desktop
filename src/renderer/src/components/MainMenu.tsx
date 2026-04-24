import { useState, useEffect } from "react";
import { Button, Badge } from "@edison/shared/ui";
import { supabase } from "@edison/shared/auth";
import { clearCachedSecretKey } from "@edison/shared/crypto";
import edisonIcon from "../assets/edison-icon.png";
import ClientsView from "./ClientsView";
import MyMcpsView from "./MyMcpsView";

type MenuTab = "home" | "clients" | "my-mcps";

interface SetupData {
  completed?: boolean;
  userEmail?: string;
  userId?: string;
  mcpBaseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

interface SavedAccount {
  userId: string;
  userEmail: string;
  savedAt: string;
}

export default function MainMenu(): React.ReactNode {
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [version, setVersion] = useState("");
  const [docsUrl, setDocsUrl] = useState("https://docs.edison.watch");
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [showAccounts, setShowAccounts] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [activeTab, setActiveTab] = useState<MenuTab>("clients");

  useEffect(() => {
    (async () => {
      const data = (await window.api.setup.getData()) as SetupData;
      const status = await window.api.health.check();
      setOnline(status);
      const ver = await window.api.menu.getVersion();
      setVersion(ver);
      const urls = await window.api.config.getEffectiveBaseUrls();
      setDocsUrl(urls.docsBaseUrl);
      // Override setup.json URLs with environment-aware values from main process
      const mergedData: SetupData = {
        ...data,
        ...(urls.mcpBaseUrl ? { mcpBaseUrl: urls.mcpBaseUrl } : {}),
        ...(urls.apiBaseUrl ? { apiBaseUrl: urls.apiBaseUrl } : {}),
      };
      setSetupData(mergedData);
      const saved = await window.api.accounts.list();
      setAccounts(saved);
      // Default tab is "clients" which needs taller window for the list
      await window.api.menu.resizeWindow(461, 749);
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

  const handleCopyMcpUrl = async () => {
    if (!mcpUrl) return;
    // Use IPC rather than local mcpUrl: in dev mode getMcpBaseUrl() returns
    // DEV_MCP_BASE_URL which differs from the stored setupData.mcpBaseUrl.
    const url = await window.api.menu.getMcpUrl();
    if (url) {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  const handleOpenDocs = () => {
    window.api.shell.openExternal(docsUrl);
  };

  const handleOpenFeedback = () => {
    window.api.menu.openFeedback();
  };

  const handleSwitchAccount = async (userId: string) => {
    setSwitching(true);
    try {
      const result = await window.api.accounts.switch(userId);
      if (!result.ok) {
        setSwitching(false);
        return;
      }
      await supabase.auth.signOut();
    } catch {
      // fall through to reload regardless - main process may already
      // be operating as the new account after a successful switch
    }
    clearCachedSecretKey();
    window.location.reload();
  };

  const handleRemoveAccount = async (userId: string) => {
    await window.api.accounts.remove(userId);
    setAccounts((prev) => prev.filter((a) => a.userId !== userId));
  };

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // best-effort sign-out; always continue to reset
    }
    clearCachedSecretKey();
    await window.api.setup.reset();
    window.location.reload();
  };

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-base)]">
      <div className="flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-sm flex-col gap-4">
          {/* Header */}
          <div className="flex items-center gap-3">
            <img src={edisonIcon} alt="Edison Watch" className="h-8 w-8 rounded-lg" />
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-[var(--text-primary)] leading-tight">
                Edison Watch
              </h2>
              <p className="text-xs text-[var(--text-muted)] truncate">
                {setupData.userEmail || ""}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
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
                    : "Checking…"}
              </Badge>
              {online === false && (
                <button
                  type="button"
                  onClick={async () => {
                    setOnline(null);
                    const status = await window.api.health.check();
                    setOnline(status);
                  }}
                  className="flex items-center justify-center h-5 w-5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                  title="Recheck connection"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" aria-hidden="true">
                    <path d="M13.65 2.35A7.96 7.96 0 008 0a8 8 0 108 8h-2a6 6 0 11-1.76-4.24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M14 1v3.5h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Tab navigation */}
          <div className="flex gap-1 border-b border-[var(--border)] -mx-1">
            {([
              { key: "clients" as const, label: "Home", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
              { key: "my-mcps" as const, label: "My MCPs", icon: "M4 5a1 1 0 011-1h14a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h14a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM8 6.5h.01M8 16.5h.01" },
              { key: "home" as const, label: "Config", icon: "M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" },
            ]).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveTab(tab.key);
                  // Resize window for list-heavy tabs (taller to fit list)
                  const needsTallWindow = tab.key === "clients" || tab.key === "my-mcps";
                  const height = needsTallWindow ? 749 : (setupData.mcpBaseUrl && setupData.apiKey ? 605 : 547);
                  window.api.menu.resizeWindow(461, height);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab.key
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
                  <path d={tab.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "clients" && <ClientsView />}

          {activeTab === "my-mcps" && <MyMcpsView />}

          {activeTab === "home" && (<>
          {/* Account switcher */}
          {(() => {
            const otherAccounts = accounts.filter((a) => a.userId !== setupData.userId && a.userEmail !== setupData.userEmail);
            if (otherAccounts.length === 0) return null;
            return (
            <div>
              <button
                type="button"
                onClick={() => setShowAccounts((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  className={`h-3 w-3 transition-transform ${showAccounts ? "rotate-180" : ""}`}
                  aria-hidden="true"
                >
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {otherAccounts.length} other account{otherAccounts.length > 1 ? "s" : ""}
              </button>
              {showAccounts && (
                <div className="mt-2 flex flex-col gap-1">
                  {otherAccounts.map((account) => (
                      <div
                        key={account.userId}
                        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2"
                      >
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--bg-input)] text-[10px] font-semibold text-[var(--text-secondary)] shrink-0">
                          {account.userEmail[0]?.toUpperCase() || "?"}
                        </div>
                        <span className="flex-1 min-w-0 text-xs text-[var(--text-primary)] truncate">
                          {account.userEmail}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleSwitchAccount(account.userId)}
                          disabled={switching}
                          className="shrink-0 text-[11px] font-medium text-[var(--accent)] hover:text-[var(--accent-muted)] transition-colors disabled:opacity-50"
                        >
                          Switch
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveAccount(account.userId)}
                          disabled={switching}
                          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--danger)] transition-colors disabled:opacity-50"
                          title="Remove account"
                        >
                          <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
                            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
            );
          })()}

          {/* Server info - click to copy MCP URL */}
          {setupData.mcpBaseUrl && (
            <button
              type="button"
              onClick={handleCopyMcpUrl}
              className="w-full rounded-lg border border-[var(--border)] overflow-hidden text-left hover:border-[var(--accent-muted)] transition-colors cursor-copy group"
              style={{
                borderTopColor: "var(--accent-dim)",
                background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
              }}
            >
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <span className="text-xs text-[var(--text-muted)] shrink-0">Server</span>
                <div className="flex items-center gap-2 min-w-0">
                  {copiedUrl ? (
                    <span className="text-xs font-medium text-[var(--accent)]">Copied!</span>
                  ) : (
                    <>
                      <span className="text-xs text-[var(--text-primary)] truncate font-mono">
                        {setupData.mcpBaseUrl}
                      </span>
                      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" aria-hidden="true">
                        <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                    </>
                  )}
                </div>
              </div>
            </button>
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
              <div className="flex flex-col gap-1.5">
                <Button
                  variant="ghost"
                  onClick={handleCopyMcpConfig}
                  className="w-full"
                >
                  {copied ? "Copied!" : "Copy EdisonWatch MCP config"}
                </Button>
                {copied && (
                  <p className="text-center text-[11px] text-[var(--text-muted)] -mt-0.5">
                    Paste into VSCode, Cursor, or your MCP client
                  </p>
                )}
              </div>
            )}
          </div>
          </>)}
        </div>
      </div>

      {/* Footer: version (left), docs + feedback + sign out (right) */}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-2.5">
        <span className="text-[11px] text-[var(--text-muted)] font-mono">
          {version ? `v${version}` : ""}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleOpenDocs}
            className="group flex items-center gap-1.5 h-7 px-2 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path d="M10.75 16.82A7.462 7.462 0 0115 15.5c.71 0 1.396.098 2.046.282A.75.75 0 0018 15.06V4.56a.75.75 0 00-.474-.695A9.962 9.962 0 0015 3.5c-1.87 0-3.57.62-4.95 1.66a.25.25 0 01-.1.04V16.82zM9.25 16.82V5.2a.25.25 0 00-.1-.04A7.455 7.455 0 005 3.5c-.88 0-1.73.114-2.526.327A.75.75 0 002 4.56v10.5a.75.75 0 00.954.721A7.462 7.462 0 015 15.5c1.57 0 3.042.474 4.25 1.32z" />
            </svg>
            <span className="text-[10px] font-medium hidden group-hover:inline">Docs</span>
          </button>
          <button
            type="button"
            onClick={handleOpenFeedback}
            className="group flex items-center gap-1.5 h-7 px-2 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 001.33 0l1.713-3.293a.783.783 0 01.642-.413 41.102 41.102 0 003.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0010 2zM6.75 6a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 2.5a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-[10px] font-medium hidden group-hover:inline">Feedback</span>
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className="group flex items-center gap-1.5 h-7 px-2 rounded-md text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-hover)] transition-all"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z"
                clipRule="evenodd"
              />
              <path
                fillRule="evenodd"
                d="M19 10a.75.75 0 00-.75-.75H8.704l1.048-.943a.75.75 0 10-1.004-1.114l-2.5 2.25a.75.75 0 000 1.114l2.5 2.25a.75.75 0 101.004-1.114l-1.048-.943h9.546A.75.75 0 0019 10z"
                clipRule="evenodd"
              />
            </svg>
            <span className="text-[10px] font-medium hidden group-hover:inline">Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
