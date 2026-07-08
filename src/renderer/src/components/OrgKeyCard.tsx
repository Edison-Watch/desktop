import { useState } from "react";
import { Button, Card, Input } from "@edison-watch/shared/ui";
import {
  buildCompositeKey,
  parseCompositeKey,
  cacheSecretKey,
} from "@edison-watch/shared/crypto";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      className={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Organisation-key entry for the post-onboarding Config tab.
 *
 * Moved out of the onboarding wizard (EncryptionStep) so the security step
 * stays focused on the personal key + server registration. A user who later
 * receives a shared org key from their admin pastes it here.
 *
 * Flow: reattach the org key to the user's existing personal key, validate the
 * resulting composite against the backend (/secret-key/verify -> domain_valid),
 * persist it to setup.json, and re-apply app integrations so MCP clients send
 * the new X-Edison-Secret-Key header.
 */
interface OrgKeyCardProps {
  /** Raw personal key (user-part) loaded from the OS keychain. */
  personalKey: string | null;
  /** Current composite key from setup.json, used to detect an existing org key. */
  currentComposite?: string;
  onSaved?: (composite: string) => void;
}

function CheckCircle({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 shrink-0 ${className}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
    </svg>
  );
}

/** Extract the user-part from the composite (preferred) or the raw keychain key. */
function resolveUserPart(currentComposite: string | undefined, personalKey: string | null): string | null {
  if (currentComposite) {
    try {
      const userPart = parseCompositeKey(currentComposite).userPart;
      if (userPart) return userPart;
    } catch {
      /* fall through to keychain */
    }
  }
  if (personalKey) {
    if (!personalKey.includes(":")) return personalKey;
    try {
      return parseCompositeKey(personalKey).userPart || personalKey;
    } catch {
      return personalKey;
    }
  }
  return null;
}

/** Whether the current composite already carries an org (admin) segment. */
function hasExistingOrgKey(currentComposite: string | undefined): boolean {
  if (!currentComposite) return false;
  try {
    return !!parseCompositeKey(currentComposite).domainPart;
  } catch {
    return false;
  }
}

export default function OrgKeyCard({
  personalKey,
  currentComposite,
  onSaved,
}: OrgKeyCardProps): React.ReactNode {
  const existing = hasExistingOrgKey(currentComposite);

  const [orgKey, setOrgKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleSave = async () => {
    const trimmed = orgKey.trim();
    if (!trimmed) return;

    const userPart = resolveUserPart(currentComposite, personalKey);
    if (!userPart) {
      setError("Set up your personal key first (tray menu → Update Keys).");
      return;
    }

    setSaving(true);
    setError("");
    setWarning("");
    setSaved(false);
    try {
      const composite = buildCompositeKey(userPart, trimmed);

      // Verify against the active-environment backend (resolved in main, so the
      // request always uses the correct per-env API key).
      const verification = await window.api.secretKey.verify(composite);
      if (!verification.ok) {
        setError("Couldn't verify the key right now. Please try again.");
        return;
      }
      if (verification.valid === false) {
        setError("Your personal key isn't recognized. Re-enter it from the tray menu → Update Keys first.");
        return;
      }
      if (verification.domainValid !== true) {
        setError("Organisation key was not accepted. Check with your admin that this is the correct key.");
        return;
      }

      // Rewrite the MCP client configs FIRST. Only once that succeeds do we
      // persist the composite + mark the key active. Persisting first would
      // leave setup.json claiming an active org key while clients still send
      // the old header if the rewrite fails - and startup self-heal won't fix
      // it because the MCP URL is unchanged. Main resolves the URL/creds/app
      // list (with the ALL_SUPPORTED_APPS fallback).
      let applied = false;
      try {
        const apply = await window.api.mcp.applyForSecretKey(composite);
        applied = apply?.success === true;
      } catch {
        applied = false;
      }

      if (!applied) {
        // Nothing persisted: keep the form open with a warning so the user can
        // retry. The card will not show "active" until configs are rewritten.
        setWarning(
          "Couldn't apply the organisation key to your apps. Make sure Edison Watch can update your client configs, then click Save to retry.",
        );
        return;
      }

      // Configs updated - now persist (persist-only IPC, no setup lifecycle
      // side effects) and mark the key active.
      cacheSecretKey(composite);
      await window.api.setup.update({ edisonSecretKey: composite });
      // Adopt the key into the detector daemon's enrollment (explicit "enroll
      // key" state change). Non-fatal: the org key is already applied to the
      // client configs above; the daemon will re-verify on its next enroll.
      try {
        await window.api.detectord.setSecret(composite);
      } catch (err) {
        console.error("[OrgKeyCard] detectord setSecret failed:", err);
      }

      setSaved(true);
      setEditing(false);
      setExpanded(false);
      setOrgKey("");
      onSaved?.(composite);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save organisation key");
    } finally {
      setSaving(false);
    }
  };

  if (existing && !editing) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle className="text-emerald-400" />
          <span className="flex-1 text-emerald-400">Organisation key active</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setEditing(true); setExpanded(true); setSaved(false); setError(""); setWarning(""); }}
          >
            Replace
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {editing ? "Replace organisation key" : "Organisation Key"}
        </span>
        {!editing && (
          <span className="text-xs font-normal text-[var(--text-muted)]">(optional)</span>
        )}
        <span className="flex-1" />
        <Chevron open={expanded} />
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-[var(--text-muted)]">
            If your admin shared an organisation encryption key, paste it here to use MCP servers set up with shared org credentials.
          </p>
          <Input
            type="password"
            placeholder="Paste the key your admin provided"
            value={orgKey}
            onChange={(e) => { setOrgKey(e.target.value); setError(""); setWarning(""); }}
            autoComplete="off"
          />
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          {warning && <p className="text-xs text-orange-400/90">{warning}</p>}
          {saved && <p className="text-xs text-emerald-400">Organisation key saved.</p>}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!orgKey.trim()}
              onClick={handleSave}
            >
              Save
            </Button>
            {editing && (
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => { setEditing(false); setExpanded(false); setOrgKey(""); setError(""); setWarning(""); }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
