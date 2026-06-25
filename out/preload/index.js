"use strict";
const electron = require("electron");
const electronAPI = {
  ipcRenderer: {
    send(channel, ...args) {
      electron.ipcRenderer.send(channel, ...args);
    },
    sendTo(webContentsId, channel, ...args) {
      const electronVer = process.versions.electron;
      const electronMajorVer = electronVer ? parseInt(electronVer.split(".")[0]) : 0;
      if (electronMajorVer >= 28) {
        throw new Error('"sendTo" method has been removed since Electron 28.');
      } else {
        electron.ipcRenderer.sendTo(webContentsId, channel, ...args);
      }
    },
    sendSync(channel, ...args) {
      return electron.ipcRenderer.sendSync(channel, ...args);
    },
    sendToHost(channel, ...args) {
      electron.ipcRenderer.sendToHost(channel, ...args);
    },
    postMessage(channel, message, transfer) {
      electron.ipcRenderer.postMessage(channel, message, transfer);
    },
    invoke(channel, ...args) {
      return electron.ipcRenderer.invoke(channel, ...args);
    },
    on(channel, listener) {
      electron.ipcRenderer.on(channel, listener);
      return () => {
        electron.ipcRenderer.removeListener(channel, listener);
      };
    },
    once(channel, listener) {
      electron.ipcRenderer.once(channel, listener);
      return () => {
        electron.ipcRenderer.removeListener(channel, listener);
      };
    },
    removeListener(channel, listener) {
      electron.ipcRenderer.removeListener(channel, listener);
      return this;
    },
    removeAllListeners(channel) {
      electron.ipcRenderer.removeAllListeners(channel);
    }
  },
  webFrame: {
    insertCSS(css) {
      return electron.webFrame.insertCSS(css);
    },
    setZoomFactor(factor) {
      if (typeof factor === "number" && factor > 0) {
        electron.webFrame.setZoomFactor(factor);
      }
    },
    setZoomLevel(level) {
      if (typeof level === "number") {
        electron.webFrame.setZoomLevel(level);
      }
    }
  },
  webUtils: {
    getPathForFile(file) {
      return electron.webUtils.getPathForFile(file);
    }
  },
  process: {
    get platform() {
      return process.platform;
    },
    get versions() {
      return process.versions;
    },
    get env() {
      return { ...process.env };
    }
  }
};
const api = {
  /** Host platform, e.g. 'win32' | 'darwin' | 'linux'. */
  platform: process.platform,
  /** Setup wizard lifecycle */
  setup: {
    getData: () => electron.ipcRenderer.invoke("setup:getData"),
    complete: (data) => electron.ipcRenderer.send("setup:complete", data),
    update: (data) => electron.ipcRenderer.invoke("setup:update", data),
    reachedFinal: () => electron.ipcRenderer.send("setup:reached-final"),
    reset: () => electron.ipcRenderer.invoke("setup:reset")
  },
  /** Secret-key operations resolved against the active environment in main. */
  secretKey: {
    verify: (key) => electron.ipcRenderer.invoke("secretKey:verify", { key })
  },
  /** Authentication */
  auth: {
    openSaml: (url) => electron.ipcRenderer.send("auth:open-saml", url),
    onCallback: (callback) => {
      const handler = (_event, url) => callback(url);
      electron.ipcRenderer.on("auth:callback", handler);
      return () => electron.ipcRenderer.removeListener("auth:callback", handler);
    },
    getLoopbackUrl: () => electron.ipcRenderer.invoke("auth:getLoopbackUrl"),
    /** Pull a callback that main buffered before this renderer's listener was live. */
    consumePending: () => electron.ipcRenderer.invoke("auth:consumePending"),
    /** Drop any buffered callback in main so a cancelled flow can't be replayed. */
    clearPending: () => electron.ipcRenderer.invoke("auth:clearPending")
  },
  /** Server health */
  health: {
    check: () => electron.ipcRenderer.invoke("menu:check-health")
  },
  /** Shell operations */
  shell: {
    openExternal: (url) => electron.ipcRenderer.invoke("shell:openExternal", url)
  },
  /** MCP client discovery and hook management */
  mcp: {
    detectClients: () => electron.ipcRenderer.invoke("mcp:detectClients"),
    discover: () => electron.ipcRenderer.invoke("mcp:discover"),
    findDuplicates: () => electron.ipcRenderer.invoke("mcp:findDuplicates"),
    removeServers: (targets) => electron.ipcRenderer.invoke("mcp:removeServers", targets),
    resubmitServer: (params) => electron.ipcRenderer.invoke("mcp:resubmitServer", params),
    readConfig: (configPath) => electron.ipcRenderer.invoke("mcp:readConfig", configPath),
    applyAppIntegrations: (args) => electron.ipcRenderer.invoke("mcp:applyAppIntegrations", args),
    applyForSecretKey: (edisonSecretKey) => electron.ipcRenderer.invoke("mcp:applyForSecretKey", { edisonSecretKey }),
    revertAppIntegrations: (args) => electron.ipcRenderer.invoke("mcp:revertAppIntegrations", args),
    submitWithTemplates: (params) => electron.ipcRenderer.invoke("mcp:submitWithTemplates", params),
    analyzeSecrets: (params) => electron.ipcRenderer.invoke("mcp:analyzeSecrets", params),
    submitAllDiscovered: (params) => electron.ipcRenderer.invoke("mcp:submitAllDiscovered", params),
    injectHooks: () => electron.ipcRenderer.invoke("mcp:injectHooks"),
    removeHooks: () => electron.ipcRenderer.invoke("mcp:removeHooks"),
    getHookStatus: () => electron.ipcRenderer.invoke("mcp:getHookStatus"),
    injectVsCodeWorkspaceHook: (workspacePath) => electron.ipcRenderer.invoke("mcp:injectVsCodeWorkspaceHook", workspacePath),
    removeVsCodeWorkspaceHook: (workspacePath) => electron.ipcRenderer.invoke("mcp:removeVsCodeWorkspaceHook", workspacePath)
  },
  /** Config: effective base URLs and active env (respects debug env override) */
  config: {
    getEffectiveBaseUrls: () => electron.ipcRenderer.invoke("config:getEffectiveBaseUrls"),
    getActiveEnv: () => electron.ipcRenderer.invoke("config:getActiveEnv"),
    onEnvChanged: (callback) => {
      const handler = (_event, env) => callback(env);
      electron.ipcRenderer.on("env:changed", handler);
      return () => electron.ipcRenderer.removeListener("env:changed", handler);
    }
  },
  /** Multi-account management */
  accounts: {
    list: () => electron.ipcRenderer.invoke("accounts:list"),
    switch: (userId) => electron.ipcRenderer.invoke("accounts:switch", userId),
    remove: (userId) => electron.ipcRenderer.invoke("accounts:remove", userId)
  },
  /** Menu actions (post-setup window) */
  menu: {
    openFeedback: () => electron.ipcRenderer.invoke("menu:openFeedback"),
    resizeWindow: (width, height) => electron.ipcRenderer.invoke("menu:resizeWindow", width, height),
    getVersion: () => electron.ipcRenderer.invoke("menu:getVersion"),
    getMcpConfig: () => electron.ipcRenderer.invoke("menu:getMcpConfig"),
    getMcpUrl: () => electron.ipcRenderer.invoke("menu:getMcpUrl"),
    /** Pop up the native app menu (Windows body right-click entry point). */
    popupApp: () => electron.ipcRenderer.invoke("menu:popupApp")
  },
  /** Auto-updater: state, manual actions, settings, and live status events. */
  updates: {
    getState: () => electron.ipcRenderer.invoke("update:getState"),
    check: () => electron.ipcRenderer.invoke("update:check"),
    download: () => electron.ipcRenderer.invoke("update:download"),
    install: () => electron.ipcRenderer.invoke("update:install"),
    getSettings: () => electron.ipcRenderer.invoke("update:getSettings"),
    setSettings: (patch) => electron.ipcRenderer.invoke("update:setSettings", patch),
    onStatus: (callback) => {
      const handler = (_event, state) => callback(state);
      electron.ipcRenderer.on("update:status", handler);
      return () => electron.ipcRenderer.removeListener("update:status", handler);
    }
  },
  /** OS keychain (safeStorage) - store/load the personal encryption key */
  keychain: {
    save: (plaintext) => electron.ipcRenderer.invoke("keychain:save", plaintext),
    load: () => electron.ipcRenderer.invoke("keychain:load"),
    delete: () => electron.ipcRenderer.invoke("keychain:delete")
  },
  /** Developer: clear all app data and relaunch */
  app: {
    clearDataAndRestart: () => electron.ipcRenderer.invoke("app:clearDataAndRestart")
  },
  /** Bundled edison-stdiod daemon (stdio MCP tunnel) */
  stdiod: {
    status: () => electron.ipcRenderer.invoke("stdiod:status"),
    install: () => electron.ipcRenderer.invoke("stdiod:install"),
    login: (input) => electron.ipcRenderer.invoke("stdiod:login", input),
    uninstall: (opts) => electron.ipcRenderer.invoke("stdiod:uninstall", opts),
    reset: (input) => electron.ipcRenderer.invoke("stdiod:reset", input),
    getLogPath: () => electron.ipcRenderer.invoke("stdiod:getLogPath"),
    // Fired by the main process when a tray/menu-initiated reset starts, so
    // an open config card can show a "Resetting…" state instead of relying
    // on its 3s status poll (which misses the fast off→on transition).
    onResetting: (callback) => {
      const handler = () => callback();
      electron.ipcRenderer.on("stdiod:resetting", handler);
      return () => electron.ipcRenderer.removeListener("stdiod:resetting", handler);
    },
    // Fired when the main process has mutated daemon state (e.g. a reset
    // finished, or it reconnected) so the card should refresh immediately.
    onChanged: (callback) => {
      const handler = () => callback();
      electron.ipcRenderer.on("stdiod:changed", handler);
      return () => electron.ipcRenderer.removeListener("stdiod:changed", handler);
    }
  },
  /** App version */
  getVersion: () => electronAPI.process.versions.electron ?? ""
};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = electronAPI;
  window.api = api;
}
