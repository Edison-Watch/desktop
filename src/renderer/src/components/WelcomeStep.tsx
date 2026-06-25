import { useState } from "react";
import { Button, Input, Badge } from "@edison-watch/shared/ui";
import { supabase } from "@edison-watch/shared/auth";
import { clearCachedSecretKey } from "@edison-watch/shared/crypto";
import PromptInjectionAnimation from "./PromptInjectionAnimation";
import type { AuthState } from "../hooks/useAuth";

function GoogleIcon() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg className="size-5" viewBox="0 0 23 23" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function SSOIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </svg>
  );
}

/** White provider button used for Google / Microsoft OAuth. */
function ProviderButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-center gap-2.5 bg-white text-gray-700 font-medium py-2 px-4 rounded-md border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
    >
      {icon}
      {children}
    </button>
  );
}

/** Red "cancel pending sign-in" button shown while waiting for a browser callback. */
function CancelButton({
  onClick,
  className = "",
  children,
}: {
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-center gap-2.5 bg-[var(--danger)] text-white font-medium py-2 px-4 rounded-md border border-[var(--danger)] hover:opacity-90 transition-opacity text-sm ${className}`}
    >
      {children}
    </button>
  );
}

/** Themed tile used for the SSO and Email options. */
function ChoiceTile({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-center gap-2.5 bg-[var(--bg-overlay)] text-[var(--text-primary)] font-medium py-2 px-4 rounded-md border border-[var(--border)] hover:border-[var(--accent-dim)] hover:bg-[var(--bg-raised)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
    >
      {icon}
      {children}
    </button>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative my-3">
      <div className="absolute inset-0 flex items-center">
        <div className="w-full border-t border-[var(--border)]" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-[var(--bg-raised)] px-2 text-[var(--text-muted)]">{children}</span>
      </div>
    </div>
  );
}

interface WelcomeStepProps {
  auth: AuthState & {
    signInWithSSO: (email: string) => Promise<void>;
    signInWithGoogle: () => Promise<void>;
    signInWithMicrosoft: () => Promise<void>;
    signInWithPassword: (email: string, password: string) => Promise<void>;
    checkDomain: (email: string) => void;
    cancelPendingAuth: () => void;
  };
  onNext: () => void;
}

type View = "select" | "email";

export default function WelcomeStep({ auth, onNext }: WelcomeStepProps): React.ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [view, setView] = useState<View>("select");
  const [ssoExpanded, setSsoExpanded] = useState(false);

  const pendingGoogle = auth.awaitingBrowserCallback && auth.pendingAuthMethod === "google";
  const pendingMicrosoft = auth.awaitingBrowserCallback && auth.pendingAuthMethod === "microsoft";
  const pendingSso = auth.awaitingBrowserCallback && auth.pendingAuthMethod === "sso";

  // Keep the SSO email box open while a SSO flow is pending so the user can cancel it,
  // and force it open for SSO-only domains where SSO is the only path.
  const showSsoBox = ssoExpanded || pendingSso || auth.ssoOnly;

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    auth.checkDomain(value);
  };

  const handleSsoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log("[WelcomeStep] handleSsoSubmit fired");
    if (!email) return;
    await auth.signInWithSSO(email);
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log("[WelcomeStep] handleEmailSubmit fired");
    if (!email) return;
    if (auth.ssoOnly) {
      await auth.signInWithSSO(email);
    } else {
      await auth.signInWithPassword(email, password);
    }
  };

  // Cancel lives in the same form slot as the "Continue with SSO" submit button.
  // Cancelling flips pendingSso, so React re-renders mid-click and morphs this
  // very <button> into type="submit", which then submits the form and re-fires
  // the SSO redirect. preventDefault stops that stray submission.
  const handleCancel = (e: React.MouseEvent) => {
    e.preventDefault();
    auth.cancelPendingAuth();
  };

  const backToSelect = () => {
    setView("select");
    setSsoExpanded(false);
    setPassword("");
  };

  const hero = (
    <>
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Protect your data handled by AI Agents</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          AI agents with access to your tools are vulnerable to prompt injection attacks that can exfiltrate sensitive data. Edison watches your agent actions and analyses each action, to protect your data.
        </p>
      </div>
      <PromptInjectionAnimation />
    </>
  );

  // Signed-in state
  if (auth.signedIn) {
    return (
      <div className="flex flex-col gap-4">
        {hero}
        <div
          className="rounded-lg border border-[var(--border)] overflow-hidden"
          style={{
            borderTopColor: "var(--accent-dim)",
            background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
          }}
        >
          <div className="flex items-center gap-3 px-4 py-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/15 text-xs font-semibold text-[var(--accent)]">
              {auth.email[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate leading-tight">{auth.email}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">Authenticated</p>
            </div>
            <Badge variant={auth.serverStatus === "online" ? "success" : auth.serverStatus === "checking" ? "info" : "danger"}>
              {auth.serverStatus === "online" ? "Connected" : auth.serverStatus === "checking" ? "Checking…" : "Offline"}
            </Badge>
          </div>
        </div>
        <Button variant="primary" onClick={onNext} className="w-full">
          Continue
        </Button>
        <button
          type="button"
          onClick={async () => {
            try {
              await supabase.auth.signOut();
            } catch {
              // best-effort sign-out; always continue to reset
            }
            clearCachedSecretKey();
            await window.api.setup.reset();
            window.location.reload();
          }}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          Use a different account
        </button>
      </div>
    );
  }

  const errorBox = auth.error && (
    <div
      className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg p-3"
      role="alert"
    >
      {auth.error}
    </div>
  );

  // Sign-in form
  return (
    <div className="flex flex-col gap-5">
      {hero}

      <p className="text-center text-xs text-[var(--text-secondary)]">
        {view === "email" ? "Sign in with email and password" : "Choose how you'd like to sign in"}
      </p>

      {/* Card */}
      <div
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] overflow-hidden"
        style={{
          borderTopColor: "var(--accent-dim)",
          background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
        }}
      >
        {/* Step 1: choose a sign-in method */}
        {view === "select" && (
          <div className="px-5 py-5 flex flex-col gap-2.5">
            {/* OAuth providers - hidden when the domain requires SSO */}
            {!auth.ssoOnly && (
              <>
                {/* Google */}
                {pendingGoogle ? (
                  <CancelButton onClick={auth.cancelPendingAuth}>Cancel Google sign-in</CancelButton>
                ) : (
                  <ProviderButton onClick={auth.signInWithGoogle} disabled={auth.loading} icon={<GoogleIcon />}>
                    Sign in with Google
                  </ProviderButton>
                )}

                {/* Microsoft */}
                {pendingMicrosoft ? (
                  <CancelButton onClick={auth.cancelPendingAuth}>Cancel Microsoft sign-in</CancelButton>
                ) : (
                  <ProviderButton onClick={auth.signInWithMicrosoft} disabled={auth.loading} icon={<MicrosoftIcon />}>
                    Sign in with Microsoft
                  </ProviderButton>
                )}
              </>
            )}

            {/* SSO */}
            <ChoiceTile
              onClick={() => setSsoExpanded((v) => !v)}
              disabled={auth.loading && !pendingSso}
              icon={<SSOIcon />}
            >
              Sign in with SSO
            </ChoiceTile>

            {showSsoBox && (
              <form
                onSubmit={handleSsoSubmit}
                className="flex flex-col gap-3 rounded-md border border-[var(--border)] bg-[var(--bg-base)]/40 p-3"
                noValidate
              >
                <div className="relative">
                  <Input
                    type="email"
                    label="Work email"
                    placeholder="you@company.com"
                    autoComplete="email"
                    value={email}
                    onChange={handleEmailChange}
                    disabled={auth.loading}
                    autoFocus
                  />
                  {auth.loading && (
                    <div className="absolute right-2.5 bottom-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                  )}
                </div>
                {pendingSso ? (
                  <Button type="button" variant="danger" onClick={handleCancel} className="w-full">
                    Cancel sign-in
                  </Button>
                ) : (
                  <Button type="submit" variant="primary" disabled={!email || auth.loading} className="w-full">
                    Continue with SSO
                  </Button>
                )}
              </form>
            )}

            {/* Email + password - hidden when the domain requires SSO */}
            {!auth.ssoOnly && (
              <>
                <Divider>or</Divider>

                <ChoiceTile
                  onClick={() => setView("email")}
                  disabled={auth.loading}
                  icon={<MailIcon />}
                >
                  Continue with Email
                </ChoiceTile>
              </>
            )}

            {errorBox}
          </div>
        )}

        {/* Step 2: email / password */}
        {view === "email" && (
          <form onSubmit={handleEmailSubmit} className="px-5 py-5 flex flex-col gap-3" noValidate>
            <div className="relative">
              <Input
                type="email"
                label="Email"
                placeholder="you@company.com"
                autoComplete="email"
                value={email}
                onChange={handleEmailChange}
                disabled={auth.loading}
                autoFocus
              />
              {auth.loading && (
                <div className="absolute right-2.5 bottom-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              )}
            </div>

            {auth.ssoOnly ? (
              <p className="text-xs text-[var(--text-secondary)]">
                Your organization requires SSO sign-in. Continue with SSO using the email above.
              </p>
            ) : (
              <Input
                type="password"
                label="Password"
                placeholder="Enter your password"
                autoComplete="current-password"
                value={password}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                disabled={auth.loading}
              />
            )}

            {errorBox}

            {pendingSso ? (
              <Button type="button" variant="danger" onClick={handleCancel} className="w-full mt-1">
                Cancel sign-in
              </Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!email || auth.loading} className="w-full mt-1">
                {auth.ssoOnly ? "Continue with SSO" : "Sign In"}
              </Button>
            )}

            <button
              type="button"
              onClick={backToSelect}
              disabled={auth.loading}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-50 text-center"
            >
              ← Back to all sign-in options
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
