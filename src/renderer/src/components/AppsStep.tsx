import { useState, useEffect, useCallback } from "react";
import { Button, Card, Badge, Input } from "@edison/shared/ui";
import { AppLogo } from "./AppLogo";

interface DetectedClient {
  id: string;
  name: string;
  configPath: string;
  enabled: boolean;
  configPreview: string | null;
  expanded: boolean;
}

export interface ModifiedConfig {
  appId: string;
  configPath: string;
  backupPath: string;
}

interface AppsStepProps {
  mcpBaseUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  userId: string;
  onNext: () => void;
  onApplyResult: (configs: ModifiedConfig[], secretKey: string) => void;
}

export default function AppsStep({
  mcpBaseUrl,
  apiBaseUrl,
  apiKey,
  userId,
  onNext,
  onApplyResult,
}: AppsStepProps): React.ReactNode {
  const [clients, setClients] = useState<DetectedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [edisonSecretKey, setEdisonSecretKey] = useState("");

  // Scan & submit state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    submitted: number;
    autoApproved: number;
    skipped: number;
    total: number;
    servers?: Array<{ name: string; client: string; source: string }>;
    error?: string;
    errors?: string[];
  } | null>(null);
  const [showScanServers, setShowScanServers] = useState(false);

  const detectClients = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const detected = await window.api.mcp.detectClients();
      setClients((prev) => {
        // Preserve enabled/expanded state for existing clients
        const prevMap = new Map(prev.map((c) => [c.id, c]));
        return detected.map((c) => {
          const existing = prevMap.get(c.id);
          return {
            ...c,
            enabled: existing ? existing.enabled : true,
            configPreview: existing ? existing.configPreview : null,
            expanded: existing ? existing.expanded : false,
          };
        });
      });
    } catch {
      // Discovery failed
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Detect installed MCP clients on mount
  useEffect(() => {
    detectClients(false);
  }, [detectClients]);

  // Auto-refresh every 30 seconds to pick up newly installed clients
  useEffect(() => {
    const interval = setInterval(() => detectClients(true), 30000);
    return () => clearInterval(interval);
  }, [detectClients]);

  const toggleClient = (id: string) => {
    setClients((prev) =>
      prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
    );
  };

  const toggleExpanded = async (id: string) => {
    setClients((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (!c.expanded && !c.configPreview) {
          // Load config preview on first expand
          window.api.mcp.readConfig(c.configPath).then((content) => {
            setClients((curr) =>
              curr.map((cc) => (cc.id === id ? { ...cc, configPreview: content ?? "(No config file yet)" } : cc)),
            );
          });
        }
        return { ...c, expanded: !c.expanded };
      }),
    );
  };

  const handleApply = async () => {
    setApplying(true);
    setApplyError("");
    try {
      const selectedApps = clients.filter((c) => c.enabled).map((c) => c.id);
      const serverAddress = mcpBaseUrl ? new URL(mcpBaseUrl).host : "";
      const result = await window.api.mcp.applyAppIntegrations({
        serverAddress,
        mcpBaseUrl,
        apiKey,
        edisonSecretKey: edisonSecretKey || undefined,
        apps: selectedApps,
      });
      onApplyResult(result.modifiedConfigs, edisonSecretKey);
      onNext();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  const handleScanAndSubmit = async () => {
    setScanning(true);
    setScanResult(null);
    setShowScanServers(false);
    try {
      const result = await window.api.mcp.submitAllDiscovered({
        apiKey,
        apiBaseUrl,
        userId,
      });
      setScanResult(result);
    } catch {
      // Scan failed
    } finally {
      setScanning(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        <p className="text-sm text-[var(--text-secondary)]">Detecting installed MCP clients...</p>
      </div>
    );
  }

  const selectedCount = clients.filter((c) => c.enabled).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Connect Your Apps</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Select which MCP clients to configure with Edison Watch.
        </p>
      </div>

      {clients.length === 0 ? (
        <Card>
          <div className="flex items-center justify-between py-2">
            <p className="text-sm text-[var(--text-muted)]">
              No MCP clients detected. You can configure them manually later.
            </p>
            <button
              type="button"
              onClick={() => detectClients(true)}
              disabled={refreshing}
              className="ml-3 shrink-0 text-xs text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Refresh row */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => detectClients(true)}
              disabled={refreshing}
              className="text-xs text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>

          {clients.map((client) => (
            <div
              key={client.id}
              className="rounded-lg border border-[var(--border)] overflow-hidden"
              style={{
                borderTopColor: client.enabled ? "var(--accent-dim)" : "var(--border)",
                background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
              }}
            >
              {/* Clickable row — toggles selection */}
              <button
                type="button"
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-input)]/40 transition-colors"
                onClick={() => toggleClient(client.id)}
              >
                {/* Checkbox indicator */}
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                    client.enabled
                      ? "border-[var(--accent)] bg-[var(--accent)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  {client.enabled && (
                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
                      <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                {/* App logo */}
                <AppLogo id={client.id} name={client.name} />

                {/* Name + path */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {client.name}
                    </span>
                    <Badge variant="success" size="sm">Detected</Badge>
                  </div>
                  <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                    {client.configPath}
                  </p>
                </div>
              </button>

              {/* Config preview toggle */}
              {client.expanded && (
                <pre className="mx-4 mb-3 max-h-40 overflow-auto rounded-md bg-[var(--bg-input)] p-3 text-xs text-[var(--text-secondary)]">
                  {client.configPreview ?? "Loading config..."}
                </pre>
              )}
              <div className="px-4 pb-2">
                <button
                  type="button"
                  className="text-xs text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors"
                  onClick={() => toggleExpanded(client.id)}
                >
                  {client.expanded ? "Hide config" : "Show config"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edison Secret Key (optional) */}
      <Card>
        <Input
          type="password"
          label="Encryption Key (optional)"
          description="Paste your edison_secret_key to enable encrypted credential decryption. You can add it later in the dashboard."
          placeholder="e.g. 3ecmKtPUBi4KFhYcxo43Hy..."
          value={edisonSecretKey}
          onChange={(e) => setEdisonSecretKey(e.target.value)}
        />
      </Card>

      {/* Scan & Submit MCP Servers */}
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Register MCP Servers
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Discover MCP servers in your clients and register them with Edison Watch.
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={handleScanAndSubmit}
              loading={scanning}
            >
              {scanning ? "Scanning..." : "Scan & Submit"}
            </Button>
          </div>

          {scanResult && (
            <div className="mt-2 rounded-md bg-[var(--bg-input)] p-3 text-xs">
              {scanResult.error ? (
                <span className="text-[var(--danger)]">{scanResult.error}</span>
              ) : (
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

                  {/* Discovered servers list */}
                  {scanResult.servers && scanResult.servers.length > 0 && (
                    <div className="mt-1">
                      <button
                        type="button"
                        className="text-[var(--accent-muted)] hover:text-[var(--accent)] transition-colors"
                        onClick={() => setShowScanServers((v) => !v)}
                      >
                        {showScanServers ? "Hide" : "Show"} {scanResult.servers.length} found server(s)
                      </button>
                      {showScanServers && (
                        <div className="mt-2 flex flex-col gap-1 max-h-32 overflow-y-auto">
                          {scanResult.servers.map((s) => (
                            <div key={s.client + ":" + s.name} className="flex items-center gap-2">
                              <span className="text-[var(--text-primary)] font-medium truncate">{s.name}</span>
                              <span className="text-[var(--text-muted)] shrink-0">{s.client}</span>
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
                  {scanResult.submitted > scanResult.autoApproved && (
                    <button
                      type="button"
                      className="mt-1 text-[var(--accent)] hover:underline text-left"
                      onClick={() => window.api.shell.openExternal(apiBaseUrl)}
                    >
                      Open Dashboard to approve
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {applyError && (
        <p className="text-sm text-[var(--danger)]">{applyError}</p>
      )}
      <Button
        variant="primary"
        onClick={handleApply}
        loading={applying}
        className="w-full"
      >
        {selectedCount > 0
          ? `Configure ${selectedCount} App${selectedCount === 1 ? "" : "s"}`
          : "Skip"}
      </Button>
    </div>
  );
}
