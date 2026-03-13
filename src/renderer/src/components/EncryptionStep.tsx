import { useState } from "react";
import { Button, Card, Input } from "@edison/shared/ui";
import {
  generateSecretKey,
  hashSecretKey,
  buildCompositeKey,
  cacheSecretKey,
} from "@edison/shared/crypto";
import type { ModifiedConfig, DiscoveredServer } from "./AppsStep";

interface EncryptionStepProps {
  mcpBaseUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  userId: string;
  selectedApps: string[];
  discoveredServers: DiscoveredServer[];
  onNext: (compositeKey: string, modifiedConfigs: ModifiedConfig[]) => void;
}

export default function EncryptionStep({
  mcpBaseUrl,
  apiBaseUrl,
  apiKey,
  userId,
  selectedApps,
  discoveredServers,
  onNext,
}: EncryptionStepProps): React.ReactNode {
  // Key state
  const [orgKey, setOrgKey] = useState("");
  const [userKey, setUserKey] = useState("");
  const [userKeyMode, setUserKeyMode] = useState<"none" | "generate" | "existing">("none");
  const [generatedKey, setGeneratedKey] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyRegistering, setKeyRegistering] = useState(false);
  const [keyRegistered, setKeyRegistered] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [compositeKey, setCompositeKey] = useState("");

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

  // Skip warning state
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  // Apply state
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");

  const registerKey = async (rawUserKey: string) => {
    setKeyRegistering(true);
    setKeyError("");
    try {
      const userKeyHash = await hashSecretKey(rawUserKey);
      const trimmedOrgKey = orgKey.trim();
      const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/register`;
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };

      // If org key provided, try with it first
      let usedOrgKey = trimmedOrgKey;
      if (trimmedOrgKey) {
        const domainKeyHash = await hashSecretKey(trimmedOrgKey);
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ user_key_hash: userKeyHash, domain_key_hash: domainKeyHash }),
        });
        if (res.ok) {
          const key = buildCompositeKey(rawUserKey, trimmedOrgKey);
          cacheSecretKey(key);
          setCompositeKey(key);
          setKeyRegistered(true);
          return;
        }
        // If domain key rejected, fall back to personal key only
        const detail = await res.text().catch(() => "");
        console.warn("[EncryptionStep] Org key rejected, registering personal key only:", detail);
        usedOrgKey = "";
      }

      // Register with personal key only
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ user_key_hash: userKeyHash }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Registration failed (${res.status}): ${detail}`);
      }
      const key = buildCompositeKey(rawUserKey, usedOrgKey || null);
      cacheSecretKey(key);
      setCompositeKey(key);
      setKeyRegistered(true);
      if (trimmedOrgKey && !usedOrgKey) {
        setKeyError("Key registered, but the organisation key was not accepted — no domain key is configured for your organisation yet.");
      }
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to register key");
    } finally {
      setKeyRegistering(false);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Encrypt & Submit</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Set up encryption keys and register your MCP servers.
        </p>
      </div>

      {/* Organisation Key */}
      <Card>
        <Input
          type="password"
          label="Organisation Key"
          description="Provided by your admin. Enables decryption of organisation-level credentials shared across your team."
          placeholder="Paste the key your admin provided"
          value={orgKey}
          onChange={(e) => setOrgKey(e.target.value)}
          autoComplete="off"
        />
      </Card>

      {/* Personal Key */}
      <Card>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Personal Key</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Encrypts your personal credentials. Only you will ever see this key.
            </p>
          </div>

          {keyRegistered ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400">
                Key registered successfully. Make sure you saved it in your password manager.
              </div>
              {keyError && (
                <p className="text-xs text-[var(--warning)]">{keyError}</p>
              )}
            </div>
          ) : userKeyMode === "none" ? (
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const key = generateSecretKey();
                  setGeneratedKey(key);
                  setUserKeyMode("generate");
                }}
              >
                Generate New Key
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setUserKeyMode("existing")}
              >
                I Have a Key
              </Button>
            </div>
          ) : userKeyMode === "generate" ? (
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                  Your Generated Key
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input type="password" value={generatedKey} readOnly className="font-mono" />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      await navigator.clipboard.writeText(generatedKey);
                      setKeyCopied(true);
                      setTimeout(() => setKeyCopied(false), 2000);
                    }}
                  >
                    {keyCopied ? "Copied!" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/20">
                <p className="text-[10px] text-[var(--warning)]">
                  Save this key in your password manager now. It will <strong>never be shown again</strong>.
                  If lost, your encrypted credentials cannot be recovered.
                </p>
              </div>
              {keyError && (
                <p className="text-xs text-[var(--danger)]">{keyError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setUserKeyMode("none");
                    setGeneratedKey("");
                    setKeyError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={keyRegistering}
                  onClick={() => registerKey(generatedKey)}
                >
                  OK
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label="Existing Key"
                placeholder="Paste your edison_secret_key"
                value={userKey}
                onChange={(e) => setUserKey(e.target.value)}
              />
              {keyError && (
                <p className="text-xs text-[var(--danger)]">{keyError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setUserKeyMode("none");
                    setUserKey("");
                    setKeyError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={keyRegistering}
                  disabled={!userKey.trim()}
                  onClick={() => registerKey(userKey.trim())}
                >
                  OK
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Register MCP Servers */}
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Register MCP Servers
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {discoveredServers.length > 0
                  ? `${discoveredServers.length} server${discoveredServers.length === 1 ? "" : "s"} discovered. Submit to register with Edison Watch.`
                  : "Submit discovered MCP servers to register them with Edison Watch."}
              </p>
            </div>
            <Button
              variant="warning"
              size="sm"
              onClick={handleScanAndSubmit}
              loading={scanning}
            >
              {scanning ? "Submitting..." : "Submit"}
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

      {showSkipWarning && (
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
          <p className="text-xs text-orange-400">
            Are you sure you want to continue without submitting your servers for approval to be integrated in the Edison Watch platform?
          </p>
          <div className="flex gap-2">
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
              onClick={() => {
                setShowSkipWarning(false);
                handleSubmit();
              }}
              loading={applying}
            >
              Continue anyway
            </Button>
          </div>
        </div>
      )}

      <Button
        variant="primary"
        onClick={() => {
          if (!scanResult) {
            setShowSkipWarning(true);
          } else {
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
    </div>
  );
}
