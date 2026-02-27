import { useState, useEffect } from "react";
import { Button, Card, Switch, Badge, Input } from "@edison/shared/ui";

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
  const [applying, setApplying] = useState(false);
  const [edisonSecretKey, setEdisonSecretKey] = useState("");

  // Scan & submit state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    submitted: number;
    autoApproved: number;
    skipped: number;
    total: number;
    error?: string;
    errors?: string[];
  } | null>(null);

  // Detect installed MCP clients on mount
  useEffect(() => {
    (async () => {
      try {
        const detected = await window.api.mcp.detectClients();
        const withState = detected.map((c) => ({
          ...c,
          enabled: true,
          configPreview: null,
          expanded: false,
        }));
        setClients(withState);
      } catch {
        // Discovery failed
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
              curr.map((cc) => (cc.id === id ? { ...cc, configPreview: content } : cc)),
            );
          });
        }
        return { ...c, expanded: !c.expanded };
      }),
    );
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const selectedApps = clients.filter((c) => c.enabled).map((c) => c.id);
      const result = await window.api.mcp.applyAppIntegrations({
        serverAddress: new URL(mcpBaseUrl).host,
        mcpBaseUrl,
        apiKey,
        edisonSecretKey: edisonSecretKey || undefined,
        apps: selectedApps,
      });
      onApplyResult(result.modifiedConfigs, edisonSecretKey);
      onNext();
    } catch {
      // Apply failed
    } finally {
      setApplying(false);
    }
  };

  const handleScanAndSubmit = async () => {
    setScanning(true);
    setScanResult(null);
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
          <p className="py-4 text-center text-sm text-[var(--text-muted)]">
            No MCP clients detected. You can configure them manually later.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {clients.map((client) => (
            <Card key={client.id}>
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--bg-input)] text-sm font-medium text-[var(--text-secondary)]">
                  {client.name[0]}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {client.name}
                    </span>
                    <Badge variant="success" size="sm">Detected</Badge>
                  </div>
                  <p className="text-xs text-[var(--text-muted)] truncate max-w-[220px]">
                    {client.configPath}
                  </p>
                </div>
                <Switch
                  checked={client.enabled}
                  onChange={() => toggleClient(client.id)}
                />
              </div>

              {/* Config preview toggle */}
              <button
                type="button"
                className="mt-2 text-xs text-[var(--accent-muted)] hover:text-[var(--accent)]"
                onClick={() => toggleExpanded(client.id)}
              >
                {client.expanded ? "Hide config" : "Show config"}
              </button>

              {client.expanded && (
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-[var(--bg-input)] p-3 text-xs text-[var(--text-secondary)]">
                  {client.configPreview ?? "Loading..."}
                </pre>
              )}
            </Card>
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
