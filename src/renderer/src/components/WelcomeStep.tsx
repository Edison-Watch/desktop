import { useState, useEffect, useRef } from "react";
import { Button, Input, Badge } from "@edison/shared/ui";
import { supabase } from "@edison/shared/auth";
import { clearCachedSecretKey } from "@edison/shared/crypto";
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

interface WelcomeStepProps {
  auth: AuthState & {
    signInWithSSO: (email: string) => Promise<void>;
    signInWithGoogle: () => Promise<void>;
    signInWithPassword: (email: string, password: string) => Promise<void>;
    checkDomain: (email: string) => void;
  };
  onNext: () => void;
}

export default function WelcomeStep({ auth, onNext }: WelcomeStepProps): React.ReactNode {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"sso" | "password">("sso");

  // Keep a stable ref to onNext so the timer below isn't reset on every re-render
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;

  // Track whether the user was already signed in when this step mounted.
  // If they navigate back to this step while already signed in, we don't
  // want to auto-advance — they should have to click Continue explicitly.
  const wasSignedInOnMount = useRef(auth.signedIn);

  // Auto-advance to next step shortly after sign-in succeeds.
  // Only fires if the user actually signed in while on this step (not when
  // navigating back while already authenticated).
  useEffect(() => {
    if (!auth.signedIn || wasSignedInOnMount.current) return;
    const timer = setTimeout(() => onNextRef.current(), 1200);
    return () => clearTimeout(timer);
  }, [auth.signedIn]);

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEmail(value);
    auth.checkDomain(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    if (authMode === "sso" || auth.ssoOnly) {
      await auth.signInWithSSO(email);
    } else {
      await auth.signInWithPassword(email, password);
    }
  };

  // Signed-in state
  if (auth.signedIn) {
    return (
      <div className="flex flex-col gap-4">
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

  // Sign-in form
  return (
    <div className="flex flex-col gap-5">
      <p className="text-center text-xs text-[var(--text-secondary)]">
        {authMode === "sso" ? "Sign in with your organization email" : "Sign in with email and password"}
      </p>

      {/* Card */}
      <div
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] overflow-hidden"
        style={{
          borderTopColor: "var(--accent-dim)",
          background: "linear-gradient(180deg, var(--bg-overlay) 0%, var(--bg-raised) 48px)",
        }}
      >
        <form onSubmit={handleSubmit} className="px-5 py-5 flex flex-col gap-3" noValidate>
          <div className="relative">
            <Input
              type="text"
              label="Email"
              placeholder="you@company.com"
              autoComplete="email"
              value={email}
              onChange={handleEmailChange}
              disabled={auth.loading}
            />
            {auth.loading && (
              <div className="absolute right-2.5 bottom-2 h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            )}
          </div>

          {authMode === "password" && !auth.ssoOnly && (
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

          {auth.error && (
            <div
              className="text-xs text-[var(--danger)] bg-[var(--danger)]/10 border border-[var(--danger)]/30 rounded-lg p-3"
              role="alert"
            >
              {auth.error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={!email || auth.loading}
            className="w-full mt-1"
          >
            {authMode === "sso" || auth.ssoOnly ? "Continue with SSO" : "Sign In"}
          </Button>
        </form>

        {/* Google OAuth + mode toggle — hidden when SSO-only */}
        {!auth.ssoOnly && (
          <div className="px-5 pb-5">
            {/* Divider */}
            <div className="relative mb-3">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[var(--border)]" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-[var(--bg-raised)] px-2 text-[var(--text-muted)]">or</span>
              </div>
            </div>

            {/* Google Sign In */}
            <button
              type="button"
              onClick={auth.signInWithGoogle}
              disabled={auth.loading}
              className="w-full flex items-center justify-center gap-2.5 bg-white text-gray-700 font-medium py-2 px-4 rounded-md border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <GoogleIcon />
              Sign in with Google
            </button>

            {/* Toggle auth mode */}
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setAuthMode(authMode === "sso" ? "password" : "sso")}
                disabled={auth.loading}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-50"
              >
                {authMode === "sso" ? "Use email and password instead" : "Use SSO instead"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
