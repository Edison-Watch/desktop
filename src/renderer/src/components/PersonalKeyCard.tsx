import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input } from "@edison-watch/shared/ui";
import {
  generateSecretKey,
  hashSecretKey,
  buildCompositeKey,
  cacheSecretKey,
  parseCompositeKey,
} from "@edison-watch/shared/crypto";

/**
 * Personal-key sub-step of the onboarding wizard.
 *
 * Owns the entire "do you have a key, paste it; otherwise generate one"
 * dance, including:
 *   - Probing /user/settings for an existing backend key.
 *   - Loading the OS keychain and verifying its contents against the
 *     backend hash so a stale local copy doesn't sneak in.
 *   - Registering the key with the backend.
 *   - Saving to keychain.
 *
 * Calls `onReady(rawPersonalKey, compositeKey)` exactly once when the key is
 * confirmed valid; the parent then advances the wizard.
 *
 * Extracted from EncryptionStep.tsx to keep that file under the 800-line
 * CI cap. Symmetric to the dashboard's PersonalKeySection.tsx in the
 * frontend, though their concerns differ (dashboard has roll/reset modals).
 */
interface PersonalKeyCardProps {
  apiBaseUrl: string;
  apiKey: string;
  /** True once the parent has accepted the ready key and moved to the next sub-step. */
  done: boolean;
  onReady: (rawPersonalKey: string, compositeKey: string) => void;
}

function CheckCircle({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${className}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  );
}

export default function PersonalKeyCard({
  apiBaseUrl,
  apiKey,
  done,
  onReady,
}: PersonalKeyCardProps): React.ReactNode {
  // userKeyMode: "loading" → "generate" | "existing-required" | "existing-optional" | "error"
  // See parent comments for the security model: never auto-generate while we
  // don't yet know whether the backend already has a key. The "error" mode
  // covers transport failures and non-2xx responses to /user/settings - we
  // can't tell from those whether a key exists, so we keep all interactive
  // controls inert and offer a Retry button.
  const [userKeyMode, setUserKeyMode] = useState<
    "loading" | "generate" | "existing-optional" | "existing-required" | "error"
  >("loading");
  const [initError, setInitError] = useState("");
  const [userKey, setUserKey] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [compositeKey, setCompositeKey] = useState("");
  const [keychainSaved, setKeychainSaved] = useState(false);
  const [keychainSaving, setKeychainSaving] = useState(false);
  const [keyRegistering, setKeyRegistering] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyError, setKeyError] = useState("");

  // Reset flow: when the user clicks "Reset key" we don't ditch the
  // existing-required input outright (they might just have mis-clicked); we
  // show a confirmation panel that explains what reset actually does
  // (delete personal credentials) and gates it behind a checkbox.
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Tracer so we can confirm the component is actually mounting in DevTools.
  console.log("[PersonalKeyCard] render");

  // On mount: check whether a key already exists on the backend, THEN decide
  // whether to generate a new one. We deliberately don't generate up front:
  // the previous flow showed "Save & Continue" with a freshly-minted key
  // before the async check landed, and a quick click would POST that hash to
  // /secret-key/register and silently overwrite the user's real key, making
  // every credential previously encrypted with the original key unreadable.
  //
  // The same hazard applies to anything-but-a-clean-200: a 500 / DNS error /
  // CORS rejection used to leak through to "generate" mode (because we
  // defaulted hasBackendKey to false on those branches). Now we treat any
  // non-authoritative answer as "we don't know" and route to the error
  // mode, which keeps all destructive controls inert and offers a Retry.
  const runInit = useCallback(async () => {
    console.log(`[PersonalKeyCard] init: GET ${apiBaseUrl}/api/v1/user/settings`);
    setInitError("");
    setUserKeyMode("loading");
    let hasBackendKey: boolean;
    try {
      const res = await fetch(
        `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/settings`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) {
        console.warn(`[PersonalKeyCard] /user/settings returned ${res.status}`);
        setInitError(
          `Couldn't check key status (HTTP ${res.status}). Retry to continue - ` +
            "we won't generate or overwrite a key while the answer is unknown.",
        );
        setUserKeyMode("error");
        return;
      }
      const data = (await res.json()) as { has_secret_key?: boolean };
      hasBackendKey = !!data.has_secret_key;
      console.log(`[PersonalKeyCard] /user/settings → has_secret_key=${hasBackendKey}`);
    } catch (err) {
      console.warn("[PersonalKeyCard] /user/settings failed (transport):", err);
      const msg = err instanceof Error ? err.message : String(err);
      setInitError(
        `Couldn't reach the backend (${msg}). Retry to continue - we won't ` +
          "generate or overwrite a key while the answer is unknown.",
      );
      setUserKeyMode("error");
      return;
    }

    if (!hasBackendKey) {
      console.log("[PersonalKeyCard] no backend key; entering generate mode");
      setUserKeyMode("generate");
      setGeneratedKey(generateSecretKey());
      return;
    }

      // Backend has a registered key. Try to load it from the OS keychain so
      // the user doesn't have to paste it; otherwise force "existing-required"
      // so they have to supply it.
      //
      // The keychain entry can be stale: if the user reset their personal key
      // from the dashboard while this client was closed, the keychain still
      // holds the old key but the backend hash is now a new one. Trusting the
      // keychain blindly would render the "Personal key saved to Keychain"
      // badge while the key is actually wrong - and every subsequent
      // encrypt/decrypt would fail. Verify against the backend before we
      // commit. Treat a network/transport error as "trust the keychain"
      // because failing closed there would lock users out on a transient
      // outage; only a definitive `valid:false` flips us to "existing-required".
      const rawStored = await window.api.keychain.load();
      if (!rawStored) {
        console.log("[PersonalKeyCard] keychain empty; backend has key → existing-required mode");
        setUserKeyMode("existing-required");
        return;
      }
      // Defensive: older builds (or a user paste-mistake) may have stored a
      // composite "user:KEY" string in the keychain. The keychain should only
      // ever hold the raw user-part. Strip the prefix so downstream
      // hash/encrypt paths see the canonical form.
      const stored = rawStored.includes(":")
        ? parseCompositeKey(rawStored).userPart || rawStored
        : rawStored;
      if (stored !== rawStored) {
        console.log(
          `[PersonalKeyCard] keychain held composite-format key; using user-part only ` +
            `(was len=${rawStored.length}, now len=${stored.length})`,
        );
      }
      console.log(
        `[PersonalKeyCard] keychain hit (key length=${stored.length}); verifying against backend...`,
      );

      // Direct fetch with absolute URL: the shared verifySecretKey hardcodes a
      // relative "/api/v1/..." path, which the dashboard frontend is happy with
      // (it's served from http://...) but the packaged Electron renderer
      // resolves to file:///api/v1/... and dies with ERR_FILE_NOT_FOUND.
      const composite = buildCompositeKey(stored, null);
      let stillValid = true;
      let verifyOutcome: "valid" | "invalid" | "network-error" = "valid";
      try {
        const verifyUrl = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/verify`;
        const verifyRes = await fetch(verifyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ key: composite }),
        });
        if (!verifyRes.ok) {
          throw new Error(`HTTP ${verifyRes.status}`);
        }
        const data = (await verifyRes.json()) as {
          valid?: boolean;
          expired?: boolean;
          expires_at?: string | null;
        };
        stillValid = data.valid === true;
        verifyOutcome = stillValid ? "valid" : "invalid";
        console.log(
          `[PersonalKeyCard] /secret-key/verify → valid=${data.valid} ` +
            `expired=${data.expired} expires_at=${data.expires_at ?? "null"}`,
        );
      } catch (err) {
        stillValid = true;
        verifyOutcome = "network-error";
        console.warn("[PersonalKeyCard] /secret-key/verify failed (transport):", err);
      }

      if (!stillValid) {
        console.warn(
          "[PersonalKeyCard] keychain key is stale (backend says invalid); " +
            "deleting keychain entry and switching to existing-required",
        );
        try { await window.api.keychain.delete(); } catch (err) {
          console.warn("[PersonalKeyCard] keychain.delete failed:", err);
        }
        setUserKeyMode("existing-required");
        setKeyError(
          "The personal key saved to your Keychain no longer matches the one registered for your account. " +
            "It was probably reset elsewhere - paste the new key to continue.",
        );
        return;
      }

      console.log(
        `[PersonalKeyCard] keychain key accepted (verify=${verifyOutcome}); advancing`,
      );
      cacheSecretKey(composite);
      setCompositeKey(composite);
      setKeychainSaved(true);
      onReady(stored, composite);
  // onReady is supplied by the parent and stable across renders in practice;
  // include apiBaseUrl/apiKey so a credential change forces a re-init.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, apiKey]);

  useEffect(() => {
    void runInit();
  }, [runInit]);

  const handleSaveAndRegister = async (input: string) => {
    setKeychainSaving(true);
    setKeyRegistering(true);
    setKeyError("");
    try {
      // Normalize the input: if the user pasted a composite key from the
      // dashboard ("user:KEY" or "user:KEY.admin:OTHER"), strip down to the
      // raw user-part. The keychain, the hash we register, and the saved
      // state must all hold the bare user-part - never the composite.
      const userPart = input.includes(":")
        ? parseCompositeKey(input).userPart || input
        : input;
      if (userPart !== input) {
        console.log(
          "[PersonalKeyCard] input was composite-form; using user-part only " +
            `(len ${input.length} → ${userPart.length})`,
        );
      }

      const userKeyHash = await hashSecretKey(userPart);
      const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/register`;
      const hdrs = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const res = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify({ user_key_hash: userKeyHash }) });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Registration failed (${res.status}): ${detail}`);
      }

      const composite = buildCompositeKey(userPart, null);
      cacheSecretKey(composite);
      setCompositeKey(composite);

      // Save to keychain after successful registration. ALWAYS the raw
      // user-part - the keychain holds only the user-part by contract.
      try {
        const result = await window.api.keychain.save(userPart);
        if (result.ok) {
          setKeychainSaved(true);
        } else {
          setKeyError("Key registered, but could not save to Keychain. Make sure you back up your key.");
        }
      } catch {
        setKeyError("Key registered, but could not save to Keychain. Make sure you back up your key.");
      }

      onReady(userPart, composite);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to register key");
    } finally {
      setKeychainSaving(false);
      setKeyRegistering(false);
    }
  };

  /**
   * Reset the user's personal encryption key.
   *
   * Mints a fresh key, POSTs to /user/secret-key/reset (which deletes every
   * `set_by_user=true` template value for this user, since they're encrypted
   * under the old key and can't be recovered), updates the keychain entry,
   * and advances. Symmetric with the dashboard's reset flow in
   * SecretKeyModal.tsx.
   */
  const handleReset = async () => {
    if (!resetConfirmed) return;
    setResetting(true);
    setKeyError("");
    try {
      const newKey = generateSecretKey();
      const newKeyHash = await hashSecretKey(newKey);
      const url = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/reset`;
      console.log(
        `[PersonalKeyCard] POST ${url} new_key_hash=${newKeyHash.slice(0, 8)}... ` +
          `(hash length=${newKeyHash.length})`,
      );
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ new_key_hash: newKeyHash, confirm: true }),
      });
      console.log(`[PersonalKeyCard] /secret-key/reset → ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Reset failed (${res.status}): ${detail}`);
      }
      const data = (await res.json()) as {
        deleted?: number;
        success?: boolean;
        expires_at?: string | null;
      };
      console.log(
        `[PersonalKeyCard] reset response body: success=${data.success} ` +
          `deleted=${data.deleted ?? 0} expires_at=${data.expires_at ?? "null"}`,
      );

      // Save the new key everywhere the old one might have been.
      const composite = buildCompositeKey(newKey, null);
      cacheSecretKey(composite);
      setCompositeKey(composite);
      setGeneratedKey(newKey);
      try {
        const result = await window.api.keychain.save(newKey);
        if (result.ok) setKeychainSaved(true);
      } catch { /* non-fatal */ }

      onReady(newKey, composite);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to reset key");
      // Stay on the confirm screen so the user can read the error.
      setResetting(false);
      return;
    }
    setResetting(false);
    setResetConfirming(false);
    setResetConfirmed(false);
  };

  return (
    <Card>
      {done ? (
        <div className="group flex items-center gap-2 text-sm text-emerald-400">
          <CheckCircle />
          <span className="flex-1">
            {keychainSaved ? "Personal key saved to Keychain" : "Personal key registered"}
          </span>
          {compositeKey && (
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              onClick={async () => {
                await navigator.clipboard.writeText(compositeKey);
                setKeyCopied(true);
                setTimeout(() => setKeyCopied(false), 2000);
              }}
              title="Copy key"
            >
              {keyCopied ? (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                  <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
                </svg>
              )}
            </button>
          )}
          {keyError && (
            <p className="text-xs text-orange-400 mt-1">{keyError}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Personal Encryption Key</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Edison encrypts your credentials with a personal key that only you control. We never store or see this key.
            </p>
          </div>

          {userKeyMode === "loading" && (
            <div className="flex items-center gap-2 py-2 text-xs text-[var(--text-muted)]">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              Checking your account...
            </div>
          )}

          {userKeyMode === "error" && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2 text-xs text-[var(--text-secondary)]">
                {initError || "Couldn't check key status. Retry to continue."}
              </div>
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={() => void runInit()}>
                  Retry
                </Button>
              </div>
            </div>
          )}

          {userKeyMode === "generate" && (
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1.5">
                  Your Personal Key
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
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
              <p className="text-xs text-[var(--text-muted)]">
                Back up this key in your password manager - it cannot be recovered if lost.
              </p>
              {keyError && (
                <p className="text-xs text-[var(--danger)]">{keyError}</p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={keychainSaving || keyRegistering}
                  onClick={() => handleSaveAndRegister(generatedKey)}
                  className="flex-1"
                >
                  Save & Continue
                </Button>
                <button
                  type="button"
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  disabled={keychainSaving || keyRegistering}
                  onClick={() => setUserKeyMode("existing-optional")}
                >
                  I already have a key
                </button>
              </div>
            </div>
          )}

          {(userKeyMode === "existing-required" || userKeyMode === "existing-optional") && !resetConfirming && (
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
              <div className="flex items-center gap-2">
                {userKeyMode === "existing-required" && (
                  // Escape hatch when the user has lost their key. We don't
                  // show this in "generate" or "existing-optional" because in
                  // those flows there's nothing to reset. The actual reset is
                  // gated by an explicit "I understand" checkbox below.
                  <button
                    type="button"
                    className="text-xs text-[var(--danger)] hover:underline transition-colors"
                    disabled={keychainSaving || keyRegistering}
                    onClick={() => {
                      setKeyError("");
                      setResetConfirmed(false);
                      setResetConfirming(true);
                    }}
                  >
                    Reset key
                  </button>
                )}
                <div className="flex-1" />
                {userKeyMode === "existing-optional" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setUserKeyMode("generate");
                      setUserKey("");
                      setKeyError("");
                    }}
                  >
                    Back
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  loading={keychainSaving || keyRegistering}
                  disabled={!userKey.trim()}
                  onClick={() => handleSaveAndRegister(userKey.trim())}
                >
                  Save & Continue
                </Button>
              </div>
            </div>
          )}

          {resetConfirming && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2 text-xs text-[var(--text-secondary)] space-y-1">
                <p className="text-[var(--danger)] font-medium">This action is irreversible.</p>
                <p>
                  All your{" "}
                  <span className="text-[var(--text-primary)] font-medium">personal</span> MCP
                  server credentials (encrypted under your old key) will be{" "}
                  <span className="text-[var(--text-primary)] font-medium">permanently deleted</span>.
                  A new key will be generated and saved to your Keychain.
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={resetConfirmed}
                  onChange={(e) => setResetConfirmed(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-[var(--border)] bg-[var(--bg-input)] text-[var(--danger)] focus:ring-2 focus:ring-[var(--danger)]"
                />
                <span>
                  I understand that resetting this key will delete all my personal MCP server credentials.
                </span>
              </label>
              {keyError && (
                <p className="text-xs text-[var(--danger)]">{keyError}</p>
              )}
              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={resetting}
                  onClick={() => {
                    setResetConfirming(false);
                    setResetConfirmed(false);
                    setKeyError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={resetting}
                  disabled={!resetConfirmed}
                  onClick={handleReset}
                >
                  Reset Key & Delete Personal Secrets
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
