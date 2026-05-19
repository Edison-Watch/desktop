import { useState, useEffect, useCallback } from "react";
import { Badge } from "@edison/shared/ui";
import { AppLogo } from "./AppLogo";

// Source of truth: ClaudeCodeMcpStatus in client_2/src/main/setupConfig.ts
// Duplicated here because renderer cannot import main-process modules directly.
type ClaudeCodeMcpStatus = "connected" | "failed" | "needs-auth" | "not-found" | "unknown";

interface HookStatus {
  client: string;
  installed: boolean;
  hasHook: boolean;
  hookCount: number;
  totalHooks: number;
  mcpConnected: boolean;
  mcpConfigured: boolean;
  mcpApplicable: boolean;
  hooksApplicable: boolean;
  mcpRuntimeStatus?: ClaudeCodeMcpStatus;
}

interface ClientInfo {
  id: string;
  name: string;
  installed: boolean;
  hasHook: boolean;
  hookCount: number;
  totalHooks: number;
  mcpConnected: boolean;
  mcpConfigured: boolean;
  mcpApplicable: boolean;
  hooksApplicable: boolean;
  mcpRuntimeStatus?: ClaudeCodeMcpStatus;
}

// Map client IDs (from McpClientId) to display names
const CLIENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  windsurf: "Windsurf (early alpha)",
  codex: "Codex",
  vscode: "VS Code",
  zed: "Zed (early alpha)",
  intellij: "IntelliJ IDEA (early alpha)",
  pycharm: "PyCharm",
  webstorm: "WebStorm",
};

type ClientStatus = "connected" | "partial-setup" | "installed" | "missing";

function StatusDot({ status }: { status: ClientStatus }) {
  const colors: Record<ClientStatus, string> = {
    connected: "bg-emerald-400",
    "partial-setup": "bg-amber-400",
    installed: "bg-red-400",
    missing: "bg-gray-500",
  };
  return (
    <span className="relative flex h-2 w-2">
      {status === "connected" && (
        <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
      )}
      <span
        className={`relative inline-flex h-2 w-2 rounded-full ${colors[status]}`}
      />
    </span>
  );
}

function getClientStatus(client: ClientInfo): ClientStatus {
  if (!client.installed) return "missing";
  const needsMcp = client.mcpApplicable;
  const needsHooks = client.hooksApplicable;
  const hooksSatisfied = !needsHooks || client.hasHook;
  const mcpSatisfied = !needsMcp || client.mcpConnected;
  if (hooksSatisfied && mcpSatisfied) return "connected";
  if ((needsHooks && (client.hasHook || client.hookCount > 0)) || (needsMcp && client.mcpConfigured)) return "partial-setup";
  return "installed";
}

/** Describes what's missing for a partial-setup client. */
function getIssueDetail(client: ClientInfo): string {
  const issues: string[] = [];
  if (client.mcpApplicable && !client.mcpConnected) {
    if (client.mcpRuntimeStatus === "failed") {
      issues.push("MCP server failed to connect in client");
    } else if (client.mcpRuntimeStatus === "needs-auth") {
      issues.push("MCP server needs authentication");
    } else if (client.mcpRuntimeStatus === "not-found") {
      issues.push("MCP server not registered in client");
    } else {
      issues.push(client.mcpConfigured ? "MCP gateway unreachable" : "MCP gateway not configured");
    }
  }
  if (client.hooksApplicable) {
    if (!client.hasHook && client.hookCount > 0) {
      issues.push(`${client.hookCount}/${client.totalHooks} hooks installed`);
    } else if (!client.hasHook) {
      issues.push("Hooks not installed");
    }
  }
  return issues.join(" · ");
}

/** Tooltip showing connection condition checklist on hover. */
function ConditionTooltip({ client }: { client: ClientInfo }) {
  const conditions = [
    { label: "Installed", met: client.installed },
    ...(client.hooksApplicable
      ? [{
          label: `Hooks (${client.hookCount}/${client.totalHooks})`,
          met: client.hasHook,
        }]
      : [{ label: "Hooks: N/A", met: true }]),
    ...(client.mcpApplicable
      ? [{
          label: client.mcpRuntimeStatus && client.mcpRuntimeStatus !== "unknown"
            ? `MCP gateway (${client.mcpRuntimeStatus})`
            : "MCP gateway",
          met: client.mcpConnected,
        }]
      : []),
  ];

  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 shadow-lg whitespace-nowrap">
        <p className="text-[10px] font-semibold text-[var(--text-muted)] mb-1.5 uppercase tracking-wider">
          Connection status
        </p>
        {conditions.map((c) => (
          <div key={c.label} className="flex items-center gap-1.5 py-0.5">
            <span className={`text-[11px] ${c.met ? "text-emerald-400" : "text-red-400"}`}>
              {c.met ? "✓" : "✗"}
            </span>
            <span className={`text-[11px] ${c.met ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"}`}>
              {c.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ClientsView(): React.ReactNode {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<ClientStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const statuses = (await window.api.mcp.getHookStatus()) as HookStatus[];
      setClients(
        statuses.map((s) => ({
          id: s.client,
          name: CLIENT_NAMES[s.client] ?? s.client,
          installed: s.installed,
          hasHook: s.hasHook,
          hookCount: s.hookCount ?? 0,
          totalHooks: s.totalHooks ?? 1,
          mcpConnected: s.mcpConnected ?? false,
          mcpConfigured: s.mcpConfigured ?? false,
          mcpApplicable: s.mcpApplicable ?? true,
          hooksApplicable: s.hooksApplicable ?? true,
          mcpRuntimeStatus: s.mcpRuntimeStatus,
        })),
      );
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Re-inject hooks and refresh status. Does NOT re-apply MCP configs
   *  (that's destructive and handled by setup/account-switch). */
  const refreshIntegrations = useCallback(async () => {
    if (refreshing) return; // debounce
    setRefreshing(true);
    try {
      // Re-inject any missing hooks (non-destructive - skips if already present)
      await window.api.mcp.injectHooks();
    } catch (err) {
      console.error("[ClientsView] Failed to refresh hooks:", err);
    } finally {
      await refresh();
      setRefreshing(false);
    }
  }, [refresh, refreshing]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clear expanded category when it becomes empty after a data refresh
  useEffect(() => {
    if (expandedCategory !== null) {
      const count = clients.filter((c) => getClientStatus(c) === expandedCategory).length;
      if (count === 0) setExpandedCategory(null);
    }
  }, [clients, expandedCategory]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  if (error && clients.length === 0) {
    return (
      <p className="text-center text-xs text-[var(--danger)] py-4">
        Failed to load client status.
      </p>
    );
  }

  const installedClients = clients.filter((c) => c.installed);
  const connected = clients.filter((c) => getClientStatus(c) === "connected");
  const partialSetup = clients.filter((c) => getClientStatus(c) === "partial-setup");
  const noSetup = clients.filter((c) => getClientStatus(c) === "installed");
  const notInstalled = clients.filter((c) => getClientStatus(c) === "missing");

  return (
    <div className="flex flex-col gap-3">
      {/* Summary */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={refreshing}
          onClick={refreshIntegrations}
          title="Re-check hooks and refresh client status"
          className="flex items-center gap-1.5 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/20 px-2 py-1 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
          >
            <path
              fillRule="evenodd"
              d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.681.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-.908l.84.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44.908l-.84-.84v1.456a.75.75 0 0 1-1.5 0V9.342a.75.75 0 0 1 .75-.75h3.182a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-.681.75.75 0 0 1 1.025-.274Z"
              clipRule="evenodd"
            />
          </svg>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {([
          { status: "connected" as ClientStatus, items: connected, label: "connected",
            bg: "bg-emerald-500/10", text: "text-emerald-400",
            activeBorder: "border-emerald-500/40 ring-1 ring-emerald-500/20", show: true },
          { status: "partial-setup" as ClientStatus, items: partialSetup, label: "incomplete",
            bg: "bg-amber-500/10", text: "text-amber-400",
            activeBorder: "border-amber-500/40 ring-1 ring-amber-500/20", show: partialSetup.length > 0 },
          { status: "installed" as ClientStatus, items: noSetup, label: "not set up",
            bg: "bg-red-500/10", text: "text-red-400",
            activeBorder: "border-red-500/40 ring-1 ring-red-500/20", show: noSetup.length > 0 },
          { status: "missing" as ClientStatus, items: notInstalled, label: "not found",
            bg: "bg-gray-500/10", text: "text-gray-400",
            activeBorder: "border-gray-500/40 ring-1 ring-gray-500/20", show: notInstalled.length > 0 },
        ] as const).filter(b => b.show).map((badge) => (
          <button
            key={badge.status}
            type="button"
            onClick={() => badge.items.length > 0 ? setExpandedCategory(expandedCategory === badge.status ? null : badge.status) : undefined}
            className={`flex items-center gap-1.5 rounded-md ${badge.bg} px-2 py-1 transition-all cursor-pointer border ${
              expandedCategory === badge.status ? badge.activeBorder : "border-transparent"
            }`}
          >
            <StatusDot status={badge.status} />
            <span className={`text-[11px] font-medium ${badge.text}`}>
              {badge.items.length} {badge.label}
            </span>
          </button>
        ))}
      </div>

      {/* Expanded category */}
      {expandedCategory && (() => {
        const categoryClients = clients.filter(c => getClientStatus(c) === expandedCategory);
        if (categoryClients.length === 0) return null;
        const colorMap: Record<ClientStatus, string> = {
          connected: "border-emerald-500/20",
          "partial-setup": "border-amber-500/20",
          installed: "border-red-500/20",
          missing: "border-gray-500/20",
        };
        return (
          <div className={`flex flex-col gap-1.5 rounded-lg border ${colorMap[expandedCategory]} bg-[var(--bg-raised)] p-2.5`}>
            {categoryClients.map((client) => (
              <div key={client.id} className="group relative flex items-center gap-3 px-1 py-1">
                <ConditionTooltip client={client} />
                <div className="h-8 w-8 shrink-0">
                  <AppLogo id={client.id} name={client.name} />
                </div>
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  {client.name}
                </span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Client list */}
      <div className="flex flex-col gap-1.5">
        {installedClients.map((client) => {
          const status = getClientStatus(client);

          const statusLabel: Record<ClientStatus, string> = {
            connected: "Connected",
            "partial-setup": "Incomplete",
            installed: "Not Set Up",
            missing: "Not Installed",
          };

          const badgeVariant: Record<ClientStatus, "success" | "warning" | "danger" | "neutral"> = {
            connected: "success",
            "partial-setup": "warning",
            installed: "danger",
            missing: "neutral",
          };

          const borderStyle: Record<ClientStatus, string> = {
            connected: "border-emerald-500/20 bg-emerald-500/5",
            "partial-setup": "border-amber-500/15 bg-amber-500/5",
            installed: "border-red-500/15 bg-red-500/5",
            missing: "border-[var(--border)] bg-[var(--bg-raised)] opacity-60",
          };

          const issueDetail = status === "partial-setup" ? getIssueDetail(client) : null;

          return (
            <div
              key={client.id}
              className={`group relative flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${borderStyle[status]}`}
            >
              <ConditionTooltip client={client} />
              <div className="h-8 w-8 shrink-0">
                <AppLogo id={client.id} name={client.name} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-[var(--text-primary)]">
                  {client.name}
                </span>
                {issueDetail && (
                  <span className="block text-[10px] text-amber-400/70">
                    {issueDetail}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <StatusDot status={status} />
                <Badge variant={badgeVariant[status]} size="sm">
                  {statusLabel[status]}
                </Badge>
              </div>
            </div>
          );
        })}
      </div>

      {clients.length === 0 && (
        <p className="text-center text-xs text-[var(--text-muted)] py-4">
          No MCP clients detected on this machine.
        </p>
      )}
      {clients.length > 0 && installedClients.length === 0 && (
        <p className="text-center text-xs text-[var(--text-muted)] py-4">
          No installed MCP clients found.
        </p>
      )}
    </div>
  );
}
