/**
 * Setup data persistence, URL helpers, debug-env switcher, and server status checks.
 *
 * Extracted from index.ts to keep the main entry point under the 800-line CI limit.
 */

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// ── Dry-run mode ────────────────────────────────────────────────────

/** When true, onboarding runs normally but config files are not written. */
export const DRY_RUN = process.env.EDISON_DRY_RUN === "1";
if (DRY_RUN) console.log("[dry-run] Dry-run mode enabled — config files will not be modified");

// ── Debug environment switcher ───────────────────────────────────────

export const DEBUG_ENV_NAMES = ["demo", "release", "dev"] as const;
export type DebugEnvName = (typeof DEBUG_ENV_NAMES)[number];

/** The environment this binary was compiled for (from VITE_DEPLOY_ENV at build time). */
export function getBuildDefaultEnv(): DebugEnvName | null {
  const is = { get dev() { return !app.isPackaged; } };
  if (is.dev) return "dev";
  const v = import.meta.env.VITE_DEPLOY_ENV as string | undefined;
  if (v === "demo" || v === "release" || v === "dev") return v;
  return null;
}

// "dev" = localhost backend (make dev / make demo_server) + demo Supabase auth
export const DEV_MCP_BASE_URL = "http://localhost:3000";
export const DEV_API_BASE_URL = "http://localhost:3001";

// Per-env default API/MCP URLs for self-serve users (backend_base_url is null).
// Values are injected at build time from frontend-v2/.env.<mode> — do not hardcode here.
export const ENV_API_URL: string = import.meta.env.VITE_API_BASE_URL ?? "";
export const ENV_MCP_URL: string = import.meta.env.VITE_MCP_BASE_URL ?? "";
export const ENV_DOCS_URL: string = import.meta.env.VITE_DOCS_BASE_URL ?? "https://docs.edison.watch";

export function getDebugEnvOverridePath(): string {
  return join(app.getPath("userData"), "edison_debug_env.json");
}

export function getDebugEnvOverride(): DebugEnvName | null {
  try {
    const p = getDebugEnvOverridePath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw) as { env?: string };
    if (data.env === "demo" || data.env === "release" || data.env === "dev") return data.env;
    return null;
  } catch {
    return null;
  }
}

export function setDebugEnvOverride(env: DebugEnvName | null): void {
  try {
    const p = getDebugEnvOverridePath();
    if (env === null) {
      if (existsSync(p)) unlinkSync(p);
      return;
    }
    writeFileSync(p, JSON.stringify({ env }), "utf-8");
  } catch {
    // best effort only
  }
}

// ── Setup data persistence ──────────────────────────────────────────

export interface SetupData {
  completed?: boolean;
  userEmail?: string;
  userId?: string;
  serverAddress?: string;
  mcpBaseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  edisonSecretKey?: string;
}

let setupCompleted: boolean | null = null;

export function getSetupFlagPath(): string {
  return join(app.getPath("userData"), "setup.json");
}

export function getSetupData(): SetupData {
  try {
    const raw = readFileSync(getSetupFlagPath(), "utf-8");
    return JSON.parse(raw) as SetupData;
  } catch {
    return { completed: false };
  }
}

export function isSetupComplete(): boolean {
  if (setupCompleted !== null) return setupCompleted;
  const data = getSetupData();
  setupCompleted = data.completed === true;
  return setupCompleted;
}

export function markSetupComplete(data?: Partial<SetupData>): void {
  const existing = getSetupData();
  const merged: SetupData = { ...existing, ...data, completed: true };
  writeFileSync(getSetupFlagPath(), JSON.stringify(merged, null, 2), "utf-8");
  setupCompleted = true;
  app.setLoginItemSettings({ openAtLogin: true });
}

export function markSetupIncomplete(): void {
  writeFileSync(getSetupFlagPath(), JSON.stringify({ completed: false }), "utf-8");
  setupCompleted = false;
  app.setLoginItemSettings({ openAtLogin: false });
}

// ── URL helpers ─────────────────────────────────────────────────────

export function getActiveEnv(): string {
  return getDebugEnvOverride() ?? getBuildDefaultEnv() ?? "demo";
}

export function getApiBaseUrl(): string | null {
  const activeEnv = getActiveEnv();
  const is = { get dev() { return !app.isPackaged; } };
  if (activeEnv === "dev" || is.dev) return DEV_API_BASE_URL;
  const setupData = getSetupData();
  if (setupData.apiBaseUrl) return setupData.apiBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  // Self-serve: look up default for the active env.
  const url = ENV_API_URL || null;
  if (!url) console.warn(`[getApiBaseUrl] No API URL for env "${activeEnv}".`);
  return url;
}

export function getMcpBaseUrl(): string | null {
  const activeEnv = getActiveEnv();
  const is = { get dev() { return !app.isPackaged; } };
  if (activeEnv === "dev" || is.dev) return DEV_MCP_BASE_URL;
  const setupData = getSetupData();
  if (setupData.mcpBaseUrl) return setupData.mcpBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  // Self-serve: look up default for the active env.
  const url = ENV_MCP_URL || null;
  if (!url) console.warn(`[getMcpBaseUrl] No MCP URL for env "${activeEnv}".`);
  return url;
}

export function getEventsUrl(apiKey: string): string | null {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/events?api_key=${encodeURIComponent(apiKey)}`;
}

export function getApprovalUrl(): string | null {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/approvals/action`;
}

export function getMcpUrl(): string | null {
  const setupData = getSetupData();
  const mcpBaseUrl = getMcpBaseUrl();
  if (mcpBaseUrl && setupData.apiKey) {
    return `${mcpBaseUrl.replace(/\/$/, "")}/mcp/${setupData.apiKey}`;
  }
  return null;
}

export function getMcpConfig(): string | null {
  const url = getMcpUrl();
  if (!url) return null;
  const setupData = getSetupData();
  const args = ["-y", "mcp-remote", url, "--transport", "http"];
  if (setupData.edisonSecretKey) {
    args.push("--header", `X-Edison-Secret-Key:${setupData.edisonSecretKey}`);
  }
  const config = {
    servers: {
      edisonwatch: {
        type: "stdio",
        command: "npx",
        args,
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

// ── Server status checks ────────────────────────────────────────────

let isServerOnline = false;
let serverStatusCheckInterval: ReturnType<typeof setInterval> | null = null;

export function getIsServerOnline(): boolean {
  return isServerOnline;
}

export async function checkServerStatus(): Promise<boolean> {
  try {
    const mcpUrl = getMcpBaseUrl();
    if (!mcpUrl) return false;

    const healthUrl = `${mcpUrl.replace(/\/$/, "")}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  } catch {
    return false;
  }
}

export function startServerStatusChecks(onStatusChange: () => void): void {
  checkServerStatus().then((status) => {
    isServerOnline = status;
    onStatusChange();
  });

  if (serverStatusCheckInterval) clearInterval(serverStatusCheckInterval);
  serverStatusCheckInterval = setInterval(async () => {
    const status = await checkServerStatus();
    if (status !== isServerOnline) {
      isServerOnline = status;
      onStatusChange();
    }
  }, 30000);
}

export function stopServerStatusChecks(): void {
  if (serverStatusCheckInterval) {
    clearInterval(serverStatusCheckInterval);
    serverStatusCheckInterval = null;
  }
}

