import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button } from "@edison/shared/ui";

// ── Types ────────────────────────────────────────────────────────────────────

interface TemplateFieldInfo {
  description: string;
  example: string;
}

interface AnalyzedServer {
  name: string;
  client: string;
  source: string;
  config: Record<string, unknown>;
  templatized: {
    config: Record<string, unknown>;
    templateFields: Record<string, Record<string, TemplateFieldInfo>>;
    secretValues: Record<string, string>;
  };
}

/** A template marking on a specific line — can be a partial substring */
interface TemplateMarking {
  varName: string;
  /** The substring that is templatized */
  selectedText: string;
  /** Char offset within the raw value */
  start: number;
  end: number;
  /** Was this auto-detected or user-selected? */
  autoDetected: boolean;
  enabled: boolean;
}

interface ConfigEntry {
  context: string;
  key: string;
  rawValue: string;
  entryId: string;
}

/** Floating popup state for "Mark as secret" action */
interface SelectionPopup {
  serverName: string;
  entryId: string;
  selectedText: string;
  start: number;
  end: number;
  x: number;
  y: number;
}

/** Serializable template override for IPC submission */
export interface TemplateOverrideEntry {
  entryId: string;
  varName: string;
  selectedText: string;
  start: number;
  end: number;
}

interface CredentialReviewCardProps {
  onSave: (overrides: Record<string, TemplateOverrideEntry[]>) => void;
  onCancel: () => void;
  saved: boolean;
  skipServers?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findSecretInValue(
  raw: string,
  secretValues: Record<string, string>,
  templatizedValue: string,
): { varName: string; start: number; end: number; text: string } | null {
  for (const [varName, secretVal] of Object.entries(secretValues)) {
    const placeholder = `{${varName}}`;
    if (templatizedValue.includes(placeholder) && raw.includes(secretVal)) {
      const start = raw.indexOf(secretVal);
      return { varName, start, end: start + secretVal.length, text: secretVal };
    }
  }
  return null;
}

function getConfigEntries(
  config: Record<string, unknown>,
  _templatizedConfig: Record<string, unknown>,
): ConfigEntry[] {
  const entries: ConfigEntry[] = [];

  if (config.command) {
    entries.push({
      context: "command",
      key: "command",
      rawValue: String(config.command),
      entryId: "command:command",
    });
  }

  const args = config.args as string[] | undefined;
  if (args) {
    for (let i = 0; i < args.length; i++) {
      entries.push({
        context: "args",
        key: `arg[${i}]`,
        rawValue: args[i],
        entryId: `args:arg[${i}]`,
      });
    }
  }

  const env = config.env as Record<string, string> | undefined;
  if (env) {
    for (const [key, val] of Object.entries(env)) {
      entries.push({ context: "env", key, rawValue: val, entryId: `env:${key}` });
    }
  }

  if (config.url) {
    entries.push({
      context: "url",
      key: "url",
      rawValue: String(config.url),
      entryId: "url:url",
    });
  }

  const headers = config.headers as Record<string, string> | undefined;
  if (headers) {
    for (const [key, val] of Object.entries(headers)) {
      entries.push({ context: "headers", key, rawValue: val, entryId: `headers:${key}` });
    }
  }

  return entries;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CredentialReviewCard({
  onSave,
  onCancel,
  saved,
  skipServers = [],
}: CredentialReviewCardProps): React.ReactNode {
  const [servers, setServers] = useState<AnalyzedServer[]>([]);
  const [loading, setLoading] = useState(true);
  const generateTokenName = (current: Map<string, Map<string, TemplateMarking>>): string => {
    const used = new Set<number>();
    for (const entryMap of current.values()) {
      for (const m of entryMap.values()) {
        const match = m.varName.match(/^TOKEN_(\d+)$/);
        if (match) used.add(Number(match[1]));
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    return `TOKEN_${n}`;
  };
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(true);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  // serverName → entryId → TemplateMarking
  const [markings, setMarkings] = useState<Map<string, Map<string, TemplateMarking>>>(new Map());
  // Snapshot of markings at load time for cancel/reset
  const [initialMarkings, setInitialMarkings] = useState<Map<string, Map<string, TemplateMarking>>>(new Map());
  // Floating popup for text selection
  const [popup, setPopup] = useState<SelectionPopup | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const buildOverrides = (m: Map<string, Map<string, TemplateMarking>>): Record<string, TemplateOverrideEntry[]> => {
    const result: Record<string, TemplateOverrideEntry[]> = {};
    // Include ALL servers (even those with no enabled markings) so the
    // submit handler doesn't fall back to auto-detection for missing keys.
    for (const server of servers) {
      const entryMap = m.get(server.name);
      const entries: TemplateOverrideEntry[] = [];
      if (entryMap) {
        for (const [entryId, marking] of entryMap) {
          if (marking.enabled) {
            entries.push({
              entryId,
              varName: marking.varName,
              selectedText: marking.selectedText,
              start: marking.start,
              end: marking.end,
            });
          }
        }
      }
      result[server.name] = entries;
    }
    return result;
  };

  const analyze = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.api.mcp.analyzeSecrets(skipServers.length > 0 ? { skipServers } : undefined);
      setServers(result);

      // Initialize markings from auto-detected secrets
      const initial = new Map<string, Map<string, TemplateMarking>>();
      for (const server of result) {
        const entryMap = new Map<string, TemplateMarking>();
        const entries = getConfigEntries(server.config, server.templatized.config);

        for (const entry of entries) {
          // Find the templatized counterpart to locate the secret
          let templatizedValue = entry.rawValue;
          if (entry.context === "args") {
            const idx = parseInt(entry.key.match(/\d+/)?.[0] ?? "0", 10);
            const tArgs = server.templatized.config.args as string[] | undefined;
            templatizedValue = tArgs?.[idx] ?? entry.rawValue;
          } else if (entry.context === "env") {
            const tEnv = server.templatized.config.env as Record<string, string> | undefined;
            templatizedValue = tEnv?.[entry.key] ?? entry.rawValue;
          } else if (entry.context === "url") {
            templatizedValue = (server.templatized.config.url as string) ?? entry.rawValue;
          } else if (entry.context === "headers") {
            const tHeaders = server.templatized.config.headers as Record<string, string> | undefined;
            templatizedValue = tHeaders?.[entry.key] ?? entry.rawValue;
          }

          const found = findSecretInValue(
            entry.rawValue,
            server.templatized.secretValues,
            templatizedValue,
          );
          if (found) {
            entryMap.set(entry.entryId, {
              varName: found.varName,
              selectedText: found.text,
              start: found.start,
              end: found.end,
              autoDetected: true,
              enabled: true,
            });
          }
        }
        if (entryMap.size > 0) initial.set(server.name, entryMap);
      }
      setMarkings(initial);
      setInitialMarkings(new Map(Array.from(initial, ([k, v]) => [k, new Map(v)])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze servers");
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipServers.join(",")]);

  useEffect(() => {
    void analyze();
  }, [analyze]);

  // Dismiss popup on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popup && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopup(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [popup]);

  const toggleMarking = (serverName: string, entryId: string) => {
    setMarkings((prev) => {
      const next = new Map(prev);
      const entryMap = new Map(next.get(serverName) ?? []);
      const marking = entryMap.get(entryId);
      if (marking) {
        entryMap.set(entryId, { ...marking, enabled: !marking.enabled });
        next.set(serverName, entryMap);
      }
      return next;
    });
  };

  const removeMarking = (serverName: string, entryId: string) => {
    setMarkings((prev) => {
      const next = new Map(prev);
      const entryMap = new Map(next.get(serverName) ?? []);
      entryMap.delete(entryId);
      if (entryMap.size > 0) {
        next.set(serverName, entryMap);
      } else {
        next.delete(serverName);
      }
      return next;
    });
    setPopup(null);
  };

  const addMarking = (
    serverName: string,
    entryId: string,
    _entry: ConfigEntry,
    selectedText: string,
    start: number,
    end: number,
  ) => {
    setMarkings((prev) => {
      const varName = generateTokenName(prev);
      const next = new Map(prev);
      const entryMap = new Map(next.get(serverName) ?? []);
      entryMap.set(entryId, {
        varName,
        selectedText,
        start,
        end,
        autoDetected: false,
        enabled: true,
      });
      next.set(serverName, entryMap);
      return next;
    });
    setPopup(null);
  };

  const handleTextSelect = (serverName: string, entry: ConfigEntry, mouseEvent: React.MouseEvent) => {
    const mouseX = mouseEvent.clientX;
    const mouseY = mouseEvent.clientY;
    // Use setTimeout so the browser finalizes the selection before we read it
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;

      const text = sel.toString().trim();
      if (!text || entry.context === "command") return;

      // Verify the selection is within the raw value
      if (!entry.rawValue.includes(text)) return;

      // Compute the exact offset from the DOM range to handle repeated substrings
      const range = sel.getRangeAt(0);
      const container = range.startContainer.parentElement?.closest("[data-value-container]");
      if (!container) return;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let charCount = 0;
      let startOffset = -1;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
          startOffset = charCount + range.startOffset;
          break;
        }
        charCount += (node.textContent?.length ?? 0);
      }
      if (startOffset < 0) return;
      const endOffset = startOffset + text.length;

      setPopup({
        serverName,
        entryId: entry.entryId,
        selectedText: text,
        start: startOffset,
        end: endOffset,
        x: mouseX,
        y: mouseY + 8,
      });
    }, 0);
  };

  const secretCount = Array.from(markings.values()).reduce(
    (acc, entryMap) => {
      for (const m of entryMap.values()) {
        if (m.enabled) acc++;
      }
      return acc;
    },
    0,
  );

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 py-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          <span className="text-sm text-[var(--text-secondary)]">Analyzing server credentials...</span>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[var(--danger)]">{error}</p>
          <Button variant="secondary" size="sm" onClick={analyze}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (servers.length === 0) {
    return (
      <Card>
        <p className="text-sm text-[var(--text-muted)]">No MCP servers discovered.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-3" ref={containerRef}>
        {/* Foldable header */}
        <button
          type="button"
          className="flex items-center gap-2 text-left w-full"
          onClick={() => {
            if (!collapsed) setPopup(null); // clear popup when collapsing
            setCollapsed((v) => !v);
          }}
        >
          <svg
            viewBox="0 0 10 10"
            className={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform ${collapsed ? "" : "rotate-90"}`}
          >
            <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              Review Detected Credentials
            </p>
            {collapsed && secretCount > 0 && (
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {secretCount} credential{secretCount === 1 ? "" : "s"} across {servers.length} server{servers.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {collapsed && secretCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-400 shrink-0">
              {secretCount}
            </span>
          )}
        </button>

        {/* Selection popup — rendered outside collapsed block so it persists */}
        {popup && (
          <div
            className="fixed z-50 flex items-center gap-1 px-2 py-1 rounded-md shadow-lg bg-[var(--bg-overlay)] border border-[var(--border)]"
            style={{
              left: popup.x,
              top: popup.y,
              transform: "translateX(-50%)",
            }}
          >
            <button
              type="button"
              className="text-xs px-2 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30 hover:bg-orange-500/30 transition-colors whitespace-nowrap"
              onClick={() => {
                const server = servers.find((s) => s.name === popup.serverName);
                if (!server) return;
                const entries = getConfigEntries(server.config, server.templatized.config);
                const entry = entries.find((e) => e.entryId === popup.entryId);
                if (!entry) return;
                addMarking(popup.serverName, popup.entryId, entry, popup.selectedText, popup.start, popup.end);
                window.getSelection()?.removeAllRanges();
              }}
            >
              Mark as secret
            </button>
            <button
              type="button"
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
              onClick={() => {
                setPopup(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <svg viewBox="0 0 10 10" className="h-3 w-3">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {!collapsed && (
          <>
        <div>
          <p className="text-xs text-[var(--text-muted)]">
            {secretCount > 0
              ? `${secretCount} credential${secretCount === 1 ? "" : "s"} detected across ${servers.length} server${servers.length === 1 ? "" : "s"}. Review and adjust before submitting. These credentials will be encrypted.`
              : `${servers.length} server${servers.length === 1 ? "" : "s"} found. No credentials detected — select text in any value to mark it as a secret.`}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] mt-1 italic">
            Select any part of a value to mark it as a credential. Only one credential per line.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          {servers.map((server) => {
            const isExpanded = expandedServer === server.name;
            const serverMarkings = markings.get(server.name) ?? new Map<string, TemplateMarking>();
            const enabledCount = Array.from(serverMarkings.values()).filter((m) => m.enabled).length;
            const entries = getConfigEntries(server.config, server.templatized.config);

            return (
              <div key={server.client + ":" + server.name}>
                {/* Server header row */}
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-input)] transition-colors text-left"
                  onClick={() => setExpandedServer(isExpanded ? null : server.name)}
                >
                  <svg
                    viewBox="0 0 10 10"
                    className={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform ${isExpanded ? "rotate-90" : ""}`}
                  >
                    <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate flex-1">
                    {server.name}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] shrink-0">{server.client}</span>
                  {enabledCount > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-400 shrink-0">
                      {enabledCount} secret{enabledCount === 1 ? "" : "s"}
                    </span>
                  )}
                </button>

                {/* Expanded config details */}
                {isExpanded && (
                  <div className="ml-5 mt-1 mb-2 rounded-md bg-[var(--bg-input)] p-3 text-xs font-mono overflow-x-auto">
                    {entries.length === 0 ? (
                      <p className="text-[var(--text-muted)] text-xs font-sans">No configurable values found for this server.</p>
                    ) : (
                    <div className="flex flex-col gap-1.5">
                      {entries.map((entry) => {
                        const marking = serverMarkings.get(entry.entryId);
                        const hasMarking = !!marking;

                        return (
                          <div key={entry.entryId} className="flex flex-col gap-0.5">
                            <div className="flex items-start gap-1.5">
                              {/* Label */}
                              <span className="text-[var(--text-muted)] shrink-0 select-none min-w-[80px]">
                                {entry.context === "command" ? "$" : entry.key}
                                {entry.context !== "command" && entry.context !== "args" && "="}
                              </span>

                              {/* Value */}
                              <span
                                className={`flex-1 break-all ${entry.context === "command" ? "" : "cursor-text"}`}
                                style={{ userSelect: "text", WebkitUserSelect: "text" }}
                                data-value-container
                                onMouseUp={(e) => {
                                  if (entry.context !== "command") {
                                    handleTextSelect(server.name, entry, e);
                                  }
                                }}
                              >
                                {hasMarking ? (
                                  /* Marking exists — clickable button, grey when disabled with X to remove */
                                  <>
                                    {marking.start > 0 && (
                                      <span className="text-[var(--text-secondary)]">
                                        {entry.rawValue.slice(0, marking.start)}
                                      </span>
                                    )}
                                    <span className="relative inline-block">
                                      <button
                                        type="button"
                                        className={`px-1 rounded border transition-colors ${
                                          marking.enabled
                                            ? "bg-orange-500/20 text-orange-300 border-orange-500/30 hover:bg-orange-500/30"
                                            : "bg-[var(--bg-base)] text-[var(--text-muted)] border-[var(--border)]"
                                        }`}
                                        onClick={() => toggleMarking(server.name, entry.entryId)}
                                        title={
                                          marking.enabled
                                            ? "Click to disable (keep value as-is)"
                                            : "Click to re-enable as secret"
                                        }
                                      >
                                        {marking.selectedText}
                                      </button>
                                      {/* X button on top-right of disabled box */}
                                      {!marking.enabled && (
                                        <button
                                          type="button"
                                          className="absolute -top-1.5 -right-1.5 flex items-center justify-center h-3.5 w-3.5 rounded-full bg-[var(--bg-overlay)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--danger)] hover:border-[var(--danger)] transition-colors"
                                          onClick={() => removeMarking(server.name, entry.entryId)}
                                          title="Remove template"
                                        >
                                          <svg viewBox="0 0 10 10" className="h-2 w-2">
                                            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                          </svg>
                                        </button>
                                      )}
                                    </span>
                                    {marking.end < entry.rawValue.length && (
                                      <span className="text-[var(--text-secondary)]">
                                        {entry.rawValue.slice(marking.end)}
                                      </span>
                                    )}
                                    {marking.enabled && (
                                      <span className="inline-flex items-center ml-1 whitespace-nowrap">
                                        <span className="text-orange-400/70 text-[10px]">
                                          {"{"}{marking.varName}{"}"}
                                        </span>
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  /* No marking — plain selectable text */
                                  <span className="text-[var(--text-secondary)]">
                                    {entry.rawValue}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Save / Cancel */}
        {saved ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-emerald-400">Changes saved.</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onCancel()}
            >
              Edit
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                // Reset to auto-detected defaults
                setMarkings(new Map(Array.from(initialMarkings, ([k, v]) => [k, new Map(v)])));
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSave(buildOverrides(markings))}
            >
              Save
            </Button>
          </div>
        )}
          </>
        )}
      </div>
    </Card>
  );
}
