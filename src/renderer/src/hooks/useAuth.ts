import { useState, useEffect, useRef, useCallback } from "react";
import { supabase, fetchApiKey } from "@edison/shared/auth";

const DOMAIN_INFO_URL =
  import.meta.env.VITE_DOMAIN_INFO_API_URL || "https://demo-dashboard.edison.watch";

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
};

export default function useAuth() {
  const [state, setState] = useState<AuthState>(initialState);
  const healthInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const domainTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
    const result = await fetchApiKey();
    if (!result) {
      update({ error: "Failed to retrieve API key. Please try again." });
      await supabase.auth.signOut();
      return false;
    }

    const mcpBaseUrl = result.backend_base_url || "";
    const apiBaseUrl = result.backend_base_url || "";

    update({
      apiKey: result.api_key,
      mcpBaseUrl,
      apiBaseUrl,
      signedIn: true,
      loading: false,
      error: "",
    });

    // Start health polling
    checkHealth(mcpBaseUrl);
    if (healthInterval.current) clearInterval(healthInterval.current);
    healthInterval.current = setInterval(() => checkHealth(mcpBaseUrl), 30000);

    // Fetch domain config (auto-quarantine setting)
    try {
      const domainRes = await fetch(
        `${apiBaseUrl.replace(/\/$/, "")}/api/user/domain-config`,
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

  // SSO sign-in
  const signInWithSSO = useCallback(async (email: string) => {
    update({ loading: true, error: "" });
    const domain = email.split("@")[1];

    const { data, error } = await supabase.auth.signInWithSSO({
      domain,
      options: {
        redirectTo: "edison-watch://auth/callback",
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      update({ loading: false, error: error.message });
      return;
    }

    if (data?.url) {
      window.api.shell.openExternal(data.url);
    }
  }, [update]);

  // Google OAuth
  const signInWithGoogle = useCallback(async () => {
    update({ loading: true, error: "" });

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "edison-watch://auth/callback",
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
    }
  }, [update]);

  // Password sign-in
  const signInWithPassword = useCallback(async (email: string, password: string) => {
    update({ loading: true, error: "" });

    // Check SSO-only domain first
    const domain = email.split("@")[1];
    try {
      const res = await fetch(`${DOMAIN_INFO_URL}/api/auth/domain-info?domain=${domain}`);
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

    update({ email, userId: "" });
    const ok = await fetchServerUrls();
    if (!ok) {
      update({ loading: false });
    }
  }, [fetchServerUrls, update]);

  // Check domain for SSO-only (debounced)
  const checkDomain = useCallback((email: string) => {
    if (domainTimeout.current) clearTimeout(domainTimeout.current);
    const domain = email.split("@")[1];
    if (!domain || !domain.includes(".")) return;

    domainTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`${DOMAIN_INFO_URL}/api/auth/domain-info?domain=${domain}`);
        if (res.ok) {
          const info = await res.json();
          update({ ssoOnly: info?.sso_only ?? false });
        }
      } catch {
        // Ignore domain check errors
      }
    }, 400);
  }, [update]);

  // Listen for auth callbacks from main process
  useEffect(() => {
    const unsubscribe = window.api.auth.onCallback(async (url: string) => {
      update({ loading: true, error: "" });

      const normalized = url.replace("edison-watch://", "http://");
      const parsed = new URL(normalized);

      // Check hash first (SAML tokens)
      const hash = parsed.hash.substring(1);
      if (hash) {
        const params = new URLSearchParams(hash);
        const accessToken = params.get("access_token");
        if (accessToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: params.get("refresh_token") || "",
          });
          if (error) {
            update({ loading: false, error: error.message });
            return;
          }
          const { data: { user } } = await supabase.auth.getUser();
          update({ email: user?.email || "", userId: user?.id || "" });
          await fetchServerUrls();
          return;
        }
      }

      // Check code in query (PKCE flow)
      const code = parsed.searchParams.get("code");
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          update({ loading: false, error: error.message });
          return;
        }
        const { data: { user } } = await supabase.auth.getUser();
        update({ email: user?.email || "", userId: user?.id || "" });
        await fetchServerUrls();
        return;
      }

      update({ loading: false, error: "Auth callback did not contain valid credentials." });
    });

    return () => {
      unsubscribe();
      if (healthInterval.current) clearInterval(healthInterval.current);
      if (domainTimeout.current) clearTimeout(domainTimeout.current);
    };
  }, [fetchServerUrls, update]);

  // Restore existing session on mount
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        update({ email: user.email || "", userId: user.id });
        await fetchServerUrls();
      }
    })();
  }, [fetchServerUrls, update]);

  return {
    ...state,
    signInWithSSO,
    signInWithGoogle,
    signInWithPassword,
    checkDomain,
  };
}
