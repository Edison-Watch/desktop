import { useEffect, useState } from "react";

interface UpdateSettings {
  autoDownload: boolean;
  autoInstallOnQuit: boolean;
}

/** Compact toggle row reused for both update preferences. */
function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className="flex w-full items-start justify-between gap-3 text-left disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
        <span className="block text-[11px] text-[var(--text-muted)]">{hint}</span>
      </span>
      <span
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? "bg-[var(--accent)]" : "bg-[var(--bg-input)]"
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-white transition-transform ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

/** Settings card (Config tab) for auto-update preferences. */
export default function UpdateSettingsCard(): React.ReactNode {
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    window.api.updates.getSettings().then((s) => {
      if (mounted) setSettings(s as UpdateSettings);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const update = async (patch: Partial<UpdateSettings>) => {
    setSaving(true);
    try {
      const next = await window.api.updates.setSettings(patch);
      setSettings(next as UpdateSettings);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
      <span className="text-xs font-semibold text-[var(--text-secondary)]">Updates</span>
      <ToggleRow
        label="Download updates automatically"
        hint="Fetch new versions in the background as they appear."
        checked={settings.autoDownload}
        disabled={saving}
        onChange={(next) => update({ autoDownload: next })}
      />
      <ToggleRow
        label="Install on quit"
        hint="Apply a downloaded update the next time the app restarts."
        checked={settings.autoInstallOnQuit}
        disabled={saving}
        onChange={(next) => update({ autoInstallOnQuit: next })}
      />
    </div>
  );
}
