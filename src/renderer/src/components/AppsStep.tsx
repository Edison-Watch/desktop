import { useState, useEffect, useCallback, useRef } from "react";
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
  clients?: string[];
  source: string;
}

export interface DuplicateGroup {
  fingerprint: string;
  kind: "same-config" | "name-conflict";
  servers: Array<{ name: string; originalName?: string; client: string; clients?: string[]; config?: Record<string, unknown> }>;
  /** Set when user resolves: "keep-both" = keep all (default), string = name of server to keep */
  resolution?: "keep-both" | string;
}

export type RemovalTarget = string | { name: string; client: string };

interface AppsStepProps {
  onNext: (selectedApps: string[], discoveredServers: DiscoveredServer[], serversToRemove: RemovalTarget[]) => void;
  initialSelectedApps?: string[] | null;
}

export default function AppsStep({
  onNext,
  initialSelectedApps,
}: AppsStepProps): React.ReactNode {
  const [clients, setClients] = useState<DetectedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Scan state
  const [scanning, setScanning] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [scanned, setScanned] = useState(false);
  const scannedRef = useRef(false);
  const [showServers, setShowServers] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [expandedDupeServers, setExpandedDupeServers] = useState<Set<string>>(new Set());

  // null = first visit (all enabled by default), string[] = returning (restore selection)
  const initialSelectedSet = useRef(initialSelectedApps != null ? new Set(initialSelectedApps) : null);

  const detectClients = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const detected = await window.api.mcp.detectClients();
      setClients((prev) => {
        // Preserve enabled/expanded state for existing clients
        const prevMap = new Map(prev.map((c) => [c.id, c]));
        return detected.map((c) => {
          const existing = prevMap.get(c.id);
          // On first load, use initialSelectedApps if provided; otherwise default to true
          const defaultEnabled = initialSelectedSet.current ? initialSelectedSet.current.has(c.id) : true;
          return {
            ...c,
            enabled: existing ? existing.enabled : defaultEnabled,
            // On refresh, clear cached config so it gets re-read when expanded
            configPreview: isRefresh ? null : (existing ? existing.configPreview : null),
            expanded: existing ? existing.expanded : false,
          };
        });
      });
      // On refresh, re-read config for any currently expanded clients
      if (isRefresh) {
        setClients((prev) =>
          prev.map((c) => {
            if (c.expanded) {
              window.api.mcp.readConfig(c.configPath).then((content) => {
                setClients((curr) =>
                  curr.map((cc) => (cc.id === c.id ? { ...cc, configPreview: content ?? "(No config file yet)" } : cc)),
                );
              });
            }
            return c;
          }),
        );
        // Also re-scan discovered servers if already scanned
        if (scannedRef.current) {
          try {
            const all = await window.api.mcp.discover() as Array<{ name: string; client: string; clients?: string[]; source: string }>;
            setDiscoveredServers(all);
            const dupes = await window.api.mcp.findDuplicates() as DuplicateGroup[];
            setDuplicateGroups(dupes.map((g) => ({ ...g, resolution: "keep-both" })));
          } catch {
            // Re-scan failed
          }
        }
      }
    } catch {
      // Discovery failed
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Detect installed MCP clients on mount, then auto-scan servers
  useEffect(() => {
    detectClients(false).then(() => {
      if (!scannedRef.current) handleScan();
    });
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
      const all = await window.api.mcp.discover() as Array<{ name: string; client: string; clients?: string[]; source: string }>;
      console.log("[AppsStep] Discovered", all.length, "MCP servers");
      setDiscoveredServers(all);
      setScanned(true);
      scannedRef.current = true;
      // Fetch duplicate groups
      try {
        const dupes = await window.api.mcp.findDuplicates() as DuplicateGroup[];
        setDuplicateGroups(dupes.map((g) => ({ ...g, resolution: "keep-both" })));
      } catch { /* ignore */ }
    } catch {
      // Scan failed
    } finally {
      setScanning(false);
    }
  };

  const resolveDuplicateGroup = (fingerprint: string, resolution: "keep-both" | string) => {
    setDuplicateGroups((prev) =>
      prev.map((g) => (g.fingerprint === fingerprint ? { ...g, resolution } : g)),
    );
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
              className="rounded-lg border border-[var(--border)] overflow-hidden transition-shadow"
              style={{
                borderTopColor: client.enabled ? "var(--accent-dim)" : "var(--border)",
                background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
                boxShadow: client.enabled ? "0 0 12px 0 rgba(125, 255, 246, 0.08)" : "none",
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
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-all ${
                    client.enabled
                      ? "bg-[var(--accent)] border-[var(--accent)]"
                      : "border-2 border-[var(--border)]"
                  }`}
                >
                  {client.enabled && (
                    <svg viewBox="0 0 12 12" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                      <path d="M2 6l3 3 5-5" stroke="var(--bg-base)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                {/* App logo */}
                <AppLogo id={client.id} name={client.name} />

                {/* Name + path */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {client.name}
                    </span>
                    <span className="text-[10px] font-medium text-emerald-400/80 bg-emerald-400/10 px-1.5 py-0.5 rounded">
                      Detected
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
              <div className="px-4 pb-2.5">
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
            onClick={() => setShowServers((v) => !v)}
          >
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Discovered MCP servers
                {scanned && discoveredServers.length > 0 && (() => {
                  const conflictRenamedCount = duplicateGroups
                    .filter((g) => g.kind === "name-conflict")
                    .reduce((sum, g) => sum + g.servers.length, 0);
                  const conflictGroupCount = duplicateGroups.filter((g) => g.kind === "name-conflict").length;
                  const displayCount = discoveredServers.length - conflictRenamedCount + conflictGroupCount;
                  return (
                    <span className="ml-1.5 text-xs text-[var(--text-muted)] font-normal">
                      ({displayCount})
                    </span>
                  );
                })()}
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
                  {(() => {
                    // Build display list: merge name-conflict entries back to original name
                    const conflictNames = new Set<string>();
                    const conflictEntries: Array<{ name: string; clients: string[] }> = [];
                    for (const g of duplicateGroups) {
                      if (g.kind !== "name-conflict") continue;
                      const origName = g.servers[0]?.originalName ?? "";
                      const allClients = g.servers.flatMap((s) => s.clients && s.clients.length > 0 ? s.clients : [s.client]);
                      conflictEntries.push({ name: origName, clients: [...new Set(allClients)] });
                      for (const s of g.servers) conflictNames.add(s.name);
                    }
                    // Filter out renamed entries, append merged conflict entries
                    const display = [
                      ...discoveredServers.filter((s) => !conflictNames.has(s.name)),
                      ...conflictEntries.map((e) => ({ ...e, conflict: true })),
                    ];
                    return display.map((s) => (
                      <div key={s.name} className="flex items-center gap-2">
                        <span className="text-[var(--text-primary)] font-medium truncate">{s.name}</span>
                        {"conflict" in s && s.conflict && (
                          <span className="text-yellow-400 text-xs" title="Name conflict — see Duplicate resolution">*</span>
                        )}
                        <span className="text-[var(--text-muted)] shrink-0">
                          {("clients" in s && s.clients && s.clients.length > 0 ? s.clients : [("client" in s ? s.client : "")]).join(", ")}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Cross-name duplicates (different names, same config) */}
      {duplicateGroups.length > 0 && (
        <Card>
          <p className="text-xs font-medium text-orange-400 mb-2">
            Duplicate resolution ({duplicateGroups.length} group{duplicateGroups.length > 1 ? "s" : ""})
          </p>
          {duplicateGroups.map((group) => (
            <div key={group.fingerprint} className="mb-2 pl-2 border-l-2 border-orange-400/30">
              <p className="text-[10px] text-[var(--text-muted)] mb-1">
                {group.kind === "same-config"
                  ? "Same server config under different names:"
                  : `Same name "${group.servers[0]?.originalName ?? ""}" with different configs — auto-renamed:`}
              </p>
              {group.servers.map((s) => {
                const expandKey = `${group.fingerprint}:${s.name}`;
                const isExpanded = expandedDupeServers.has(expandKey);
                return (
                  <div key={s.name}>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-[var(--text-primary)] text-xs font-medium hover:text-[var(--accent)] transition-colors text-left"
                        onClick={() => setExpandedDupeServers((prev) => {
                          const next = new Set(prev);
                          if (next.has(expandKey)) next.delete(expandKey); else next.add(expandKey);
                          return next;
                        })}
                      >
                        <span className="inline-block w-3 text-[var(--text-muted)]">{isExpanded ? "▾" : "▸"}</span>
                        {s.name}
                      </button>
                      <span className="text-[var(--text-muted)] text-[10px]">
                        {(s.clients && s.clients.length > 0 ? s.clients : [s.client]).join(", ")}
                      </span>
                      {group.resolution === s.name && (
                        <span className="text-[10px] font-medium text-emerald-400/80 bg-emerald-400/10 px-1 py-0.5 rounded">
                          kept
                        </span>
                      )}
                      {group.resolution && group.resolution !== "keep-both" && group.resolution !== s.name && (
                        <span className="text-[10px] font-medium text-red-400/80 bg-red-400/10 px-1 py-0.5 rounded">
                          removed
                        </span>
                      )}
                    </div>
                    {isExpanded && s.config && (
                      <pre className="ml-5 mt-1 mb-1 max-h-28 overflow-auto rounded-md bg-[var(--bg-input)] p-2 text-[10px] text-[var(--text-secondary)]">
                        {JSON.stringify(s.config, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}

              {/* Resolve actions */}
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className={`text-[10px] transition-colors ${group.resolution === "keep-both" ? "text-[var(--accent)] font-medium" : "text-[var(--accent-muted)] hover:text-[var(--accent)]"}`}
                  onClick={() => resolveDuplicateGroup(group.fingerprint, "keep-both")}
                >
                  Keep both
                </button>
                {group.servers.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    className={`text-[10px] transition-colors ${group.resolution === s.name ? "text-[var(--accent)] font-medium" : "text-[var(--accent-muted)] hover:text-[var(--accent)]"}`}
                    onClick={() => resolveDuplicateGroup(group.fingerprint, s.name)}
                  >
                    Keep &ldquo;{s.name}&rdquo;
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}

      <Button
        variant="primary"
        onClick={() => {
          // Collect removal targets and compute filtered server list
          const removedNames = new Set<string>();
          const removalTargets: RemovalTarget[] = duplicateGroups.flatMap((g): RemovalTarget[] => {
            if (!g.resolution || g.resolution === "keep-both") return [];
            const removed = g.servers.filter((s) => s.name !== g.resolution);
            removed.forEach((s) => removedNames.add(s.name));
            if (g.kind === "name-conflict") {
              return removed.map((s) => ({
                name: s.originalName ?? s.name,
                client: s.client,
              }));
            }
            return removed.map((s) => s.name);
          });
          const effectiveServers = discoveredServers.filter((s) => !removedNames.has(s.name));
          onNext(clients.filter((c) => c.enabled).map((c) => c.id), effectiveServers, removalTargets);
        }}
        className="w-full"
      >
        {selectedCount > 0
          ? `Continue with ${selectedCount} App${selectedCount === 1 ? "" : "s"}`
          : "Skip"}
      </Button>
    </div>
  );
}
