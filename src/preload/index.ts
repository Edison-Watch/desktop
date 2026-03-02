import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

/**
 * Typed IPC API exposed to the renderer via contextBridge.
 *
 * All main ↔ renderer communication goes through these channels.
 * Extend this as new IPC handlers are added to the main process.
 */
const api = {
  /** Setup wizard lifecycle */
  setup: {
    getData: (): Promise<{ completed?: boolean; [key: string]: unknown }> =>
      ipcRenderer.invoke("setup:getData"),
    complete: (data: Record<string, unknown>): void =>
      ipcRenderer.send("setup:complete", data),
    reachedFinal: (): void => ipcRenderer.send("setup:reached-final"),
    reset: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("setup:reset"),
  },

  /** Authentication */
  auth: {
    openSaml: (url: string): void => ipcRenderer.send("auth:open-saml", url),
    onCallback: (callback: (url: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, url: string): void =>
        callback(url);
      ipcRenderer.on("auth:callback", handler);
      return () => ipcRenderer.removeListener("auth:callback", handler);
    },
    getDevCallbackUrl: (): Promise<string | null> =>
      ipcRenderer.invoke("auth:getDevCallbackUrl"),
  },

  /** Server health */
  health: {
    check: (): Promise<boolean> => ipcRenderer.invoke("menu:check-health"),
  },

  /** Shell operations */
  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke("shell:openExternal", url),
  },

  /** MCP client discovery and hook management */
  mcp: {
    detectClients: (): Promise<Array<{ id: string; name: string; configPath: string }>> =>
      ipcRenderer.invoke("mcp:detectClients"),
    discover: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:discover"),
    readConfig: (configPath: string): Promise<string | null> =>
      ipcRenderer.invoke("mcp:readConfig", configPath),
    applyAppIntegrations: (args: {
      serverAddress: string;
      mcpBaseUrl: string;
      apiKey: string;
      edisonSecretKey?: string;
      apps: string[];
    }): Promise<{ success: boolean; modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }> }> =>
      ipcRenderer.invoke("mcp:applyAppIntegrations", args),
    revertAppIntegrations: (args: {
      configs: Array<{ configPath: string; backupPath: string }>;
    }): Promise<{ reverted: number; errors: string[] }> =>
      ipcRenderer.invoke("mcp:revertAppIntegrations", args),
    submitAllDiscovered: (params?: {
      apiKey?: string;
      apiBaseUrl?: string;
      userId?: string;
    }): Promise<{
      submitted: number;
      autoApproved: number;
      skipped: number;
      total: number;
      error?: string;
      errors?: string[];
    }> => ipcRenderer.invoke("mcp:submitAllDiscovered", params),
    injectHooks: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:injectHooks"),
    removeHooks: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:removeHooks"),
    getHookStatus: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:getHookStatus"),
  },

  /** Config: effective base URLs (respects debug env override) */
  config: {
    getEffectiveBaseUrls: (): Promise<{ mcpBaseUrl: string | null; apiBaseUrl: string | null }> =>
      ipcRenderer.invoke("config:getEffectiveBaseUrls"),
  },

  /** App version */
  getVersion: (): string => electronAPI.process.versions.electron ?? "",
} as const;

export type EdisonAPI = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error window augmentation
  window.electron = electronAPI;
  // @ts-expect-error window augmentation
  window.api = api;
}
