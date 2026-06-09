import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { StdiodLoginInput, StdiodResult, StdiodStatus } from '../main/stdiod/types'

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
      ipcRenderer.invoke('setup:getData'),
    complete: (data: Record<string, unknown>): void => ipcRenderer.send('setup:complete', data),
    update: (data: Record<string, unknown>): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('setup:update', data),
    reachedFinal: (): void => ipcRenderer.send('setup:reached-final'),
    reset: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('setup:reset')
  },

  /** Secret-key operations resolved against the active environment in main. */
  secretKey: {
    verify: (
      key: string
    ): Promise<{ ok: boolean; valid?: boolean; domainValid?: boolean | null }> =>
      ipcRenderer.invoke('secretKey:verify', { key })
  },

  /** Authentication */
  auth: {
    openSaml: (url: string): void => ipcRenderer.send('auth:open-saml', url),
    onCallback: (callback: (url: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, url: string): void => callback(url)
      ipcRenderer.on('auth:callback', handler)
      return () => ipcRenderer.removeListener('auth:callback', handler)
    },
    getDevCallbackUrl: (): Promise<string | null> => ipcRenderer.invoke('auth:getDevCallbackUrl')
  },

  /** Server health */
  health: {
    check: (): Promise<boolean> => ipcRenderer.invoke('menu:check-health')
  },

  /** Shell operations */
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },

  /** MCP client discovery and hook management */
  mcp: {
    detectClients: (): Promise<Array<{ id: string; name: string; configPath: string }>> =>
      ipcRenderer.invoke('mcp:detectClients'),
    discover: (): Promise<{ servers: unknown[]; unsupported: unknown[] }> =>
      ipcRenderer.invoke('mcp:discover'),
    findDuplicates: (): Promise<unknown[]> => ipcRenderer.invoke('mcp:findDuplicates'),
    removeServers: (
      targets: Array<string | { name: string; client: string }>
    ): Promise<{ removed: string[]; errors: string[] }> =>
      ipcRenderer.invoke('mcp:removeServers', targets),
    resubmitServer: (params: {
      originalName: string
      newName: string
      apiKey?: string
      apiBaseUrl?: string
      userId?: string
      config?: Record<string, unknown>
      client?: string
      configPath?: string
    }): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:resubmitServer', params),
    readConfig: (configPath: string): Promise<string | null> =>
      ipcRenderer.invoke('mcp:readConfig', configPath),
    applyAppIntegrations: (args: {
      serverAddress: string
      mcpBaseUrl: string
      apiKey: string
      edisonSecretKey?: string
      apps: string[]
    }): Promise<{
      success: boolean
      modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }>
    }> => ipcRenderer.invoke('mcp:applyAppIntegrations', args),
    applyForSecretKey: (
      edisonSecretKey: string
    ): Promise<{
      success: boolean
      modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }>
    }> => ipcRenderer.invoke('mcp:applyForSecretKey', { edisonSecretKey }),
    revertAppIntegrations: (args: {
      configs: Array<{ configPath: string; backupPath: string; appId?: string }>
    }): Promise<{ reverted: number; errors: string[] }> =>
      ipcRenderer.invoke('mcp:revertAppIntegrations', args),
    submitWithTemplates: (params: {
      apiKey?: string
      apiBaseUrl?: string
      userId?: string
      skipServers?: string[]
      templateOverrides: Record<
        string,
        Array<{
          entryId: string
          varName: string
          selectedText: string
          start: number
          end: number
        }>
      >
    }): Promise<{
      submitted: number
      autoApproved: number
      skipped: number
      total: number
      servers?: Array<{ name: string; client: string; source: string }>
      error?: string
      errors?: string[]
    }> => ipcRenderer.invoke('mcp:submitWithTemplates', params),
    analyzeSecrets: (params?: {
      skipServers?: string[]
    }): Promise<
      Array<{
        name: string
        client: string
        source: string
        config: Record<string, unknown>
        templatized: {
          config: Record<string, unknown>
          templateFields: Record<string, Record<string, { description: string; example: string }>>
          secretValues: Record<string, string>
        }
      }>
    > => ipcRenderer.invoke('mcp:analyzeSecrets', params),
    submitAllDiscovered: (params?: {
      apiKey?: string
      apiBaseUrl?: string
      userId?: string
      skipServers?: string[]
    }): Promise<{
      submitted: number
      autoApproved: number
      skipped: number
      total: number
      servers?: Array<{ name: string; client: string; source: string }>
      error?: string
      errors?: string[]
    }> => ipcRenderer.invoke('mcp:submitAllDiscovered', params),
    injectHooks: (): Promise<unknown[]> => ipcRenderer.invoke('mcp:injectHooks'),
    removeHooks: (): Promise<unknown[]> => ipcRenderer.invoke('mcp:removeHooks'),
    getHookStatus: (): Promise<unknown[]> => ipcRenderer.invoke('mcp:getHookStatus'),
    injectVsCodeWorkspaceHook: (workspacePath: string): Promise<boolean> =>
      ipcRenderer.invoke('mcp:injectVsCodeWorkspaceHook', workspacePath),
    removeVsCodeWorkspaceHook: (workspacePath: string): Promise<boolean> =>
      ipcRenderer.invoke('mcp:removeVsCodeWorkspaceHook', workspacePath)
  },

  /** Config: effective base URLs and active env (respects debug env override) */
  config: {
    getEffectiveBaseUrls: (): Promise<{
      mcpBaseUrl: string | null
      apiBaseUrl: string | null
      docsBaseUrl: string
    }> => ipcRenderer.invoke('config:getEffectiveBaseUrls'),
    getActiveEnv: (): Promise<string> => ipcRenderer.invoke('config:getActiveEnv'),
    onEnvChanged: (callback: (env: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, env: string): void => callback(env)
      ipcRenderer.on('env:changed', handler)
      return () => ipcRenderer.removeListener('env:changed', handler)
    }
  },

  /** Multi-account management */
  accounts: {
    list: (): Promise<Array<{ userId: string; userEmail: string; savedAt: string }>> =>
      ipcRenderer.invoke('accounts:list'),
    switch: (userId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('accounts:switch', userId),
    remove: (userId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('accounts:remove', userId)
  },

  /** Menu actions (post-setup window) */
  menu: {
    openFeedback: (): Promise<void> => ipcRenderer.invoke('menu:openFeedback'),
    resizeWindow: (width: number, height: number): Promise<void> =>
      ipcRenderer.invoke('menu:resizeWindow', width, height),
    getVersion: (): Promise<string> => ipcRenderer.invoke('menu:getVersion'),
    getMcpConfig: (): Promise<string | null> => ipcRenderer.invoke('menu:getMcpConfig'),
    getMcpUrl: (): Promise<string | null> => ipcRenderer.invoke('menu:getMcpUrl')
  },

  /** OS keychain (safeStorage) - store/load the personal encryption key */
  keychain: {
    save: (plaintext: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('keychain:save', plaintext),
    load: (): Promise<string | null> => ipcRenderer.invoke('keychain:load'),
    delete: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('keychain:delete')
  },

  /** Developer: clear all app data and relaunch */
  app: {
    clearDataAndRestart: (): Promise<void> => ipcRenderer.invoke('app:clearDataAndRestart')
  },

  /** Bundled edison-stdiod daemon (stdio MCP tunnel) */
  stdiod: {
    status: (): Promise<StdiodStatus> => ipcRenderer.invoke('stdiod:status'),
    install: (): Promise<StdiodResult> => ipcRenderer.invoke('stdiod:install'),
    login: (input: StdiodLoginInput): Promise<StdiodResult> =>
      ipcRenderer.invoke('stdiod:login', input),
    uninstall: (opts?: { purge?: boolean }): Promise<StdiodResult> =>
      ipcRenderer.invoke('stdiod:uninstall', opts),
    reset: (input: StdiodLoginInput): Promise<StdiodResult> =>
      ipcRenderer.invoke('stdiod:reset', input),
    getLogPath: (): Promise<string | null> => ipcRenderer.invoke('stdiod:getLogPath'),
    // Fired by the main process when a tray/menu-initiated reset starts, so
    // an open config card can show a "Resetting…" state instead of relying
    // on its 3s status poll (which misses the fast off→on transition).
    onResetting: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('stdiod:resetting', handler)
      return () => ipcRenderer.removeListener('stdiod:resetting', handler)
    },
    // Fired when the main process has mutated daemon state (e.g. a reset
    // finished, or it reconnected) so the card should refresh immediately.
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('stdiod:changed', handler)
      return () => ipcRenderer.removeListener('stdiod:changed', handler)
    }
  },

  /** App version */
  getVersion: (): string => electronAPI.process.versions.electron ?? ''
} as const

export type EdisonAPI = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error window augmentation
  window.electron = electronAPI
  // @ts-expect-error window augmentation
  window.api = api
}
