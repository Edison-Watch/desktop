import { useState, useEffect, useRef, useCallback } from "react";
import { supabase, fetchApiKey } from "@edison/shared/auth";
import { getEnv, STORAGE_KEY } from "@edison/shared/config";

// Sync active env from main process on startup - reload if it differs from localStorage
// so Supabase is initialised with the correct credentials.
(async () => {
  try {
    const activeEnv = await window.api.config.getActiveEnv();
    // "dev" uses demo Supabase - clear any localStorage override so we fall back to build default.
    const normalized = activeEnv === "dev" ? null : activeEnv;
    const current = localStorage.getItem(STORAGE_KEY) ?? null;
    if (current !== normalized) {
      if (normalized) localStorage.setItem(STORAGE_KEY, normalized);
      else localStorage.removeItem(STORAGE_KEY);
      window.location.reload();
    }
  } catch {
    // Not running in Electron - ignore.
  }
})();

// Reload whenever the user switches env via the menu.
try {
  window.api.config.onEnvChanged((envName: string) => {
    const normalized = envName === "dev" ? null : envName;
    if (normalized) localStorage.setItem(STORAGE_KEY, normalized);
    else localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  });
} catch {
  // Not running in Electron - ignore.
}

const DOMAIN_INFO_URL_FALLBACK: string = getEnv().API_BASE_URL;

async function getDomainInfoBaseUrl(): Promise<string> {
  try {
    const effective = await window.api.config.getEffectiveBaseUrls();
    if (effective.apiBaseUrl) return effective.apiBaseUrl;
  } catch {
    // Not available - use fallback
  }
  return DOMAIN_INFO_URL_FALLBACK;
}

export interface AuthState {
  signedIn: boolean;
  email: string;
  userId: string;
  apiKey: string;
  mcpBaseUrl: string;
  apiBaseUrl: string;
  serverStatus: "checking" | "online" | "offline";
  ssoOnly: boolean;
  autoQuarantineOtherMcpServers: boolean;
  loading: boolean;
  error: string;
  /** Informational warning (e.g. duplicate account created for same email). */
  warning: string;
  /** True while we're waiting for an external browser OAuth/SSO callback. */
  awaitingBrowserCallback: boolean;
  /** Which auth method initiated the pending browser flow, if any. */
  pendingAuthMethod: "sso" | "google" | "microsoft" | null;
}

const initialState: AuthState = {
  signedIn: false,
  email: "",
  userId: "",
  apiKey: "",
  mcpBaseUrl: "",
  apiBaseUrl: "",
  serverStatus: "checking",
  ssoOnly: false,
  autoQuarantineOtherMcpServers: false,
  loading: false,
  error: "",
  warning: "",
  awaitingBrowserCallback: false,
  pendingAuthMethod: null,
};

// Timeout before clearing loading if external browser never calls back (5 minutes)
const AUTH_BROWSER_TIMEOUT_MS = 5 * 60 * 1000;

export default function useAuth() {
  const [state, setState] = useState<AuthState>(initialState);
  const healthInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const domainTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const domainAbort = useRef<AbortController | null>(null);
  const authBrowserTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Mirrors the awaitingBrowserCallback state for use inside the long-lived
  // onCallback listener closure (which captures stale state otherwise).
  // Bumped to false on cancel/timeout so late callbacks are ignored.
  const awaitingBrowserCallbackRef = useRef(false);
  // Mirror of state.signedIn + single-flight guard for the onAuthStateChange
  // listener (avoids racing fetchApiKey's getSessionState mutex).
  const signedInRef = useRef(false);
  const completeSignInInFlight = useRef<Promise<boolean> | null>(null);

  const update = useCallback((patch: Partial<AuthState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Check server health
  const checkHealth = useCallback(async (mcpBaseUrl: string) => {
    if (!mcpBaseUrl) {
      update({ serverStatus: "offline" });
      return;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${mcpBaseUrl.replace(/\/$/, "")}/health`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);
      update({ serverStatus: res.ok ? "online" : "offline" });
    } catch {
      update({ serverStatus: "offline" });
    }
  }, [update]);

  // Fetch API key and server URLs after auth
  const fetchServerUrls = useCallback(async () => {
    let result;
    try {
      result = await fetchApiKey();
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "SSO_ONLY_DOMAIN" || e.code === "AUTH_METHOD_MISMATCH") {
        update({
          loading: false,
          ssoOnly: e.code === "SSO_ONLY_DOMAIN",
          error: e.message || "Sign-in method not allowed. Please use your original login method.",
        });
        await supabase.auth.signOut();
        return false;
      }
      update({ loading: false, error: "Failed to retrieve API key. Please try again." });
      await supabase.auth.signOut();
      return false;
    }
    if (!result) {
      update({ loading: false, error: "Failed to retrieve API key. Please try again." });
      await supabase.auth.signOut();
      return false;
    }

    // Get effective URLs from main process (respects debug env override for dev mode)
    const normalizeUrl = (url: string) =>
      url && !/^https?:\/\//i.test(url) ? `https://${url}` : url;
    // backend_base_url is null for self-serve users - main process provides the env default.
    let mcpBaseUrl = normalizeUrl(result.backend_base_url || "");
    let apiBaseUrl = normalizeUrl(result.backend_base_url || "");
    try {
      const effective = await window.api.config.getEffectiveBaseUrls();
      if (effective.mcpBaseUrl) mcpBaseUrl = normalizeUrl(effective.mcpBaseUrl);
      if (effective.apiBaseUrl) apiBaseUrl = normalizeUrl(effective.apiBaseUrl);
    } catch {
      // Not available - use URLs from fetchApiKey
    }
    if (!apiBaseUrl) console.warn("[useAuth] apiBaseUrl is empty after auth - API calls will fail. Check VITE_API_BASE_URL.");
    if (!mcpBaseUrl) console.warn("[useAuth] mcpBaseUrl is empty after auth - MCP health checks will fail. Check VITE_MCP_BASE_URL.");

    update({
      apiKey: result.api_key,
      userId: result.user_id,
      email: result.user_email,
      mcpBaseUrl,
      apiBaseUrl,
      signedIn: true,
      loading: false,
      error: "",
      warning: result.warning || "",
    });

    // Start health polling
    checkHealth(mcpBaseUrl);
    if (healthInterval.current) clearInterval(healthInterval.current);
    healthInterval.current = setInterval(() => checkHealth(mcpBaseUrl), 30000);

    // Fetch domain config (auto-quarantine setting)
    try {
      const domainRes = await fetch(
        `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/domain-config`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${result.api_key}`,
            Accept: "application/json",
          },
        },
      );
      if (domainRes.ok) {
        const domainConfig = await domainRes.json();
        if (typeof domainConfig.auto_quarantine_other_mcp_servers === "boolean") {
          update({ autoQuarantineOtherMcpServers: domainConfig.auto_quarantine_other_mcp_servers });
        }
      }
    } catch (e) {
      console.warn("[useAuth] Failed to fetch domain-config:", e);
    }

    return true;
  }, [checkHealth, update]);

  // Single-flight sign-in completion so the callback handler and onAuthStateChange
  // listener don't race two fetchApiKey() calls into a spurious sign-out.
  const completeSignIn = useCallback((): Promise<boolean> => {
    if (completeSignInInFlight.current) return completeSignInInFlight.current;
    const p = (async () => {
      try {
        return await fetchServerUrls();
      } finally {
        completeSignInInFlight.current = null;
      }
    })();
    completeSignInInFlight.current = p;
    return p;
  }, [fetchServerUrls]);

  // Keep the ref in sync for the long-lived listener closures.
  useEffect(() => {
    signedInRef.current = state.signedIn;
  }, [state.signedIn]);

  // Authoritative completion: finish sign-in whenever Supabase emits SIGNED_IN, so a
  // valid session is never left stuck on the waiting screen (the Windows SSO bug).
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && !signedInRef.current && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        console.log(`[useAuth] onAuthStateChange ${event} -> completing sign-in`);
        void completeSignIn();
      } else if (event === "SIGNED_OUT") {
        signedInRef.current = false;
        update({ signedIn: false, apiKey: "", email: "", userId: "" });
      }
    });
    return () => subscription.unsubscribe();
  }, [completeSignIn, update]);

  // Resolve the OAuth/SSO redirect URL: prefer the loopback 127.0.0.1 callback
  // (dev AND packaged - Chrome won't launch edison-watch:// without a user
  // gesture), falling back to the custom protocol only if the loopback server
  // didn't start. See login_sso_chrome_issue.md.
  const getRedirectTo = useCallback(async (): Promise<string> => {
    try {
      const loopbackUrl = await window.api.auth.getLoopbackUrl();
      if (loopbackUrl) return loopbackUrl;
    } catch {
      // Loopback server not available - fall through to the protocol handler.
    }
    return "edison-watch://auth/callback";
  }, []);

  // Start a timeout that clears loading if external browser never calls back
  const startAuthBrowserTimeout = useCallback(() => {
    if (authBrowserTimeout.current) clearTimeout(authBrowserTimeout.current);
    authBrowserTimeout.current = setTimeout(() => {
      awaitingBrowserCallbackRef.current = false;
      update({
        loading: false,
        awaitingBrowserCallback: false,
        pendingAuthMethod: null,
        error: "Authentication timed out. Please try again.",
      });
    }, AUTH_BROWSER_TIMEOUT_MS);
  }, [update]);

  const clearAuthBrowserTimeout = useCallback(() => {
    if (authBrowserTimeout.current) {
      clearTimeout(authBrowserTimeout.current);
      authBrowserTimeout.current = undefined;
    }
  }, []);

  // Let the user cancel a pending OAuth/SSO flow (e.g. they dismissed the browser)
  const cancelPendingAuth = useCallback(() => {
    console.log(
      `[useAuth] cancelPendingAuth (was awaiting=${awaitingBrowserCallbackRef.current})`,
    );
    clearAuthBrowserTimeout();
    awaitingBrowserCallbackRef.current = false;
    // Discard any session a racing callback established, so Cancel truly cancels
    // (not let onAuthStateChange complete it).
    void supabase.auth.signOut();
    // Drop any callback main buffered, so a late callback can't be replayed via
    // consumePending / re-pushed on reload after the user cancelled.
    void window.api.auth.clearPending();
    update({
      loading: false,
      error: "",
      awaitingBrowserCallback: false,
      pendingAuthMethod: null,
    });
  }, [clearAuthBrowserTimeout, update]);

  // SSO sign-in
  const signInWithSSO = useCallback(async (email: string) => {
    update({ loading: true, error: "" });
    const domain = email.split("@")[1];
    if (!domain) {
      update({ loading: false, error: "Invalid email address" });
      return;
    }
    const redirectTo = await getRedirectTo();

    const { data, error } = await supabase.auth.signInWithSSO({
      domain,
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      update({ loading: false, error: error.message });
      return;
    }

    if (data?.url) {
      console.log(`[useAuth] signInWithSSO -> opening browser for domain=${domain}`);
      window.api.shell.openExternal(data.url);
      awaitingBrowserCallbackRef.current = true;
      update({ awaitingBrowserCallback: true, pendingAuthMethod: "sso" });
      startAuthBrowserTimeout();
    }
  }, [getRedirectTo, startAuthBrowserTimeout, update]);

  // Google OAuth
  const signInWithGoogle = useCallback(async () => {
    update({ loading: true, error: "" });
    const redirectTo = await getRedirectTo();

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });

    if (error) {
      update({ loading: false, error: error.message });
      return;
    }

    if (data?.url) {
      window.api.shell.openExternal(data.url);
      awaitingBrowserCallbackRef.current = true;
      update({ awaitingBrowserCallback: true, pendingAuthMethod: "google" });
      startAuthBrowserTimeout();
    }
  }, [getRedirectTo, startAuthBrowserTimeout, update]);

  // Microsoft (Azure AD) OAuth
  const signInWithMicrosoft = useCallback(async () => {
    update({ loading: true, error: "" });
    const redirectTo = await getRedirectTo();

    // `email` scope is required by Supabase; `offline_access` returns a refresh token.
    // `prompt: select_account` forces Azure's account picker every time, even with
    // a live session. That click is the transient user activation Chrome requires
    // before it will launch the edison-watch:// callback (gesture-less redirects to
    // custom protocols are silently blocked). See login_sso_chrome_issue.md.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "azure",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
        scopes: "email offline_access",
        queryParams: { prompt: "select_account" },
      },
    });

    if (error) {
      update({ loading: false, error: error.message });
      return;
    }

    if (data?.url) {
      window.api.shell.openExternal(data.url);
      awaitingBrowserCallbackRef.current = true;
      update({ awaitingBrowserCallback: true, pendingAuthMethod: "microsoft" });
      startAuthBrowserTimeout();
    }
  }, [getRedirectTo, startAuthBrowserTimeout, update]);

  // Password sign-in
  const signInWithPassword = useCallback(async (email: string, password: string) => {
    update({ loading: true, error: "" });

    // Check SSO-only domain first
    const domain = email.split("@")[1];
    try {
      const domainInfoBase = await getDomainInfoBaseUrl();
      const res = await fetch(`${domainInfoBase}/api/auth/domain-info?domain=${domain}`);
      if (res.ok) {
        const info = await res.json();
        if (info?.sso_only) {
          update({ loading: false, ssoOnly: true, error: "Your organization requires SSO login." });
          return;
        }
      }
    } catch {
      // Domain check failed, proceed with password
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      update({ loading: false, error: error.message });
      return;
    }

    update({ email });
    const ok = await completeSignIn();
    if (!ok) {
      update({ loading: false });
    }
  }, [completeSignIn, update]);

  // Check domain for SSO-only (debounced)
  const checkDomain = useCallback((email: string) => {
    if (domainTimeout.current) clearTimeout(domainTimeout.current);
    domainAbort.current?.abort();
    const domain = email.split("@")[1];
    if (!domain || !domain.includes(".")) return;

    domainTimeout.current = setTimeout(async () => {
      const controller = new AbortController();
      domainAbort.current = controller;
      try {
        const domainInfoBase = await getDomainInfoBaseUrl();
        const res = await fetch(`${domainInfoBase}/api/auth/domain-info?domain=${domain}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const info = await res.json();
          update({ ssoOnly: info?.sso_only ?? false });
        }
      } catch {
        // Ignore domain check errors (including AbortError)
      }
    }, 400);
  }, [update]);

  // Listen for auth callbacks from main process
  useEffect(() => {
    // De-dupe: main may both push and (via the mount pull) hand us the same URL.
    let lastHandledUrl: string | null = null;

    const handleAuthCallback = async (url: string, viaPull: boolean): Promise<void> => {
      console.log(
        `[useAuth] auth callback (viaPull=${viaPull}, awaiting=${awaitingBrowserCallbackRef.current})`,
      );
      if (url === lastHandledUrl) {
        console.log("[useAuth] duplicate auth callback ignored");
        return;
      }
      // Pushed callbacks honour the awaiting gate; pulled (buffered protocol)
      // callbacks are always processed (cold start).
      if (!viaPull && !awaitingBrowserCallbackRef.current) {
        console.log("[useAuth] auth callback ignored (no flow awaiting)");
        return;
      }
      lastHandledUrl = url;
      awaitingBrowserCallbackRef.current = false;
      clearAuthBrowserTimeout();
      update({
        loading: true,
        error: "",
        awaitingBrowserCallback: false,
        pendingAuthMethod: null,
      });

      const normalized = url.replace("edison-watch://", "http://");
      const parsed = new URL(normalized);

      // Helper to set session from access+refresh tokens
      const setSessionFromTokens = async (accessToken: string, refreshToken: string): Promise<boolean> => {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          console.error("[useAuth] setSession failed:", error.message);
          update({ loading: false, error: error.message });
          return false;
        }
        const { data: { user } } = await supabase.auth.getUser();
        update({ email: user?.email || "", userId: user?.id || "" });
        const ok = await completeSignIn();
        if (!ok) update({ loading: false });
        return ok;
      };

      // 1. Tokens forwarded as query params by the dev auth server (from_hash=1 case)
      const accessTokenInQuery = parsed.searchParams.get("access_token");
      if (accessTokenInQuery) {
        await setSessionFromTokens(
          accessTokenInQuery,
          parsed.searchParams.get("refresh_token") || "",
        );
        return;
      }

      // 2. Tokens in URL hash (direct SAML/OAuth deep link via protocol handler)
      const hash = parsed.hash.substring(1);
      if (hash) {
        const params = new URLSearchParams(hash);
        const accessToken = params.get("access_token");
        if (accessToken) {
          await setSessionFromTokens(accessToken, params.get("refresh_token") || "");
          return;
        }
      }

      // 3. Authorization code (PKCE flow)
      const code = parsed.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          console.error("[useAuth] exchangeCodeForSession failed:", error.message);
          update({ loading: false, error: error.message });
          return;
        }
        const { data: { user } } = await supabase.auth.getUser();
        update({ email: user?.email || "", userId: user?.id || "" });
        const ok = await completeSignIn();
        if (!ok) update({ loading: false });
        return;
      }

      console.error("[useAuth] auth callback had no credentials:", parsed.search, parsed.hash);
      update({ loading: false, error: "Auth callback did not contain valid credentials." });
    };

    const unsubscribe = window.api.auth.onCallback((url: string) => {
      void handleAuthCallback(url, false);
    });

    // Claim any callback main buffered before this listener was live (cold start / race).
    window.api.auth
      .consumePending()
      .then((url) => {
        if (url) void handleAuthCallback(url, true);
      })
      .catch(() => {});

    return () => {
      unsubscribe();
      clearAuthBrowserTimeout();
      if (healthInterval.current) clearInterval(healthInterval.current);
      if (domainTimeout.current) clearTimeout(domainTimeout.current);
      domainAbort.current?.abort();
    };
  }, [clearAuthBrowserTimeout, completeSignIn, update]);

  // Restore existing session on mount
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        update({ email: user.email || "", userId: user.id });
        await completeSignIn();
      }
    })();
  }, [completeSignIn, update]);

  return {
    ...state,
    signInWithSSO,
    signInWithGoogle,
    signInWithMicrosoft,
    signInWithPassword,
    checkDomain,
    cancelPendingAuth,
  };
}
