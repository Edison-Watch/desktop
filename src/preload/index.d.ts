import type { ElectronAPI } from "@electron-toolkit/preload";

/** Typed IPC API matching the api object in preload/index.ts */
interface EdisonAPI {
  setup: {
    getData: () => Promise<{ completed?: boolean; [key: string]: unknown }>;
    complete: (data: Record<string, unknown>) => void;
    reachedFinal: () => void;
    reset: () => Promise<{ ok: boolean }>;
  };
  auth: {
    openSaml: (url: string) => void;
    onCallback: (callback: (url: string) => void) => () => void;
    getDevCallbackUrl: () => Promise<string | null>;
  };
  health: {
    check: () => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  mcp: {
    detectClients: () => Promise<Array<{ id: string; name: string; configPath: string }>>;
    discover: () => Promise<{ servers: unknown[]; unsupported: unknown[] }>;
    findDuplicates: () => Promise<unknown[]>;
    removeServers: (targets: Array<string | { name: string; client: string }>) => Promise<{ removed: string[]; errors: string[] }>;
    resubmitServer: (params: { originalName: string; newName: string; apiKey?: string; apiBaseUrl?: string; userId?: string; config?: Record<string, unknown>; client?: string; configPath?: string }) => Promise<{ success: boolean; error?: string }>;
    readConfig: (configPath: string) => Promise<string | null>;
    applyAppIntegrations: (args: {
      serverAddress: string;
      mcpBaseUrl: string;
      apiKey: string;
      edisonSecretKey?: string;
      apps: string[];
    }) => Promise<{ success: boolean; modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }> }>;
    revertAppIntegrations: (args: {
      configs: Array<{ configPath: string; backupPath: string; appId?: string }>;
    }) => Promise<{ reverted: number; errors: string[] }>;
    submitWithTemplates: (params: {
      apiKey?: string;
      apiBaseUrl?: string;
      userId?: string;
      skipServers?: string[];
      templateOverrides: Record<string, Array<{
        entryId: string;
        varName: string;
        selectedText: string;
        start: number;
        end: number;
      }>>;
    }) => Promise<{
      submitted: number;
      autoApproved: number;
      skipped: number;
      alreadyOnBackend: number;
      total: number;
      servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
      error?: string;
      errors?: string[];
      failures?: Array<{ name: string; client: string; reason: "conflict" | "error" | "already-on-backend"; message: string; config?: Record<string, unknown>; configPath?: string; backendStatus?: "registered" | "requested" }>;
    }>;
    analyzeSecrets: (params?: { skipServers?: string[] }) => Promise<Array<{
      name: string;
      client: string;
      source: string;
      config: Record<string, unknown>;
      templatized: {
        config: Record<string, unknown>;
        templateFields: Record<string, Record<string, { description: string; example: string }>>;
        secretValues: Record<string, string>;
      };
    }>>;
    submitAllDiscovered: (params?: {
      apiKey?: string;
      apiBaseUrl?: string;
      userId?: string;
      skipServers?: string[];
    }) => Promise<{
      submitted: number;
      autoApproved: number;
      skipped: number;
      alreadyOnBackend: number;
      total: number;
      servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>;
      error?: string;
      errors?: string[];
      failures?: Array<{ name: string; client: string; reason: "conflict" | "error" | "already-on-backend"; message: string; config?: Record<string, unknown>; configPath?: string; backendStatus?: "registered" | "requested" }>;
    }>;
    injectHooks: () => Promise<unknown[]>;
    removeHooks: () => Promise<unknown[]>;
    getHookStatus: () => Promise<unknown[]>;
    injectVsCodeWorkspaceHook: (workspacePath: string) => Promise<boolean>;
    removeVsCodeWorkspaceHook: (workspacePath: string) => Promise<boolean>;
  };
  config: {
    getEffectiveBaseUrls: () => Promise<{ mcpBaseUrl: string | null; apiBaseUrl: string | null; docsBaseUrl: string }>;
    getActiveEnv: () => Promise<string>;
    onEnvChanged: (callback: (env: string) => void) => () => void;
  };
  accounts: {
    list: () => Promise<Array<{ userId: string; userEmail: string; savedAt: string }>>;
    switch: (userId: string) => Promise<{ ok: boolean }>;
    remove: (userId: string) => Promise<{ ok: boolean }>;
  };
  menu: {
    openFeedback: () => Promise<void>;
    resizeWindow: (width: number, height: number) => Promise<void>;
    getVersion: () => Promise<string>;
    getMcpConfig: () => Promise<string | null>;
    getMcpUrl: () => Promise<string | null>;
  };
  keychain: {
    save: (plaintext: string) => Promise<{ ok: boolean; error?: string }>;
    load: () => Promise<string | null>;
    delete: () => Promise<{ ok: boolean }>;
  };
  app: {
    clearDataAndRestart: () => Promise<void>;
  };
  getVersion: () => string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: EdisonAPI;
  }
}
