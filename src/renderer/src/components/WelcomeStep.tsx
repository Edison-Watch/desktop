import { useState } from "react";
import { Button, Input, Badge } from "@edison/shared/ui";
import type { AuthState } from "../hooks/useAuth";

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
      <div className="flex flex-col gap-6">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-dim)] text-sm font-medium text-[var(--accent)]">
              {auth.email[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-[var(--text-primary)]">{auth.email}</p>
              <p className="text-xs text-[var(--text-muted)]">Authenticated</p>
            </div>
            <Badge variant={auth.serverStatus === "online" ? "success" : auth.serverStatus === "checking" ? "info" : "danger"}>
              {auth.serverStatus === "online" ? "Connected" : auth.serverStatus === "checking" ? "Checking..." : "Offline"}
            </Badge>
          </div>
        </div>

        <Button variant="primary" onClick={onNext} className="w-full">
          Continue
        </Button>
      </div>
    );
  }

  // Sign-in form
  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Sign in to Edison Watch</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Connect your account to get started.
        </p>
      </div>

      {auth.error && (
        <div className="rounded-md bg-[var(--danger)]/10 px-4 py-3 text-sm text-[var(--danger)]">
          {auth.error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          type="text"
          label="Email"
          placeholder="you@company.com"
          value={email}
          onChange={handleEmailChange}
          disabled={auth.loading}
        />

        {authMode === "password" && !auth.ssoOnly && (
          <Input
            type="password"
            label="Password"
            placeholder="Enter your password"
            value={password}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
            disabled={auth.loading}
          />
        )}

        <Button
          type="submit"
          variant="primary"
          loading={auth.loading}
          disabled={!email}
          className="w-full"
        >
          {authMode === "sso" || auth.ssoOnly ? "Sign in with SSO" : "Sign in"}
        </Button>
      </form>

      {!auth.ssoOnly && (
        <div className="flex flex-col items-center gap-3">
          <div className="flex w-full items-center gap-3">
            <div className="h-px flex-1 bg-[var(--border)]" />
            <span className="text-xs text-[var(--text-muted)]">or</span>
            <div className="h-px flex-1 bg-[var(--border)]" />
          </div>

          <Button
            variant="secondary"
            onClick={auth.signInWithGoogle}
            disabled={auth.loading}
            className="w-full"
          >
            Sign in with Google
          </Button>

          <button
            type="button"
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            onClick={() => setAuthMode(authMode === "sso" ? "password" : "sso")}
          >
            {authMode === "sso" ? "Use email & password instead" : "Use SSO instead"}
          </button>
        </div>
      )}
    </div>
  );
}
