import { useState, useEffect, useCallback } from "react";
import { Badge } from "@edison/shared/ui";
import { AppLogo } from "./AppLogo";

interface HookStatus {
  client: string;
  installed: boolean;
  hasHook: boolean;
  hookCount: number;
  totalHooks: number;
  mcpConnected: boolean;
  mcpApplicable: boolean;
}

interface ClientInfo {
  id: string;
  name: string;
  installed: boolean;
  hasHook: boolean;
  hookCount: number;
  totalHooks: number;
  mcpConnected: boolean;
  mcpApplicable: boolean;
}

// Map client IDs (from McpClientId) to display names
const CLIENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  windsurf: "Windsurf",
  antigravity: "Gemini CLI",
  codex: "Codex CLI",
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
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
  if (client.hasHook && (!needsMcp || client.mcpConnected)) return "connected";
  if (client.hasHook || client.hookCount > 0 || (needsMcp && client.mcpConnected)) return "partial-setup";
  return "installed";
}

/** Describes what's missing for a partial-setup client. */
function getIssueDetail(client: ClientInfo): string {
  const issues: string[] = [];
  if (client.mcpApplicable && !client.mcpConnected) issues.push("MCP gateway not configured");
  if (!client.hasHook && client.hookCount > 0) {
    issues.push(`${client.hookCount}/${client.totalHooks} hooks installed`);
  } else if (!client.hasHook) {
    issues.push("Hooks not installed");
  }
  return issues.join(" · ");
}

export default function ClientsView(): React.ReactNode {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          mcpApplicable: s.mcpApplicable ?? true,
        })),
      );
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

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
        <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1">
          <StatusDot status="connected" />
          <span className="text-[11px] font-medium text-emerald-400">
            {connected.length} connected
          </span>
        </div>
        {partialSetup.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1">
            <StatusDot status="partial-setup" />
            <span className="text-[11px] font-medium text-amber-400">
              {partialSetup.length} incomplete
            </span>
          </div>
        )}
        {noSetup.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1">
            <StatusDot status="installed" />
            <span className="text-[11px] font-medium text-red-400">
              {noSetup.length} not set up
            </span>
          </div>
        )}
        {notInstalled.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-md bg-gray-500/10 px-2 py-1">
            <StatusDot status="missing" />
            <span className="text-[11px] font-medium text-gray-400">
              {notInstalled.length} not found
            </span>
          </div>
        )}
      </div>

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
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${borderStyle[status]}`}
            >
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
