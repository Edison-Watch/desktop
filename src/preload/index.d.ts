import type { ElectronAPI } from '@electron-toolkit/preload'

import type { SecretOutcome } from '../main/detectord/protocol'
import type { StdiodLoginInput, StdiodResult, StdiodStatus } from '../main/stdiod/types'
import type { UpdateState } from '../main/infra/updateManager'
import type { UpdateSettings } from '../main/infra/updateSettings'

/** Typed IPC API matching the api object in preload/index.ts */
interface EdisonAPI {
  platform: NodeJS.Platform
  setup: {
    getData: () => Promise<{ completed?: boolean; [key: string]: unknown }>
    complete: (data: Record<string, unknown>) => void
    update: (data: Record<string, unknown>) => Promise<{ ok: boolean }>
    reachedFinal: () => void
    reset: () => Promise<{ ok: boolean }>
  }
  secretKey: {
    verify: (key: string) => Promise<{ ok: boolean; valid?: boolean; domainValid?: boolean | null }>
  }
  auth: {
    openSaml: (url: string) => void
    onCallback: (callback: (url: string) => void) => () => void
    getLoopbackUrl: () => Promise<string | null>
    consumePending: () => Promise<string | null>
    clearPending: () => Promise<void>
  }
  health: {
    check: () => Promise<boolean>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  mcp: {
    detectClients: () => Promise<Array<{ id: string; name: string; configPath: string }>>
    discover: () => Promise<{ servers: unknown[]; unsupported: unknown[] }>
    findDuplicates: () => Promise<unknown[]>
    removeServers: (
      targets: Array<string | { name: string; client: string }>
    ) => Promise<{ removed: string[]; errors: string[] }>
    resubmitServer: (params: {
      originalName: string
      newName: string
      apiKey?: string
      apiBaseUrl?: string
      userId?: string
      config?: Record<string, unknown>
      client?: string
      configPath?: string
    }) => Promise<{ success: boolean; error?: string }>
    readConfig: (configPath: string) => Promise<string | null>
    applyAppIntegrations: (args: {
      serverAddress: string
      mcpBaseUrl: string
      apiKey: string
      edisonSecretKey?: string
      apps: string[]
    }) => Promise<{
      success: boolean
      modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }>
    }>
    applyForSecretKey: (edisonSecretKey: string) => Promise<{
      success: boolean
      modifiedConfigs: Array<{ appId: string; configPath: string; backupPath: string }>
    }>
    revertAppIntegrations: (args: {
      configs: Array<{ configPath: string; backupPath: string; appId?: string }>
    }) => Promise<{ reverted: number; errors: string[] }>
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
    }) => Promise<{
      submitted: number
      autoApproved: number
      skipped: number
      alreadyOnBackend: number
      total: number
      servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>
      error?: string
      errors?: string[]
      failures?: Array<{
        name: string
        client: string
        reason: 'conflict' | 'error' | 'already-on-backend'
        message: string
        config?: Record<string, unknown>
        configPath?: string
        backendStatus?: 'registered' | 'requested'
      }>
    }>
    analyzeSecrets: (params?: { skipServers?: string[] }) => Promise<
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
    >
    submitAllDiscovered: (params?: {
      apiKey?: string
      apiBaseUrl?: string
      userId?: string
      skipServers?: string[]
    }) => Promise<{
      submitted: number
      autoApproved: number
      skipped: number
      alreadyOnBackend: number
      total: number
      servers?: Array<{ name: string; client: string; clients?: string[]; source: string }>
      error?: string
      errors?: string[]
      failures?: Array<{
        name: string
        client: string
        reason: 'conflict' | 'error' | 'already-on-backend'
        message: string
        config?: Record<string, unknown>
        configPath?: string
        backendStatus?: 'registered' | 'requested'
      }>
    }>
    getHookStatus: () => Promise<unknown[]>
    injectVsCodeWorkspaceHook: (workspacePath: string) => Promise<boolean>
    removeVsCodeWorkspaceHook: (workspacePath: string) => Promise<boolean>
  }
  config: {
    getEffectiveBaseUrls: () => Promise<{
      mcpBaseUrl: string | null
      apiBaseUrl: string | null
      docsBaseUrl: string
    }>
    getActiveEnv: () => Promise<string>
    onEnvChanged: (callback: (env: string) => void) => () => void
  }
  accounts: {
    list: () => Promise<Array<{ userId: string; userEmail: string; savedAt: string }>>
    switch: (userId: string) => Promise<{ ok: boolean }>
    remove: (userId: string) => Promise<{ ok: boolean }>
  }
  menu: {
    openFeedback: () => Promise<void>
    resizeWindow: (width: number, height: number) => Promise<void>
    getVersion: () => Promise<string>
    getMcpConfig: () => Promise<string | null>
    getMcpUrl: () => Promise<string | null>
    popupApp: () => Promise<void>
  }
  updates: {
    getState: () => Promise<UpdateState>
    check: () => Promise<UpdateState>
    download: () => Promise<void>
    install: () => Promise<void>
    getSettings: () => Promise<UpdateSettings>
    setSettings: (patch: Partial<UpdateSettings>) => Promise<UpdateSettings>
    onStatus: (callback: (state: UpdateState) => void) => () => void
  }
  keychain: {
    save: (plaintext: string) => Promise<{ ok: boolean; error?: string }>
    load: () => Promise<string | null>
    delete: () => Promise<{ ok: boolean }>
  }
  app: {
    clearDataAndRestart: () => Promise<void>
  }
  detectord: {
    enroll: (input: {
      apiUrl?: string
      mcpUrl?: string
      apiKey?: string
      edisonSecretKey?: string
    }) => Promise<{ ok: boolean }>
    setSecret: (key: string) => Promise<{ ok: boolean; outcome?: SecretOutcome; reason?: string }>
    uninstall: (opts?: { purge?: boolean }) => Promise<{ ok: boolean; stdout: string; stderr: string }>
  }
  stdiod: {
    status: () => Promise<StdiodStatus>
    install: () => Promise<StdiodResult>
    login: (input: StdiodLoginInput) => Promise<StdiodResult>
    uninstall: (opts?: { purge?: boolean }) => Promise<StdiodResult>
    reset: (input: StdiodLoginInput) => Promise<StdiodResult>
    getLogPath: () => Promise<string | null>
    onResetting: (callback: () => void) => () => void
    onChanged: (callback: () => void) => () => void
  }
  getVersion: () => string
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: EdisonAPI
  }
}
