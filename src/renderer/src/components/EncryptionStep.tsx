import { useState, useCallback } from "react";
import { Button, Card, Input } from "@edison/shared/ui";
import {
  hashSecretKey,
  buildCompositeKey,
  cacheSecretKey,
} from "@edison/shared/crypto";
import { AGENT_REGISTRY, type AgentId } from "@edison/shared/agent-registry";
import type { ModifiedConfig, DiscoveredServer, RemovalTarget } from "./AppsStep";
import { AppLogo } from "./AppLogo";
import EncryptionAnimation from "./EncryptionAnimation";
import KeyEncryptionAnimation from "./KeyEncryptionAnimation";
import PersonalKeyCard from "./PersonalKeyCard";
import CredentialReviewCard from "./CredentialReviewCard";
import type { TemplateOverrideEntry } from "./CredentialReviewCard";
import ScanResultsPanel from "./ScanResultsPanel";
import type { ScanResult } from "./ScanResultsPanel";

interface EncryptionStepProps {
  mcpBaseUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  userId: string;
  selectedApps: string[];
  discoveredServers: DiscoveredServer[];
  serversToRemove?: RemovalTarget[];
  skipServers?: string[];
  autoQuarantine?: boolean;
  onNext: (compositeKey: string, modifiedConfigs: ModifiedConfig[]) => void;
}

function CheckCircle({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${className}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  );
}

export default function EncryptionStep({
  mcpBaseUrl,
  apiBaseUrl,
  apiKey,
  userId,
  selectedApps,
  discoveredServers,
  serversToRemove = [],
  skipServers = [],
  autoQuarantine = false,
  onNext,
}: EncryptionStepProps): React.ReactNode {
  // Render-time tracer so we can confirm the component is actually mounting.
  // If this line never appears in DevTools console, the running build doesn't
  // include these changes (clean rebuild needed) or DevTools is closed.
  console.log("[EncryptionStep] render");

  // Progressive reveal: 0=personal key, 1=org key, 2=register servers
  const [currentSubStep, setCurrentSubStep] = useState(0);

  // Personal-key state. The interactive UI + lifecycle live in PersonalKeyCard;
  // here we only retain the materialized values we need for the org-key + scan
  // sub-steps that follow.
  const [rawPersonalKey, setRawPersonalKey] = useState("");
  const [compositeKey, setCompositeKey] = useState("");

  // Org key state
  const [orgKey, setOrgKey] = useState("");
  const [orgKeySaved, setOrgKeySaved] = useState(false);
  const [, setOrgKeySkipped] = useState(false);
  const [orgKeySaving, setOrgKeySaving] = useState(false);
  const [orgKeyError, setOrgKeyError] = useState("");

  // Scan & submit state
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [resubmitting, setResubmitting] = useState<string | null>(null);

  const [scanError, setScanError] = useState("");

  // Skip warning state
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  // Credential review state
  const [savedTemplates, setSavedTemplates] = useState<Record<string, TemplateOverrideEntry[]> | null>(null);
  const [templatesSaved, setTemplatesSaved] = useState(false);

  const handleTemplateSave = useCallback((overrides: Record<string, TemplateOverrideEntry[]>) => {
    setSavedTemplates(overrides);
    setTemplatesSaved(true);
  }, []);

  const handleTemplateCancel = useCallback(() => {
    setTemplatesSaved(false);
  }, []);

  // Apply state
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");

  const visibleServers = discoveredServers.filter(
    (s) => !skipServers.includes(s.name)
  );

  // ── Org key handlers ──

  const handleSaveOrgKey = async () => {
    const trimmedOrg = orgKey.trim();
    if (!trimmedOrg) return;

    setOrgKeySaving(true);
    setOrgKeyError("");
    try {
      const userKeyHash = await hashSecretKey(rawPersonalKey);
      const domainKeyHash = await hashSecretKey(trimmedOrg);
      const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/register`;
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_key_hash: userKeyHash, domain_key_hash: domainKeyHash }),
      });
      if (!res.ok) {
        setOrgKeyError("Organisation key was not accepted. Check with your admin that this is the correct key.");
        return;
      }
      const key = buildCompositeKey(rawPersonalKey, trimmedOrg);
      cacheSecretKey(key);
      setCompositeKey(key);
      setOrgKeySaved(true);
      setCurrentSubStep(2);
    } catch (err) {
      setOrgKeyError(err instanceof Error ? err.message : "Failed to save organisation key");
    } finally {
      setOrgKeySaving(false);
    }
  };

  const handleSkipOrgKey = () => {
    setOrgKeySkipped(true);
    setCurrentSubStep(2);
  };

  // ── Server submission handlers ──

  const handleScanAndSubmit = async () => {
    setScanning(true);
    setScanResult(null);
    setScanError("");
    try {
      const result = savedTemplates
        ? await window.api.mcp.submitWithTemplates({
            apiKey,
            apiBaseUrl,
            userId,
            skipServers,
            templateOverrides: savedTemplates,
          })
        : await window.api.mcp.submitAllDiscovered({
            apiKey,
            apiBaseUrl,
            userId,
            skipServers,
          });
      if (serversToRemove.length > 0) {
        try {
          await window.api.mcp.removeServers(serversToRemove);
        } catch {
          console.error("[EncryptionStep] Failed to remove resolved duplicate servers");
        }
      }
      setScanResult(result);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Failed to register servers. Please try again.");
    } finally {
      setScanning(false);
    }
  };

  const handleResubmit = async (originalName: string, newName: string) => {
    const failure = scanResult?.failures?.find((f) => f.name === originalName);
    setResubmitting(originalName);
    try {
      const result = await window.api.mcp.resubmitServer({
        originalName,
        newName,
        apiKey,
        apiBaseUrl,
        userId,
        config: failure?.config,
        client: failure?.client,
        configPath: failure?.configPath,
      });
      if (result.success) {
        setScanResult((prev) => prev ? {
          ...prev,
          submitted: prev.submitted + 1,
          failures: prev.failures?.filter((f) => f.name !== originalName),
        } : prev);
      } else {
        setScanResult((prev) => prev ? {
          ...prev,
          failures: prev.failures?.map((f) =>
            f.name === originalName ? { ...f, message: result.error ?? "Failed" } : f
          ),
        } : prev);
      }
    } catch {
      // resubmit failed
    } finally {
      setResubmitting(null);
    }
  };

  const handleSubmit = async () => {
    setApplying(true);
    setApplyError("");
    try {
      const serverAddress = mcpBaseUrl ? new URL(mcpBaseUrl).host : "";
      const result = await window.api.mcp.applyAppIntegrations({
        serverAddress,
        mcpBaseUrl,
        apiKey,
        edisonSecretKey: compositeKey || undefined,
        apps: selectedApps,
      });
      onNext(compositeKey, result.modifiedConfigs);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Failed to apply configuration");
    } finally {
      setApplying(false);
    }
  };

  const getClientName = (clientId: string): string =>
    AGENT_REGISTRY[clientId as AgentId]?.displayName ?? clientId;

  const canProceed = !!scanResult || visibleServers.length === 0;
  // Show bottom button when: servers registered, no servers to register, quarantine off, or scan failed (escape hatch)
  const showBottomButton = canProceed || !autoQuarantine || !!scanError;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Secure Your Setup</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Edison will securely store your MCP server credentials encrypted, using your personal key before adding to the Edison MCP gateway.
        </p>
      </div>

      {currentSubStep < 2 && <KeyEncryptionAnimation />}

      {/* ── Sub-step 1: Personal Key ── */}
      <PersonalKeyCard
        apiBaseUrl={apiBaseUrl}
        apiKey={apiKey}
        done={currentSubStep > 0}
        onReady={(rawKey, composite) => {
          setRawPersonalKey(rawKey);
          setCompositeKey(composite);
          if (currentSubStep < 1) setCurrentSubStep(1);
        }}
      />

      {/* ── Sub-step 2: Organisation Key ── */}
      {currentSubStep >= 1 && (
        <Card>
          {currentSubStep > 1 ? (
            <div className="flex items-center gap-2 text-sm">
              {orgKeySaved ? (
                <>
                  <CheckCircle className="text-emerald-400" />
                  <span className="text-emerald-400">Organisation key saved</span>
                </>
              ) : (
                <>
                  <span className="h-4 w-4 shrink-0 text-center text-xs text-[var(--text-muted)]">-</span>
                  <span className="text-[var(--text-muted)]">Organisation key skipped</span>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  Organisation Key
                  <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">(optional)</span>
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  If your organisation admin provided a shared encryption key, enter it below. If you haven't received one, you can skip this step.
                </p>
                <p className="text-xs text-orange-400/80 mt-1.5">
                  Without this key, you won't be able to use MCP servers that your admin has configured with shared credentials for the organisation.
                </p>
              </div>
              <Input
                type="password"
                placeholder="Paste the key your admin provided"
                value={orgKey}
                onChange={(e) => setOrgKey(e.target.value)}
                autoComplete="off"
              />
              {orgKeyError && (
                <p className="text-xs text-[var(--danger)]">{orgKeyError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={orgKeySaving}
                  disabled={!orgKey.trim()}
                  onClick={handleSaveOrgKey}
                >
                  Save & Continue
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={orgKeySaving}
                  onClick={handleSkipOrgKey}
                >
                  Skip
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {currentSubStep >= 2 && <EncryptionAnimation />}

      {/* ── Sub-step 3: Register Servers ── */}
      {currentSubStep >= 2 && (
        <>
          <Card>
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">Register Your Servers</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {autoQuarantine
                    ? "Your organisation requires all MCP servers to be registered with Edison Watch. Unregistered servers will be quarantined and removed from your configurations."
                    : "Register your servers so Edison Watch can monitor and protect them. You can also do this later from the dashboard."}
                </p>
              </div>

              {/* Server list */}
              {visibleServers.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {visibleServers.map((server) => {
                    const clients = server.clients && server.clients.length > 0
                      ? server.clients
                      : [server.client];
                    return (
                      <div
                        key={server.name}
                        className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] p-3"
                      >
                        <AppLogo id={server.client} name={getClientName(server.client)} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                            {server.name}
                          </p>
                          <p className="text-xs text-[var(--text-muted)] truncate">
                            {clients.map(getClientName).join(", ")}
                          </p>
                        </div>
                        {autoQuarantine && !scanResult && (
                          <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400 border border-orange-500/20">
                            Requires registration
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">No MCP servers discovered.</p>
              )}

              {/* Credential review (nested within server step) */}
              <CredentialReviewCard
                onSave={handleTemplateSave}
                onCancel={handleTemplateCancel}
                saved={templatesSaved}
                skipServers={skipServers}
              />

              {/* Scan results */}
              {scanResult && (
                <ScanResultsPanel
                  scanResult={scanResult}
                  apiBaseUrl={apiBaseUrl}
                  onResubmit={handleResubmit}
                  resubmitting={resubmitting}
                />
              )}

              {/* Scan error */}
              {scanError && (
                <p className="text-xs text-[var(--danger)]">{scanError}</p>
              )}

              {/* Register / skip buttons (before submission) */}
              {!scanResult && visibleServers.length > 0 && (
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleScanAndSubmit}
                    loading={scanning}
                    className="flex-1"
                  >
                    {scanning
                      ? "Registering..."
                      : `Register ${visibleServers.length} Server${visibleServers.length === 1 ? "" : "s"}`}
                  </Button>
                  {!autoQuarantine && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={scanning}
                      onClick={() => setShowSkipWarning(true)}
                    >
                      Skip
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>

          {applyError && (
            <p className="text-sm text-[var(--danger)]">{applyError}</p>
          )}

          {showSkipWarning && (
            <div className="flex flex-col gap-3 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
              <p className="text-xs text-orange-400 leading-relaxed">
                Are you sure you want to continue without registering your servers?
              </p>
              {autoQuarantine && (
                <p className="text-xs text-red-400 leading-relaxed font-medium">
                  Your organisation requires all MCP servers to be protected by Edison Watch. Unregistered servers will be automatically quarantined and removed from your configurations.
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowSkipWarning(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="warning"
                  size="sm"
                  onClick={async () => {
                    setShowSkipWarning(false);
                    if (autoQuarantine) {
                      if (discoveredServers.length > 0) {
                        try {
                          const targets = discoveredServers.map((s) => s.name);
                          await window.api.mcp.removeServers(targets);
                        } catch {
                          console.error("[EncryptionStep] Failed to remove discovered servers before skip");
                        }
                      }
                      if (serversToRemove.length > 0) {
                        try {
                          await window.api.mcp.removeServers(serversToRemove);
                        } catch {
                          console.error("[EncryptionStep] Failed to remove resolved duplicate servers");
                        }
                      }
                    }
                    handleSubmit();
                  }}
                  loading={applying}
                >
                  Continue anyway
                </Button>
              </div>
            </div>
          )}

          {showBottomButton && (
            <Button
              variant="primary"
              onClick={() => {
                if (!canProceed && !showSkipWarning) {
                  setShowSkipWarning(true);
                } else if (!showSkipWarning) {
                  handleSubmit();
                }
              }}
              loading={applying}
              className="w-full"
            >
              {selectedApps.length > 0
                ? `Configure ${selectedApps.length} App${selectedApps.length === 1 ? "" : "s"}`
                : "Continue"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
