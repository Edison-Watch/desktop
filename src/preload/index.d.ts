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
    discover: () => Promise<unknown[]>;
    readConfig: (configPath: string) => Promise<string | null>;
    applyAppIntegrations: (args: {
      serverAddress: string;
      mcpBaseUrl: string;
      apiKey: string;
      edisonSecretKey?: string;
      apps: string[];
    }) => Promise<{ success: boolean; modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }> }>;
    revertAppIntegrations: (args: {
      configs: Array<{ configPath: string; backupPath: string }>;
    }) => Promise<{ reverted: number; errors: string[] }>;
    submitAllDiscovered: (params?: {
      apiKey?: string;
      apiBaseUrl?: string;
      userId?: string;
    }) => Promise<{
      submitted: number;
      autoApproved: number;
      skipped: number;
      total: number;
      error?: string;
      errors?: string[];
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
  menu: {
    openFeedback: () => Promise<void>;
    resizeWindow: (width: number, height: number) => Promise<void>;
    getVersion: () => Promise<string>;
    getMcpConfig: () => Promise<string | null>;
    getMcpUrl: () => Promise<string | null>;
  };
  getVersion: () => string;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    api: EdisonAPI;
  }
}
