import { useState, useEffect, useCallback } from "react";
import { Button, Card } from "@edison/shared/ui";
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

export interface DiscoveredServer {
  name: string;
  client: string;
  source: string;
}

interface AppsStepProps {
  onNext: (selectedApps: string[], discoveredServers: DiscoveredServer[]) => void;
}

export default function AppsStep({
  onNext,
}: AppsStepProps): React.ReactNode {
  const [clients, setClients] = useState<DetectedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [scanned, setScanned] = useState(false);
  const [showServers, setShowServers] = useState(false);

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

  const handleScan = async () => {
    setScanning(true);
    try {
      const all = await window.api.mcp.discover() as Array<{ name: string; client: string; source: string }>;
      console.log("[AppsStep] Discovered", all.length, "MCP servers");
      setDiscoveredServers(all);
      setScanned(true);
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
              className="relative rounded-lg border border-[var(--border)] overflow-hidden"
              style={{
                borderTopColor: client.enabled ? "var(--accent-dim)" : "var(--border)",
                background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
                boxShadow: client.enabled ? "0 0 12px 0 rgba(125, 255, 246, 0.1)" : "none",
              }}
            >
              <span className="absolute top-1.5 right-2 text-[9px] font-medium text-emerald-400/80">
                Detected
              </span>
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
                      ? "border-[var(--accent)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  {client.enabled && (
                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" aria-hidden="true">
                      <path d="M2 6l3 3 5-5" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

      {/* Discovered MCP Servers */}
      <Card>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="flex items-center justify-between w-full text-left"
            onClick={() => {
              if (!scanned) handleScan();
              else setShowServers((v) => !v);
            }}
          >
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Discovered MCP servers
                {scanned && discoveredServers.length > 0 && (
                  <span className="ml-1.5 text-xs text-[var(--text-muted)] font-normal">
                    ({discoveredServers.length})
                  </span>
                )}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                MCP servers configured in your clients.
              </p>
            </div>
            {scanning ? (
              <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            ) : (
              <svg
                viewBox="0 0 12 12"
                fill="none"
                className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${scanned && showServers ? "rotate-180" : ""}`}
                aria-hidden="true"
              >
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>

          {scanned && showServers && (
            <div className="mt-2 rounded-md bg-[var(--bg-input)] p-3 text-xs">
              {discoveredServers.length === 0 ? (
                <span className="text-[var(--text-muted)]">No MCP servers found.</span>
              ) : (
                <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                  {discoveredServers.map((s) => (
                    <div key={s.client + ":" + s.name} className="flex items-center gap-2">
                      <span className="text-[var(--text-primary)] font-medium truncate">{s.name}</span>
                      <span className="text-[var(--text-muted)] shrink-0">{s.client}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Button
        variant="primary"
        onClick={() => onNext(clients.filter((c) => c.enabled).map((c) => c.id), discoveredServers)}
        className="w-full"
      >
        {selectedCount > 0
          ? `Continue with ${selectedCount} App${selectedCount === 1 ? "" : "s"}`
          : "Skip"}
      </Button>
    </div>
  );
}
