"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const windowStateKeeper = require("electron-window-state");
const jsonc = require("jsonc-parser");
const child_process = require("child_process");
const url = require("url");
const node_fs = require("node:fs");
const path$1 = require("node:path");
const util = require("util");
const smolToml = require("smol-toml");
const crypto = require("crypto");
const chokidar = require("chokidar");
const electronUpdater = require("electron-updater");
const events = require("events");
const node_child_process = require("node:child_process");
const os$1 = require("node:os");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const jsonc__namespace = /* @__PURE__ */ _interopNamespaceDefault(jsonc);
const MONITOR_LOG = "/tmp/ew-monitor.log";
const RELEVANT_PREFIXES = [
  "[Monitor]",
  "[McpConfigMonitor]",
  "[Quarantine]",
  "[MCP Quarantine]",
  "[SeenStore]",
  "[getCursorPluginMcpPaths]",
  "[claude-cli]"
];
function shouldCapture(msg) {
  for (const p of RELEVANT_PREFIXES) {
    if (msg.includes(p)) return true;
  }
  return false;
}
function stringify(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
function formatLine(level, args) {
  const text = args.map(stringify).join(" ");
  const prefix = level === "log" ? "" : ` [${level.toUpperCase()}]`;
  return `[${(/* @__PURE__ */ new Date()).toISOString()}]${prefix} ${text}
`;
}
let installed = false;
function installMonitorTee() {
  if (installed) return;
  installed = true;
  const levels = ["log", "warn", "error", "info"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const first = args[0];
        if (typeof first === "string" && shouldCapture(first)) {
          fs.appendFileSync(MONITOR_LOG, formatLine(level, args));
        }
      } catch {
      }
      original(...args);
    };
  }
}
function formatClaudeCmd(args) {
  const quoted = args.map((a) => /[\s"']/.test(a) ? JSON.stringify(a) : a);
  return `claude ${quoted.join(" ")}`;
}
function logClaudeCmd(args, opts) {
  const cwdSuffix = opts?.cwd ? ` (cwd=${opts.cwd})` : "";
  console.log(`[claude-cli] $ ${formatClaudeCmd(args)}${cwdSuffix}`);
}
let loopbackServer = null;
let loopbackUrl = null;
function getAuthLoopbackUrl() {
  return loopbackUrl;
}
function startAuthLoopbackServer(getMainWindow2) {
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      const reqUrl = req.url ?? "/";
      if (!reqUrl.startsWith("/auth/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const port = loopbackServer.address().port;
      const fullUrl = `http://127.0.0.1:${port}${reqUrl}`;
      console.log("[AuthLoopback] Received OAuth callback:", fullUrl);
      const parsedUrl = new URL(fullUrl);
      const hasCode = parsedUrl.searchParams.has("code");
      const hasToken = parsedUrl.searchParams.has("access_token");
      const win = getMainWindow2();
      if ((hasCode || hasToken) && win) {
        win.webContents.send("auth:callback", fullUrl);
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1C1C1C;color:#C3FFFD">
  <div style="text-align:center">
    <h2>Authentication successful</h2>
    <p>You can close this tab and return to Edison Watch.</p>
  </div>
  <script>
    (async () => {
      // SSO/implicit tokens arrive in the URL fragment, which the browser never
      // sends to the server on the GET. Hand them over via this fetch and AWAIT
      // it before closing - otherwise window.close() aborts the request and the
      // callback (and sign-in) is lost. This was the intermittent "still waiting".
      if (window.location.hash && window.location.hash.length > 1) {
        try {
          await fetch('/auth/callback?from_hash=1&' + window.location.hash.substring(1));
        } catch (e) {}
      }
      window.close();
    })();
  <\/script>
</body>
</html>`);
    };
    loopbackServer = http.createServer(handler);
    loopbackServer.listen(0, "127.0.0.1", () => {
      const port = loopbackServer.address().port;
      loopbackUrl = `http://127.0.0.1:${port}/auth/callback`;
      console.log(`[AuthLoopback] Listening at ${loopbackUrl}`);
      resolve();
    });
    loopbackServer.on("error", (err) => {
      console.error("[AuthLoopback] Failed to start:", err);
      reject(err);
    });
  });
}
let pendingAuthCallbackUrl;
let getMainWindow$1 = () => null;
let log = () => {
};
function deliverAuthCallback(url2, source) {
  log(`auth:callback from ${source}`);
  pendingAuthCallbackUrl = url2;
  const wc = getMainWindow$1()?.webContents;
  if (wc && !wc.isLoading()) {
    wc.send("auth:callback", url2);
  } else {
    log(`auth:callback buffered (window ${wc ? "loading" : "absent"}) - renderer will pull on mount`);
  }
}
function flushBufferedAuthCallback() {
  if (!pendingAuthCallbackUrl) return;
  log("did-finish-load: pushing buffered auth callback");
  getMainWindow$1()?.webContents.send("auth:callback", pendingAuthCallbackUrl);
}
function initDeepLinkAuth(deps) {
  getMainWindow$1 = deps.getMainWindow;
  const showMainWindow2 = deps.showMainWindow;
  log = deps.log;
  const gotLock = electron.app.requestSingleInstanceLock();
  if (!gotLock) {
    electron.app.quit();
    return false;
  }
  electron.ipcMain.handle("auth:consumePending", () => {
    const url2 = pendingAuthCallbackUrl;
    pendingAuthCallbackUrl = void 0;
    if (url2) log("auth:consumePending -> delivering buffered callback");
    return url2 ?? null;
  });
  electron.ipcMain.handle("auth:clearPending", () => {
    if (pendingAuthCallbackUrl) log("auth:clearPending -> dropping buffered callback");
    pendingAuthCallbackUrl = void 0;
  });
  electron.ipcMain.handle("menu:popupApp", (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    if (win) electron.Menu.getApplicationMenu()?.popup({ window: win });
  });
  if (process.platform !== "darwin") {
    const argvUrl = process.argv.find((arg) => arg.startsWith("edison-watch://"));
    if (argvUrl) {
      log("cold-start deep link found in argv");
      pendingAuthCallbackUrl = argvUrl;
    }
  }
  electron.app.on("open-url", (_event, url2) => {
    if (url2.startsWith("edison-watch://")) deliverAuthCallback(url2, "open-url");
  });
  electron.app.on("second-instance", (_event, commandLine) => {
    showMainWindow2();
    const url2 = commandLine.find((arg) => arg.startsWith("edison-watch://"));
    if (url2) deliverAuthCallback(url2, "second-instance");
    else log("second-instance fired with no edison-watch:// url in argv");
  });
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      electron.app.setAsDefaultProtocolClient("edison-watch", process.execPath, [process.argv[1]]);
    }
  } else {
    electron.app.setAsDefaultProtocolClient("edison-watch");
  }
  return gotLock;
}
const SQLITE_TIMEOUT_MS = 5e3;
async function queryStateDb(dbPath, key) {
  try {
    await fs.promises.access(dbPath);
  } catch {
    return null;
  }
  const safeKey = key.replace(/'/g, "''");
  return new Promise((resolve) => {
    child_process.execFile(
      "sqlite3",
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${safeKey}' LIMIT 1;`],
      { timeout: SQLITE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}
async function updateStateDb(dbPath, key, value) {
  try {
    await fs.promises.access(dbPath);
  } catch {
    throw new Error(`State database not found: ${dbPath}`);
  }
  const tmpPath = path.join(path.dirname(dbPath), `.ew_statedb_tmp_${Date.now()}.txt`);
  try {
    await fs.promises.writeFile(tmpPath, value, "utf-8");
    const safeKey = key.replace(/'/g, "''");
    const sql = `UPDATE ItemTable SET value = readfile('${tmpPath.replace(/'/g, "''")}') WHERE key = '${safeKey}';`;
    await new Promise((resolve, reject) => {
      child_process.execFile(
        "sqlite3",
        [dbPath, sql],
        { timeout: SQLITE_TIMEOUT_MS },
        (err) => {
          if (err) reject(new Error(`Failed to update state DB: ${err.message}`));
          else resolve();
        }
      );
    });
  } finally {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
    }
  }
}
function getVscodeUserMcpPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Code",
        "User",
        "mcp.json"
      );
    default:
      return path.join(os.homedir(), ".config", "Code", "User", "mcp.json");
  }
}
function getVscodeStateDbPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "state.vscdb");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Code",
        "User",
        "globalStorage",
        "state.vscdb"
      );
    default:
      return path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "state.vscdb");
  }
}
async function discoverVscodeStateMcps(client = "vscode") {
  const dbPath = getVscodeStateDbPath();
  const results = [];
  try {
    const raw = await queryStateDb(dbPath, "mcpToolCache");
    if (!raw) return results;
    const cache = JSON.parse(raw);
    if (Array.isArray(cache.extensionServers)) {
      for (const extServer of cache.extensionServers) {
        if (!extServer.id) continue;
        const config = extServer.serverUrl ? { type: "http", url: extServer.serverUrl } : { type: "opaque" };
        results.push({
          name: extServer.label ?? extServer.id,
          client,
          source: "marketplace",
          path: dbPath,
          config
        });
      }
    }
    if (Array.isArray(cache.serverTools)) {
      const knownNames = new Set(results.map((s) => s.name.toLowerCase()));
      for (const [serverId, entry] of cache.serverTools) {
        if (serverId.startsWith("mcp.config.")) continue;
        if (serverId.startsWith("cursor.")) continue;
        const name = entry.serverName ?? serverId;
        if (knownNames.has(name.toLowerCase())) continue;
        results.push({
          name,
          client,
          source: "marketplace",
          path: dbPath,
          config: { type: "opaque" }
        });
        knownNames.add(name.toLowerCase());
      }
    }
  } catch {
  }
  return results;
}
async function parseVscodeMcpJson(filePath, client = "vscode") {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.servers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client,
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
function getCursorWorkspaceStoragePath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "workspaceStorage");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor",
        "User",
        "workspaceStorage"
      );
    default:
      return path.join(os.homedir(), ".config", "Cursor", "User", "workspaceStorage");
  }
}
async function getCursorProjectMcpPaths() {
  const storageDir = getCursorWorkspaceStoragePath();
  const seen = /* @__PURE__ */ new Set();
  try {
    const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const workspaceJsonPath = path.join(storageDir, dirent.name, "workspace.json");
      try {
        const raw = await fs.promises.readFile(workspaceJsonPath, "utf-8");
        const json = JSON.parse(raw);
        const folder = json.folder;
        if (folder && folder.startsWith("file://")) {
          const projectPath = url.fileURLToPath(folder);
          if (projectPath === os.homedir()) continue;
          seen.add(path.join(projectPath, ".cursor", "mcp.json"));
        }
      } catch {
      }
    }
  } catch {
  }
  return Array.from(seen);
}
function getCursorPluginsInstalledPaths() {
  return [
    path.join(os.homedir(), ".cursor", "plugins", "installed_plugins.json"),
    // Cursor 2.5+
    path.join(os.homedir(), ".cursor", "plugins", "installed.json"),
    // Cursor <2.5 (legacy)
    path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
    // shared config surface
  ];
}
function getCursorPluginCachePath() {
  return path.join(os.homedir(), ".cursor", "plugins", "cache");
}
async function getCursorPluginMcpPaths() {
  const seen = /* @__PURE__ */ new Set();
  await scanCursorPluginCache(seen);
  const registryPaths = getCursorPluginsInstalledPaths();
  for (const registryPath of registryPaths) {
    try {
      const raw = await fs.promises.readFile(registryPath, "utf-8");
      const json = JSON.parse(raw);
      if ("version" in json && "plugins" in json && json.version === 1) {
        parseInstalledPluginsV1(json, seen);
      } else if ("version" in json && "plugins" in json) {
        console.warn(`[getCursorPluginMcpPaths] Unknown installed_plugins.json version (${json.version}), skipping: ${registryPath}`);
      } else {
        const registryBase = path.dirname(registryPath);
        parseInstalledPluginsLegacy(json, registryBase, seen);
      }
    } catch {
    }
  }
  return Array.from(seen);
}
async function scanCursorPluginCache(seen) {
  const cacheDir = getCursorPluginCachePath();
  try {
    const marketplaces = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    for (const mkt of marketplaces) {
      if (!mkt.isDirectory()) continue;
      if (mkt.name.startsWith("ew-disabled-")) continue;
      const mktPath = path.join(cacheDir, mkt.name);
      try {
        const plugins = await fs.promises.readdir(mktPath, { withFileTypes: true });
        for (const plugin of plugins) {
          if (!plugin.isDirectory()) continue;
          if (plugin.name.startsWith("ew-disabled-")) continue;
          const pluginPath = path.join(mktPath, plugin.name);
          try {
            const shas = await fs.promises.readdir(pluginPath, { withFileTypes: true });
            const shaDirs = shas.filter((d) => d.isDirectory());
            if (shaDirs.length === 0) continue;
            let bestDir = shaDirs[0].name;
            if (shaDirs.length > 1) {
              let bestMtime = 0;
              for (const d of shaDirs) {
                try {
                  const stat = await fs.promises.stat(path.join(pluginPath, d.name));
                  if (stat.mtimeMs > bestMtime) {
                    bestMtime = stat.mtimeMs;
                    bestDir = d.name;
                  }
                } catch {
                }
              }
            }
            seen.add(path.join(pluginPath, bestDir, "mcp.json"));
          } catch {
          }
        }
      } catch {
      }
    }
  } catch {
  }
}
function parseInstalledPluginsV1(json, seen) {
  const plugins = json.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return;
  for (const [, pluginData] of Object.entries(plugins)) {
    if (!pluginData || typeof pluginData !== "object") continue;
    const installPath = pluginData.installPath;
    if (typeof installPath === "string" && installPath) {
      if (!path.isAbsolute(installPath)) {
        console.warn(`[parseInstalledPluginsV1] installPath is not absolute, skipping: ${installPath}`);
        continue;
      }
      seen.add(path.join(installPath, ".mcp.json"));
    }
  }
}
function parseInstalledPluginsLegacy(json, pluginsBase, seen) {
  const user = Array.isArray(json.user) ? json.user.filter((e) => typeof e === "string") : [];
  const projects = json.projects && typeof json.projects === "object" && !Array.isArray(json.projects) ? json.projects : {};
  const team = json.team && typeof json.team === "object" && !Array.isArray(json.team) ? json.team : {};
  const local = json.local && typeof json.local === "object" && !Array.isArray(json.local) ? json.local : {};
  const allEntries = [
    ...user,
    ...Object.values(projects).flat().filter((e) => typeof e === "string"),
    ...Object.values(team).flat().filter((e) => typeof e === "string")
  ];
  for (const entry of allEntries) {
    const atIdx = entry.lastIndexOf("@");
    if (atIdx === -1) continue;
    const pluginName = entry.slice(0, atIdx);
    const marketplace = entry.slice(atIdx + 1);
    seen.add(path.join(pluginsBase, "cache", marketplace, pluginName, "latest", ".mcp.json"));
  }
  for (const [name, localPath] of Object.entries(local)) {
    if (typeof localPath === "string" && localPath) {
      if (!path.isAbsolute(localPath)) {
        console.warn(`[parseInstalledPluginsLegacy] localPath is not absolute, skipping: ${localPath}`);
      } else {
        seen.add(path.join(localPath, ".mcp.json"));
      }
    } else {
      seen.add(path.join(pluginsBase, "local", name, ".mcp.json"));
    }
  }
}
function getVsCodeWorkspaceStoragePath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Code",
        "User",
        "workspaceStorage"
      );
    default:
      return path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage");
  }
}
async function getWorkspaceRootsFromStorage(storageDir) {
  const seen = /* @__PURE__ */ new Set();
  try {
    const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const workspaceJsonPath = path.join(storageDir, dirent.name, "workspace.json");
      try {
        const raw = await fs.promises.readFile(workspaceJsonPath, "utf-8");
        const json = JSON.parse(raw);
        const folder = json.folder;
        if (folder && folder.startsWith("file://")) {
          seen.add(url.fileURLToPath(folder));
        }
      } catch {
      }
    }
  } catch {
  }
  return Array.from(seen);
}
async function getVsCodeWorkspacePaths() {
  return getWorkspaceRootsFromStorage(getVsCodeWorkspaceStoragePath());
}
async function getClaudeCodeProjectMcpPaths() {
  const homeJsonPath = path.join(os.homedir(), ".claude.json");
  try {
    const raw = await fs.promises.readFile(homeJsonPath, "utf-8");
    const json = JSON.parse(raw);
    const projectPaths = Object.keys(json.projects ?? {});
    return projectPaths.map((p) => path.join(p, ".mcp.json"));
  } catch {
    return [];
  }
}
function getCursorStateDbPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb"
      );
    default:
      return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  }
}
function getCursorProjectsDir() {
  return path.join(os.homedir(), ".cursor", "projects");
}
async function queryCursorStateDb(key) {
  const dbPath = getCursorStateDbPath();
  try {
    await fs.promises.access(dbPath);
  } catch {
    return null;
  }
  const safeKey = key.replace(/'/g, "''");
  return new Promise((resolve) => {
    child_process.execFile(
      "sqlite3",
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${safeKey}' LIMIT 1;`],
      { timeout: 5e3 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      }
    );
  });
}
async function discoverCursorMarketplaceMcps() {
  const results = [];
  const stateDbPath = getCursorStateDbPath();
  try {
    const raw = await queryCursorStateDb("anysphere.cursor-mcp");
    if (raw) {
      const state = JSON.parse(raw);
      for (const [key, value] of Object.entries(state)) {
        const urlMatch = key.match(/^\[user-(.+?)\] mcp_server_url$/);
        if (urlMatch?.[1] && value) {
          const serverName = urlMatch[1];
          results.push({
            name: serverName,
            client: "cursor",
            source: "marketplace",
            path: stateDbPath,
            config: { type: "http", url: value }
          });
        }
      }
    }
  } catch {
  }
  try {
    const projectsDir = getCursorProjectsDir();
    const projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue;
      const mcpsDir = path.join(projectsDir, projDir.name, "mcps");
      try {
        const mcpEntries = await fs.promises.readdir(mcpsDir, { withFileTypes: true });
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory() || !mcpDir.name.startsWith("plugin-")) continue;
          const metadataPath = path.join(mcpsDir, mcpDir.name, "SERVER_METADATA.json");
          try {
            const raw = await fs.promises.readFile(metadataPath, "utf-8");
            const metadata = JSON.parse(raw);
            const serverName = metadata.serverName ?? mcpDir.name.replace(/^plugin-/, "");
            if (results.some((s) => s.name.toLowerCase() === serverName.toLowerCase())) continue;
            results.push({
              name: serverName,
              client: "cursor",
              source: "marketplace",
              path: metadataPath,
              config: { type: "opaque" }
            });
          } catch {
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return results;
}
function getCursorConfigPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}
async function parseCursorMcpJson(filePath, source = "user", projectName) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = jsonc__namespace.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "cursor",
      source,
      path: filePath,
      config: cfg,
      ...projectName !== void 0 ? { projectName } : {}
    });
  }
  return servers;
}
async function discoverCursor() {
  const results = [];
  try {
    const configPath = getCursorConfigPath();
    await fs.promises.access(configPath);
    const servers = await parseCursorMcpJson(configPath);
    results.push(...servers);
  } catch {
  }
  const projectMcpPaths = await getCursorProjectMcpPaths();
  for (const mcpPath of projectMcpPaths) {
    try {
      await fs.promises.access(mcpPath);
      const projectName = path.basename(path.dirname(path.dirname(mcpPath)));
      const servers = await parseCursorMcpJson(mcpPath, "project", projectName);
      results.push(...servers);
    } catch {
    }
  }
  const pluginMcpPaths = await getCursorPluginMcpPaths();
  for (const mcpPath of pluginMcpPaths) {
    try {
      await fs.promises.access(mcpPath);
      const servers = await parseCursorMcpJson(mcpPath, "plugin");
      results.push(...servers);
    } catch {
    }
  }
  const marketplaceMcps = await discoverCursorMarketplaceMcps();
  const existingNames = new Set(results.map((s) => s.name.toLowerCase()));
  for (const mcp of marketplaceMcps) {
    if (!existingNames.has(mcp.name.toLowerCase())) {
      results.push(mcp);
    }
  }
  return results;
}
function getClaudeCodeUserSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}
function getClaudeCodeLocalSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.local.json");
}
function getClaudeCodeHomeJsonPath() {
  return path.join(os.homedir(), ".claude.json");
}
function getClaudeCodeDedicatedMcpPath() {
  return path.join(os.homedir(), ".claude", "mcp_servers.json");
}
function getClaudeCodeManagedMcpPath() {
  switch (os.platform()) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-mcp.json";
    case "win32":
      return "C:\\ProgramData\\ClaudeCode\\managed-mcp.json";
    default:
      return "/etc/claude-code/managed-mcp.json";
  }
}
async function parseClaudeCodeSettingsJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "claude-code",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  const profiles = json.profiles ?? {};
  for (const [profileName, profileCfg] of Object.entries(profiles)) {
    const profileEntries = Object.entries(profileCfg?.mcpServers ?? {});
    for (const [name, cfg] of profileEntries) {
      servers.push({
        name,
        client: "claude-code",
        source: "user",
        path: filePath,
        config: cfg,
        profileName
      });
    }
  }
  return servers;
}
async function parseClaudeCodeMcpJson(filePath, source) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "claude-code",
      source,
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function parseClaudeHomeJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const topLevel = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of topLevel) {
    servers.push({
      name,
      client: "claude-code",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  const projects = json.projects ?? {};
  for (const [projectPath, projCfg] of Object.entries(projects)) {
    const entries = Object.entries(projCfg?.mcpServers ?? {});
    for (const [name, cfg] of entries) {
      servers.push({
        name,
        client: "claude-code",
        source: "project",
        path: filePath,
        config: cfg,
        projectName: projectPath
      });
    }
  }
  return servers;
}
async function parseClaudeDedicatedMcpServers(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  let mapping;
  if ("mcpServers" in json && json.mcpServers && typeof json.mcpServers === "object") {
    mapping = json.mcpServers;
  } else {
    mapping = json;
  }
  const servers = [];
  const entries = Object.entries(mapping ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "claude-code",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function discoverClaudeCode() {
  const results = [];
  try {
    const userPath = getClaudeCodeUserSettingsPath();
    await fs.promises.access(userPath);
    const userServers = await parseClaudeCodeSettingsJson(userPath);
    results.push(...userServers);
  } catch {
  }
  try {
    const localPath = path.join(os.homedir(), ".claude", "settings.local.json");
    await fs.promises.access(localPath);
    const localServers = await parseClaudeCodeSettingsJson(localPath);
    results.push(...localServers);
  } catch {
  }
  try {
    const homeJsonPath = path.join(os.homedir(), ".claude.json");
    await fs.promises.access(homeJsonPath);
    const homeJsonServers = await parseClaudeHomeJson(homeJsonPath);
    results.push(...homeJsonServers);
  } catch {
  }
  try {
    const dedicatedPath = path.join(os.homedir(), ".claude", "mcp_servers.json");
    await fs.promises.access(dedicatedPath);
    const dedicatedServers = await parseClaudeDedicatedMcpServers(dedicatedPath);
    results.push(...dedicatedServers);
  } catch {
  }
  const projectMcpPaths = await getClaudeCodeProjectMcpPaths();
  for (const mcpPath of projectMcpPaths) {
    try {
      await fs.promises.access(mcpPath);
      const projectDir = path.dirname(mcpPath);
      const servers = await parseClaudeCodeMcpJson(mcpPath, "project");
      for (const s of servers) {
        s.projectName = projectDir;
      }
      results.push(...servers);
    } catch {
    }
  }
  try {
    const managedPath = getClaudeCodeManagedMcpPath();
    if (managedPath) {
      await fs.promises.access(managedPath);
      const managedServers = await parseClaudeCodeMcpJson(managedPath, "enterprise");
      results.push(...managedServers);
    }
  } catch {
  }
  return results;
}
function getWindsurfConfigPath() {
  return path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
}
async function parseWindsurfMcpJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "windsurf",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function discoverWindsurf() {
  const results = [];
  try {
    const configPath = getWindsurfConfigPath();
    await fs.promises.access(configPath);
    const servers = await parseWindsurfMcpJson(configPath);
    results.push(...servers);
  } catch {
  }
  return results;
}
function getZedConfigPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(os.homedir(), ".config", "zed", "settings.json");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Zed",
        "settings.json"
      );
    default:
      return path.join(os.homedir(), ".config", "zed", "settings.json");
  }
}
async function parseZedSettingsJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const mcpServers = json.context_servers ?? {};
  const entries = Object.entries(mcpServers);
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "zed",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function discoverZed() {
  const results = [];
  try {
    const configPath = getZedConfigPath();
    await fs.promises.access(configPath);
    const servers = await parseZedSettingsJson(configPath);
    results.push(...servers);
  } catch {
  }
  return results;
}
const SENTRY_DSN = "https://521930844e674e4fe234bf7e2f2a8942@o4509236804190208.ingest.de.sentry.io/4509722815234128";
let sentry = null;
let SENTRY_ENABLED = false;
function getSentry() {
  if (!sentry) {
    sentry = require("@sentry/electron/main");
  }
  return sentry;
}
function initSentry() {
  if (!electron.app.isPackaged) {
    console.log("[Sentry] Disabled in development mode");
    return;
  }
  if (process.env.EW_UPDATE_TEST) {
    console.log("[Sentry] Disabled for auto-update test");
    return;
  }
  const Sentry = getSentry();
  if (!Sentry) return;
  SENTRY_ENABLED = true;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: "production",
    release: electron.app.getVersion(),
    initialScope: {
      tags: { platform: "electron" }
    }
  });
  process.on("uncaughtException", (error) => {
    Sentry.captureException(error);
  });
  process.on("unhandledRejection", (reason) => {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });
  console.log("[Sentry] Initialized for Electron client");
}
function captureError(error, context) {
  if (SENTRY_ENABLED) {
    getSentry()?.captureException(error instanceof Error ? error : new Error(String(error)), {
      extra: context
    });
  } else {
    console.error("[sentry] Error captured:", error, context);
  }
}
function submitUserFeedback(comments, email) {
  if (!SENTRY_ENABLED) {
    console.log("[Sentry] User feedback (dev):", comments);
    return;
  }
  getSentry()?.captureFeedback({
    message: comments,
    name: "Edison Watch User",
    email: "unknown@edisonwatch.app"
  });
}
function getBundledPythonPath() {
  if (process.platform !== "win32") return null;
  if (electron.app.isPackaged) {
    const packaged = path$1.join(process.resourcesPath, "python", "python.exe");
    return node_fs.existsSync(packaged) ? packaged : null;
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const devPath = path$1.resolve(__dirname, "..", "..", "bin", "python", arch, "python.exe");
  return node_fs.existsSync(devPath) ? devPath : null;
}
function winPythonInvocation(scriptFileName) {
  const target = `"%~dp0${scriptFileName}"`;
  const bundled = getBundledPythonPath();
  if (bundled) {
    return `"${bundled}" ${target}`;
  }
  return `python ${target} 2>nul || python3 ${target} 2>nul || py ${target}`;
}
function getEdisonWatchDir() {
  return path.join(os.homedir(), ".edison-watch");
}
function getPendingRegistrationsDir() {
  return path.join(os.homedir(), ".edison-watch", "pending");
}
function getPendingErrorsDir() {
  return path.join(os.homedir(), ".edison-watch", "errors");
}
function getHookScriptPath() {
  const scriptName = process.platform === "win32" ? "edison-hook.cmd" : "edison-hook.sh";
  return path.join(os.homedir(), ".edison-watch", scriptName);
}
function generateHookScript() {
  const pendingDir = getPendingRegistrationsDir();
  const errorsDir = getPendingErrorsDir();
  if (process.platform === "win32") {
    return `@echo off
REM Edison Watch - Project Registration Hook
REM Writes a registration file for Edison Watch to process

setlocal enabledelayedexpansion

REM Get client name from first argument
set CLIENT=%1
if "%CLIENT%"=="" set CLIENT=unknown

REM Create pending directory if it doesn't exist
if not exist "${pendingDir}" mkdir "${pendingDir}"

REM Generate unique filename using timestamp and random number
set TIMESTAMP=%date:~-4%%date:~4,2%%date:~7,2%-%time:~0,2%%time:~3,2%%time:~6,2%
set TIMESTAMP=%TIMESTAMP: =0%
set FILENAME=%TIMESTAMP%-%RANDOM%-%CLIENT%.json

REM Write registration file
echo {"projectPath": "%CD%", "registeredBy": "%CLIENT%", "timestamp": "%TIMESTAMP%"} > "${pendingDir}\\%FILENAME%"

exit /b 0
`;
  }
  return `#!/bin/bash
# Edison Watch - Project Registration Hook
# Writes a registration file for Edison Watch to process

# Get the client that called this hook (passed as first argument)
CLIENT="\${1:-unknown}"

# Pending registrations and errors directories
PENDING_DIR="${pendingDir}"
ERRORS_DIR="${errorsDir}"

# Create directories if they don't exist
mkdir -p "$PENDING_DIR"
mkdir -p "$ERRORS_DIR"

# Generate unique filename
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RANDOM_ID=$RANDOM
FILENAME="\${TIMESTAMP}-\${RANDOM_ID}-\${CLIENT}.json"

# Get current working directory
CWD="$(pwd)"

# Write registration file (atomic via temp file + mv)
TEMP_FILE="$PENDING_DIR/.\${FILENAME}.tmp"
echo "{\\"projectPath\\": \\"$CWD\\", \\"registeredBy\\": \\"$CLIENT\\", \\"timestamp\\": \\"$TIMESTAMP\\"}" > "$TEMP_FILE"
if ! mv "$TEMP_FILE" "$PENDING_DIR/$FILENAME" 2>/dev/null; then
  echo "{\\"error\\":\\"mv failed\\",\\"client\\":\\"$CLIENT\\",\\"timestamp\\":\\"$(date -Iseconds)\\"}" > "$ERRORS_DIR/\${TIMESTAMP}-\${RANDOM_ID}.json"
fi

# Always exit successfully so we don't block the MCP client
exit 0
`;
}
async function ensureHookScript() {
  const scriptPath = getHookScriptPath();
  const scriptDir = path.dirname(scriptPath);
  const pendingDir = getPendingRegistrationsDir();
  try {
    if (!fs.existsSync(scriptDir)) {
      await fs.promises.mkdir(scriptDir, { recursive: true });
    }
    if (!fs.existsSync(pendingDir)) {
      await fs.promises.mkdir(pendingDir, { recursive: true });
    }
    const content = generateHookScript();
    await fs.promises.writeFile(scriptPath, content, { mode: 493 });
    console.log(`[HookInjection] Created hook script at ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: "ensureHookScript",
      scriptPath,
      pendingDir,
      platform: os.platform()
    });
    throw err;
  }
}
function getSessionStartHookScriptPath() {
  const scriptName = process.platform === "win32" ? "edison-session-start.cmd" : "edison-session-start.py";
  return path.join(os.homedir(), ".edison-watch", scriptName);
}
const SESSION_START_HOOK_PYTHON = `#!/usr/bin/env python3
import json, sys, os
try:
    data = json.load(sys.stdin)
    session_id = data.get("session_id") or data.get("sessionId")
    # Skip on Windows: .cmd wrapper means PPID is ephemeral cmd.exe, not Claude Code.
    # PreToolUse falls back to hook payload session_id on Windows.
    if session_id and sys.platform != "win32":
        edison_dir = os.path.expanduser("~/.edison-watch")
        os.makedirs(edison_dir, exist_ok=True)
        # PPID = Claude Code process ID. Relies on Claude Code spawning hooks as
        # direct children (execFile/spawn, not sh -c). Falls back gracefully if not.
        ppid = os.getppid()
        fname = f"active_session_{ppid}.json"
        tmp = os.path.join(edison_dir, f".{fname}.tmp")
        final = os.path.join(edison_dir, fname)
        with open(tmp, "w") as f:
            json.dump({"session_id": session_id}, f)
        os.rename(tmp, final)
except Exception:
    pass
sys.exit(0)
`;
function generateSessionStartHookScript() {
  if (process.platform === "win32") {
    return `@echo off
REM Edison Watch - Session start hook: persist session_id to PID-scoped file
${winPythonInvocation("edison-session-start.py")}
exit /b 0
`;
  }
  return SESSION_START_HOOK_PYTHON;
}
async function ensureSessionStartHookScript() {
  const scriptPath = getSessionStartHookScriptPath();
  const scriptDir = path.dirname(scriptPath);
  try {
    if (!fs.existsSync(scriptDir)) {
      await fs.promises.mkdir(scriptDir, { recursive: true });
    }
    if (process.platform === "win32") {
      const pyPath = path.join(scriptDir, "edison-session-start.py");
      await fs.promises.writeFile(pyPath, SESSION_START_HOOK_PYTHON, "utf-8");
      await fs.promises.writeFile(scriptPath, generateSessionStartHookScript(), "utf-8");
    } else {
      await fs.promises.writeFile(scriptPath, generateSessionStartHookScript(), { mode: 493 });
    }
    console.log(`[HookInjection] Created session start hook script at ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: "ensureSessionStartHookScript",
      scriptPath,
      platform: os.platform()
    });
    throw err;
  }
}
function getSessionEndHookScriptPath() {
  const scriptName = process.platform === "win32" ? "edison-session-end.cmd" : "edison-session-end.py";
  return path.join(os.homedir(), ".edison-watch", scriptName);
}
const SESSION_END_HOOK_PYTHON = `#!/usr/bin/env python3
import json, sys, os, time, random
try:
    data = json.load(sys.stdin)
    conv_id = data.get("session_id") or data.get("conversation_id") or data.get("sessionId")
    reason = data.get("reason", "unknown")
    if conv_id:
        pending_dir = os.path.expanduser("~/.edison-watch/pending")
        os.makedirs(pending_dir, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        fname = f"{ts}-{random.randint(0,99999)}-session-end.json"
        tmp = os.path.join(pending_dir, f".{fname}.tmp")
        final = os.path.join(pending_dir, fname)
        with open(tmp, "w") as f:
            json.dump({"event": "session_end", "conversation_id": conv_id,
                        "reason": reason, "timestamp": ts}, f)
        os.rename(tmp, final)
except Exception:
    pass
# Clean up PID-scoped active session file - runs regardless of pending-write outcome
# Skip on Windows: .cmd wrapper means PPID is ephemeral cmd.exe, not Claude Code
try:
    if sys.platform != "win32":
        ppid = os.getppid()
        active_file = os.path.expanduser(f"~/.edison-watch/active_session_{ppid}.json")
        if os.path.exists(active_file):
            os.remove(active_file)
except Exception:
    pass
sys.exit(0)
`;
function generateSessionEndHookScript() {
  if (process.platform === "win32") {
    return `@echo off
REM Edison Watch - Session end hook: write session end event
${winPythonInvocation("edison-session-end.py")}
exit /b 0
`;
  }
  return SESSION_END_HOOK_PYTHON;
}
async function ensureSessionEndHookScript() {
  const scriptPath = getSessionEndHookScriptPath();
  const scriptDir = path.dirname(scriptPath);
  try {
    if (!fs.existsSync(scriptDir)) {
      await fs.promises.mkdir(scriptDir, { recursive: true });
    }
    if (process.platform === "win32") {
      const pyPath = path.join(scriptDir, "edison-session-end.py");
      await fs.promises.writeFile(pyPath, SESSION_END_HOOK_PYTHON, "utf-8");
      await fs.promises.writeFile(scriptPath, generateSessionEndHookScript(), "utf-8");
    } else {
      await fs.promises.writeFile(scriptPath, generateSessionEndHookScript(), { mode: 493 });
    }
    console.log(`[HookInjection] Created session end hook script at ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: "ensureSessionEndHookScript",
      scriptPath,
      platform: os.platform()
    });
    throw err;
  }
}
function getSessionHookScriptPath() {
  const scriptName = process.platform === "win32" ? "edison-session-hook.cmd" : "edison-session-hook.py";
  return path.join(os.homedir(), ".edison-watch", scriptName);
}
const SESSION_HOOK_PYTHON = `#!/usr/bin/env python3
import json
import sys
import os

try:
    data = json.load(sys.stdin)
    # Detect client: VSCode Copilot (camelCase), Claude Code (snake_case), or Cursor (flat)
    is_vscode = "hookEventName" in data
    is_claude_code = "hook_event_name" in data
    uses_hook_output = is_vscode or is_claude_code
    # Extract conversation/session ID per client format
    if is_vscode:
        conv_id = data.get("sessionId")
    elif is_claude_code:
        # Try PID-scoped active session file first (authoritative, written by SessionStart hook)
        # Skip on Windows: .cmd wrapper gives ephemeral PPID, file won't match
        conv_id = None
        try:
            if sys.platform != "win32":
                ppid = os.getppid()
                active_file = os.path.expanduser(f"~/.edison-watch/active_session_{ppid}.json")
                if os.path.exists(active_file):
                    with open(active_file, "r") as f:
                        active_data = json.load(f)
                    conv_id = active_data.get("session_id")
        except Exception:
            pass
        # Fall back to hook payload data
        if not conv_id:
            conv_id = data.get("session_id") or data.get("conversation_id")
    else:
        conv_id = data.get("conversation_id")
    # Extract tool input (VSCode uses camelCase toolInput)
    tool_input = data.get("toolInput", data.get("tool_input", {})) if is_vscode else data.get("tool_input", {})
    if conv_id and isinstance(tool_input, dict):
        tool_input["_edison_conversation_id"] = conv_id
        if uses_hook_output:
            hook_event = data.get("hookEventName") or data.get("hook_event_name") or "PreToolUse"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": hook_event,
                "permissionDecision": "allow", "updatedInput": tool_input}}))
        else:
            print(json.dumps({"decision": "allow", "updated_input": tool_input}))
    else:
        if uses_hook_output:
            hook_event = data.get("hookEventName") or data.get("hook_event_name") or "PreToolUse"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": hook_event,
                "permissionDecision": "allow"}}))
        else:
            print(json.dumps({"decision": "allow"}))
except Exception:
    print(json.dumps({"decision": "allow", "hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "allow"}}))
sys.exit(0)
`;
function generateSessionHookScript() {
  if (process.platform === "win32") {
    return `@echo off
REM Edison Watch - Session hook: inject conversation_id into MCP tool args
${winPythonInvocation("edison-session-hook.py")}
exit /b 0
`;
  }
  return SESSION_HOOK_PYTHON;
}
async function ensureSessionHookScript() {
  const scriptPath = getSessionHookScriptPath();
  const scriptDir = path.dirname(scriptPath);
  try {
    if (!fs.existsSync(scriptDir)) {
      await fs.promises.mkdir(scriptDir, { recursive: true });
    }
    if (process.platform === "win32") {
      const pyPath = path.join(scriptDir, "edison-session-hook.py");
      await fs.promises.writeFile(pyPath, SESSION_HOOK_PYTHON, "utf-8");
      await fs.promises.writeFile(scriptPath, generateSessionHookScript(), "utf-8");
    } else {
      await fs.promises.writeFile(scriptPath, generateSessionHookScript(), { mode: 493 });
    }
    console.log(`[HookInjection] Created session hook script at ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      operation: "ensureSessionHookScript",
      scriptPath,
      platform: os.platform()
    });
    throw err;
  }
}
function appInstalled(hints) {
  const p = os.platform();
  if (p === "darwin") return (hints.mac ?? []).some(macAppBundleExists);
  if (p === "win32") return (hints.win ?? []).some(winExeExists);
  if (p === "linux") return (hints.linux ?? []).some(linuxAppExists);
  return false;
}
function macAppBundleExists(name) {
  return fs.existsSync(path.join("/Applications", name)) || fs.existsSync(path.join(os.homedir(), "Applications", name));
}
function winExeExists(exe) {
  if (path.isAbsolute(exe)) return fs.existsSync(exe);
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
    process.env.LOCALAPPDATA ?? null,
    process.env.ProgramFiles ?? null,
    process.env["ProgramFiles(x86)"] ?? null
  ].filter((r) => !!r);
  if (roots.some((root) => fs.existsSync(path.join(root, exe)))) return true;
  const base = exe.split(/[\\/]/).pop();
  if (base) {
    const bin = base.replace(/\.exe$/i, "");
    if (cliBinaryExists(bin)) return true;
  }
  return false;
}
function linuxAppExists(name) {
  if (cliBinaryExists(name)) return true;
  const home = os.homedir();
  const candidatePaths = [
    `/snap/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/${name}/${name}`,
    `/opt/${name}/bin/${name}`,
    path.join(home, ".local", "share", "applications", `${name}.desktop`),
    "/usr/share/applications/" + name + ".desktop",
    "/var/lib/flatpak/exports/share/applications/" + name + ".desktop",
    path.join(home, ".local", "share", "flatpak", "exports", "share", "applications", `${name}.desktop`)
  ];
  return candidatePaths.some(fs.existsSync);
}
function cliBinaryExists(binary) {
  const cmd = os.platform() === "win32" ? "where" : "which";
  try {
    const result = child_process.spawnSync(cmd, [binary], { timeout: 2e3, stdio: "pipe" });
    if (result.status === 0) return true;
  } catch {
  }
  if (os.platform() === "darwin" || os.platform() === "linux") {
    const home = os.homedir();
    const knownPaths = [
      path.join(home, ".local", "bin", binary),
      path.join("/usr", "local", "bin", binary),
      path.join("/opt", "homebrew", "bin", binary),
      ...binary === "claude" ? [path.join("/Applications", "cmux.app", "Contents", "Resources", "bin", binary)] : []
    ];
    return knownPaths.some((p) => fs.existsSync(p));
  }
  return false;
}
function getCodexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}
function isCodexInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".codex")) && cliBinaryExists("codex");
}
function buildCodexHookToml(scriptPath, sessionEndScriptPath) {
  return `
[[hooks.SessionStart]]
command = "${scriptPath} codex"

[[hooks.Stop]]
command = "${sessionEndScriptPath}"
`;
}
async function injectCodexHook() {
  const configPath = getCodexConfigPath();
  const scriptPath = await ensureHookScript();
  const sessionEndScriptPath = await ensureSessionEndHookScript();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    await fs.promises.mkdir(configDir, { recursive: true });
  }
  let existing = "";
  if (fs.existsSync(configPath)) {
    existing = await fs.promises.readFile(configPath, "utf-8");
  }
  if (existing.includes("edison-hook") && existing.includes("edison-session-end")) {
    console.log("[HookInjection] Edison hooks already exist in Codex config.toml");
    return false;
  }
  if (fs.existsSync(configPath)) {
    await fs.promises.copyFile(configPath, `${configPath}.backup.${Date.now()}`);
  }
  if (existing.includes("edison-hook") && !existing.includes("edison-session-end")) {
    await fs.promises.writeFile(
      configPath,
      existing + `
[[hooks.Stop]]
command = "${sessionEndScriptPath}"
`,
      "utf-8"
    );
  } else if (!existing.includes("edison-hook") && existing.includes("edison-session-end")) {
    await fs.promises.writeFile(
      configPath,
      existing + `
[[hooks.SessionStart]]
command = "${scriptPath} codex"
`,
      "utf-8"
    );
  } else {
    await fs.promises.writeFile(
      configPath,
      existing + buildCodexHookToml(scriptPath, sessionEndScriptPath),
      "utf-8"
    );
  }
  console.log("[HookInjection] Injected Edison hooks into Codex config.toml");
  return true;
}
async function removeCodexHook() {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return false;
  const content = await fs.promises.readFile(configPath, "utf-8");
  let cleaned = content;
  cleaned = cleaned.replace(
    /\n\[\[hooks\.SessionStart\]\]\ncommand = "[^"]*edison-hook[^"]*"\n/g,
    ""
  );
  cleaned = cleaned.replace(
    /\n\[\[hooks\.Stop\]\]\ncommand = "[^"]*edison-session-end[^"]*"\n/g,
    ""
  );
  if (cleaned === content) {
    console.log("[HookInjection] No Edison hook found in Codex config.toml");
    return false;
  }
  await fs.promises.writeFile(configPath, cleaned, "utf-8");
  console.log("[HookInjection] Removed Edison hooks from Codex config.toml");
  return true;
}
const CLIENT_DISPLAY = {
  "claude-code": { name: "Claude Code", brandColor: "#1A1A1A" },
  "claude-desktop": { name: "Claude Desktop", brandColor: "#D97757" },
  "claude-cowork": { name: "Claude Cowork", brandColor: "#C4745B" },
  codex: { name: "Codex", brandColor: "#000000" },
  cursor: { name: "Cursor", brandColor: "#000000" },
  vscode: { name: "VS Code", brandColor: "#007ACC" },
  windsurf: { name: "Windsurf", brandColor: "#0EA5E9" },
  zed: { name: "Zed", brandColor: "#084CCF" },
  intellij: { name: "IntelliJ IDEA", brandColor: "#000000" },
  pycharm: { name: "PyCharm", brandColor: "#21D789" },
  webstorm: { name: "WebStorm", brandColor: "#07C3F2" }
};
function getClaudeCodeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}
function isClaudeCodeInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".claude")) && cliBinaryExists("claude");
}
async function injectClaudeCodeHook() {
  const settingsPath2 = getClaudeCodeSettingsPath();
  const scriptPath = await ensureHookScript();
  const sessionScriptPath = await ensureSessionHookScript();
  const sessionStartScriptPath = await ensureSessionStartHookScript();
  const sessionEndScriptPath = await ensureSessionEndHookScript();
  const settingsDir = path.dirname(settingsPath2);
  if (!fs.existsSync(settingsDir)) {
    await fs.promises.mkdir(settingsDir, { recursive: true });
  }
  let content = "{}";
  if (fs.existsSync(settingsPath2)) {
    content = await fs.promises.readFile(settingsPath2, "utf-8");
  }
  const settings = jsonc.parse(content);
  let injected = false;
  const existingPromptHooks = settings.hooks?.UserPromptSubmit ?? [];
  const hasPromptHook = existingPromptHooks.some(
    (group) => group.hooks?.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"))
  );
  if (!hasPromptHook) {
    const edisonHook = {
      matcher: "*",
      hooks: [{ type: "command", command: `"${scriptPath}" claude-code` }]
    };
    const edits = jsonc.modify(content, ["hooks", "UserPromptSubmit"], [...existingPromptHooks, edisonHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
    });
    content = jsonc.applyEdits(content, edits);
    injected = true;
  }
  const settingsAfterPrompt = jsonc.parse(content);
  const existingToolHooks = settingsAfterPrompt.hooks?.PreToolUse ?? [];
  const hasToolHook = existingToolHooks.some(
    (group) => group.hooks?.some((h) => h.command?.includes("edison-session-hook"))
  );
  if (!hasToolHook) {
    const sessionHook = {
      matcher: "mcp__*",
      hooks: [{ type: "command", command: `"${sessionScriptPath}"` }]
    };
    const edits = jsonc.modify(content, ["hooks", "PreToolUse"], [...existingToolHooks, sessionHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
    });
    content = jsonc.applyEdits(content, edits);
    injected = true;
  }
  const settingsAfterTool = jsonc.parse(content);
  const existingStartHooks = settingsAfterTool.hooks?.SessionStart ?? [];
  const hasStartHook = existingStartHooks.some(
    (group) => group.hooks?.some((h) => h.command?.includes("edison-session-start"))
  );
  if (!hasStartHook) {
    const startHook = {
      matcher: "*",
      hooks: [{ type: "command", command: `"${sessionStartScriptPath}"` }]
    };
    const edits = jsonc.modify(content, ["hooks", "SessionStart"], [...existingStartHooks, startHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
    });
    content = jsonc.applyEdits(content, edits);
    injected = true;
  }
  const settingsAfterStart = jsonc.parse(content);
  const existingEndHooks = settingsAfterStart.hooks?.SessionEnd ?? [];
  const hasEndHook = existingEndHooks.some(
    (group) => group.hooks?.some((h) => h.command?.includes("edison-session-end"))
  );
  if (!hasEndHook) {
    const endHook = {
      matcher: "*",
      hooks: [{ type: "command", command: `"${sessionEndScriptPath}"` }]
    };
    const edits = jsonc.modify(content, ["hooks", "SessionEnd"], [...existingEndHooks, endHook], {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
    });
    content = jsonc.applyEdits(content, edits);
    injected = true;
  }
  if (!injected) {
    console.log("[HookInjection] Edison hooks already exist in Claude Code settings");
    return false;
  }
  if (fs.existsSync(settingsPath2)) {
    const backupPath = `${settingsPath2}.backup.${Date.now()}`;
    await fs.promises.copyFile(settingsPath2, backupPath);
    console.log(`[HookInjection] Backed up settings to ${backupPath}`);
  }
  await fs.promises.writeFile(settingsPath2, content, "utf-8");
  console.log("[HookInjection] Injected Edison hooks into Claude Code settings");
  return true;
}
async function removeClaudeCodeHook() {
  const settingsPath2 = getClaudeCodeSettingsPath();
  if (!fs.existsSync(settingsPath2)) return false;
  let content = await fs.promises.readFile(settingsPath2, "utf-8");
  let removed = false;
  const settings = jsonc.parse(content);
  const existingPromptHooks = settings.hooks?.UserPromptSubmit ?? [];
  const filteredPromptHooks = existingPromptHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"))
  );
  if (filteredPromptHooks.length !== existingPromptHooks.length) {
    const edits = jsonc.modify(
      content,
      ["hooks", "UserPromptSubmit"],
      filteredPromptHooks.length > 0 ? filteredPromptHooks : void 0,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
    );
    content = jsonc.applyEdits(content, edits);
    removed = true;
  }
  const settingsAfter = jsonc.parse(content);
  const existingToolHooks = settingsAfter.hooks?.PreToolUse ?? [];
  const filteredToolHooks = existingToolHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes("edison-session-hook"))
  );
  if (filteredToolHooks.length !== existingToolHooks.length) {
    const edits = jsonc.modify(
      content,
      ["hooks", "PreToolUse"],
      filteredToolHooks.length > 0 ? filteredToolHooks : void 0,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
    );
    content = jsonc.applyEdits(content, edits);
    removed = true;
  }
  const settingsAfterTool = jsonc.parse(content);
  const existingStartHooks = settingsAfterTool.hooks?.SessionStart ?? [];
  const filteredStartHooks = existingStartHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes("edison-session-start"))
  );
  if (filteredStartHooks.length !== existingStartHooks.length) {
    const edits = jsonc.modify(
      content,
      ["hooks", "SessionStart"],
      filteredStartHooks.length > 0 ? filteredStartHooks : void 0,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
    );
    content = jsonc.applyEdits(content, edits);
    removed = true;
  }
  const settingsAfterStart = jsonc.parse(content);
  const existingEndHooks = settingsAfterStart.hooks?.SessionEnd ?? [];
  const filteredEndHooks = existingEndHooks.filter(
    (group) => !group.hooks?.some((h) => h.command?.includes("edison-session-end"))
  );
  if (filteredEndHooks.length !== existingEndHooks.length) {
    const edits = jsonc.modify(
      content,
      ["hooks", "SessionEnd"],
      filteredEndHooks.length > 0 ? filteredEndHooks : void 0,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
    );
    content = jsonc.applyEdits(content, edits);
    removed = true;
  }
  if (!removed) {
    console.log("[HookInjection] No Edison hook found in Claude Code settings");
    return false;
  }
  const finalSettings = jsonc.parse(content);
  if (finalSettings.hooks && Object.keys(finalSettings.hooks).length === 0) {
    const edits = jsonc.modify(
      content,
      ["hooks"],
      void 0,
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } }
    );
    content = jsonc.applyEdits(content, edits);
  }
  await fs.promises.writeFile(settingsPath2, content, "utf-8");
  console.log("[HookInjection] Removed Edison hooks from Claude Code settings");
  return true;
}
const CLAUDE_TOTAL_HOOKS = 4;
async function getClaudeCodeHookStatus() {
  const installed2 = isClaudeCodeInstalled();
  let hookCount = 0;
  if (installed2) {
    try {
      const settingsPath2 = getClaudeCodeSettingsPath();
      if (fs.existsSync(settingsPath2)) {
        const content = await fs.promises.readFile(settingsPath2, "utf-8");
        const settings = jsonc.parse(content);
        const promptHooks = settings.hooks?.UserPromptSubmit ?? [];
        const toolHooks = settings.hooks?.PreToolUse ?? [];
        const startHooks = settings.hooks?.SessionStart ?? [];
        const endHooks = settings.hooks?.SessionEnd ?? [];
        if (promptHooks.some(
          (group) => group.hooks?.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"))
        )) hookCount++;
        if (toolHooks.some(
          (group) => group.hooks?.some((h) => h.command?.includes("edison-session-hook"))
        )) hookCount++;
        if (startHooks.some(
          (group) => group.hooks?.some((h) => h.command?.includes("edison-session-start"))
        )) hookCount++;
        if (endHooks.some(
          (group) => group.hooks?.some((h) => h.command?.includes("edison-session-end"))
        )) hookCount++;
      }
    } catch {
    }
  }
  return { installed: installed2, hasHook: hookCount === CLAUDE_TOTAL_HOOKS, hookCount, totalHooks: CLAUDE_TOTAL_HOOKS };
}
const meta$7 = CLIENT_DISPLAY["claude-code"];
const integration$a = {
  id: "claude-code",
  display: { name: meta$7.name, brandColor: meta$7.brandColor },
  isInstalled: isClaudeCodeInstalled,
  discoverServers: discoverClaudeCode,
  async configEntries() {
    const entries = [
      { client: "claude-code", path: getClaudeCodeUserSettingsPath(), kind: "json", scope: "user" },
      { client: "claude-code", path: getClaudeCodeLocalSettingsPath(), kind: "json", scope: "user" },
      {
        client: "claude-code",
        path: getClaudeCodeHomeJsonPath(),
        kind: "json",
        scope: "user",
        triggersDynamicRescan: "claude-code-projects"
      },
      { client: "claude-code", path: getClaudeCodeDedicatedMcpPath(), kind: "json", scope: "user" }
    ];
    const managed = getClaudeCodeManagedMcpPath();
    if (managed) {
      entries.push({ client: "claude-code", path: managed, kind: "json", scope: "enterprise" });
    }
    for (const p of await getClaudeCodeProjectMcpPaths()) {
      entries.push({ client: "claude-code", path: p, kind: "json", scope: "project" });
    }
    return entries;
  },
  async watchTargets() {
    return {
      files: await integration$a.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  hooks: {
    supportedEvents: {
      "user-prompt-submit": { nativeName: "UserPromptSubmit" },
      "pre-tool-use": { nativeName: "PreToolUse", matcher: "mcp__*" },
      "session-start": { nativeName: "SessionStart" },
      "session-end": { nativeName: "SessionEnd" }
    },
    sessionIdStrategy: { kind: "pid-scoped-file", ppidBased: true },
    inject: injectClaudeCodeHook,
    remove: removeClaudeCodeHook,
    getStatus: getClaudeCodeHookStatus
  },
  backups: {
    globs: () => [
      `${getClaudeCodeSettingsPath()}.backup.*`,
      `${getClaudeCodeHomeJsonPath()}.backup.*`,
      `${getClaudeCodeDedicatedMcpPath()}.backup.*`
    ]
  }
};
function getClaudeDesktopConfigPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    default:
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}
async function parseClaudeDesktopConfig(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "claude-desktop",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function discoverClaudeDesktop() {
  try {
    const configPath = getClaudeDesktopConfigPath();
    await fs.promises.access(configPath);
    return await parseClaudeDesktopConfig(configPath);
  } catch {
    return [];
  }
}
const meta$6 = CLIENT_DISPLAY["claude-desktop"];
const integration$9 = {
  id: "claude-desktop",
  display: { name: meta$6.name, brandColor: meta$6.brandColor },
  isInstalled() {
    return fs.existsSync(path.dirname(getClaudeDesktopConfigPath())) && appInstalled({
      mac: ["Claude.app"],
      win: ["Claude\\Claude.exe"],
      linux: ["claude-desktop", "Claude"]
    });
  },
  discoverServers: discoverClaudeDesktop,
  async configEntries() {
    return [
      { client: "claude-desktop", path: getClaudeDesktopConfigPath(), kind: "json", scope: "user" }
    ];
  },
  async watchTargets() {
    return {
      files: await integration$9.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  backups: {
    globs: () => [`${getClaudeDesktopConfigPath()}.backup.*`]
  }
};
function getClaudeCoworkConfigPath() {
  switch (os.platform()) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    default:
      return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}
async function parseClaudeCoworkConfig(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client: "claude-cowork",
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
async function discoverClaudeCowork() {
  try {
    const configPath = getClaudeCoworkConfigPath();
    const vmBundlesDir = path.join(path.dirname(configPath), "vm_bundles");
    await fs.promises.access(vmBundlesDir);
    await fs.promises.access(configPath);
    return await parseClaudeCoworkConfig(configPath);
  } catch {
    return [];
  }
}
const meta$5 = CLIENT_DISPLAY["claude-cowork"];
const integration$8 = {
  id: "claude-cowork",
  display: { name: meta$5.name, brandColor: meta$5.brandColor },
  isInstalled() {
    const configPath = getClaudeCoworkConfigPath();
    const vmBundlesDir = path.join(path.dirname(configPath), "vm_bundles");
    if (!fs.existsSync(vmBundlesDir)) return false;
    return appInstalled({
      mac: ["Claude.app"],
      win: ["Claude\\Claude.exe"],
      linux: ["claude-desktop", "Claude"]
    });
  },
  discoverServers: discoverClaudeCowork,
  async configEntries() {
    return [
      { client: "claude-cowork", path: getClaudeCoworkConfigPath(), kind: "json", scope: "user" }
    ];
  },
  async watchTargets() {
    return {
      files: await integration$8.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  backups: {
    globs: () => [`${getClaudeCoworkConfigPath()}.backup.*`]
  }
};
const CODEX_TOTAL_HOOKS = 2;
async function getCodexHookStatus() {
  const installed2 = isCodexInstalled();
  let hookCount = 0;
  if (installed2) {
    try {
      const configPath = getCodexConfigPath();
      if (fs.existsSync(configPath)) {
        const content = await fs.promises.readFile(configPath, "utf-8");
        if (content.includes("edison-hook")) hookCount++;
        if (content.includes("edison-session-end")) hookCount++;
      }
    } catch {
    }
  }
  return {
    installed: installed2,
    hasHook: hookCount === CODEX_TOTAL_HOOKS,
    hookCount,
    totalHooks: CODEX_TOTAL_HOOKS
  };
}
const meta$4 = CLIENT_DISPLAY["codex"];
const integration$7 = {
  id: "codex",
  display: { name: meta$4.name, brandColor: meta$4.brandColor },
  isInstalled: isCodexInstalled,
  async discoverServers() {
    return [];
  },
  async configEntries() {
    return [{ client: "codex", path: getCodexConfigPath(), kind: "toml", scope: "user" }];
  },
  async watchTargets() {
    return {
      files: await integration$7.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  hooks: {
    supportedEvents: {
      "session-start": { nativeName: "SessionStart" },
      "session-end": { nativeName: "Stop" }
    },
    sessionIdStrategy: {
      kind: "unsupported",
      reason: "Codex does not expose a per-conversation id to hooks."
    },
    inject: injectCodexHook,
    remove: removeCodexHook,
    getStatus: getCodexHookStatus
  },
  backups: {
    globs: () => [`${getCodexConfigPath()}.backup.*`]
  }
};
function getCursorHooksPath() {
  return path.join(os.homedir(), ".cursor", "hooks.json");
}
function isCursorInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".cursor")) && appInstalled({
    mac: ["Cursor.app"],
    win: ["cursor\\Cursor.exe"],
    linux: ["cursor"]
  });
}
async function injectCursorHook() {
  const hooksPath = getCursorHooksPath();
  const scriptPath = await ensureHookScript();
  const sessionScriptPath = await ensureSessionHookScript();
  const sessionEndScriptPath = await ensureSessionEndHookScript();
  const hooksDir = path.dirname(hooksPath);
  if (!fs.existsSync(hooksDir)) {
    await fs.promises.mkdir(hooksDir, { recursive: true });
  }
  let hooksFile = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const content = await fs.promises.readFile(hooksPath, "utf-8");
      hooksFile = JSON.parse(content);
    } catch {
      hooksFile = { version: 1, hooks: {} };
    }
  }
  if (!hooksFile.hooks) hooksFile.hooks = {};
  let injected = false;
  const existingSessionStart = hooksFile.hooks.sessionStart ?? [];
  const hasEdisonSessionStart = existingSessionStart.some((h) => h.command?.includes("edison-hook"));
  if (!hasEdisonSessionStart) {
    hooksFile.hooks.sessionStart = [
      ...existingSessionStart,
      { command: `"${scriptPath}" cursor`, type: "command" }
    ];
    injected = true;
  }
  const existingBeforeMCP = hooksFile.hooks.beforeMCPExecution ?? [];
  const hasEdisonBeforeMCP = existingBeforeMCP.some((h) => h.command?.includes("edison-session-hook"));
  if (!hasEdisonBeforeMCP) {
    hooksFile.hooks.beforeMCPExecution = [
      ...existingBeforeMCP,
      { command: `"${sessionScriptPath}"`, type: "command" }
    ];
    injected = true;
  }
  const existingPreToolUse = hooksFile.hooks.preToolUse ?? [];
  const filteredPreToolUse = existingPreToolUse.filter((h) => !h.command?.includes("edison-session-hook"));
  if (filteredPreToolUse.length !== existingPreToolUse.length) {
    if (filteredPreToolUse.length > 0) {
      hooksFile.hooks.preToolUse = filteredPreToolUse;
    } else {
      delete hooksFile.hooks.preToolUse;
    }
    injected = true;
  }
  const existingSessionEnd = hooksFile.hooks.sessionEnd ?? [];
  const hasEdisonSessionEnd = existingSessionEnd.some((h) => h.command?.includes("edison-session-end"));
  if (!hasEdisonSessionEnd) {
    hooksFile.hooks.sessionEnd = [
      ...existingSessionEnd,
      { command: `"${sessionEndScriptPath}"`, type: "command" }
    ];
    injected = true;
  }
  if (!injected) {
    console.log("[HookInjection] Edison hooks already exist in Cursor hooks");
    return false;
  }
  if (fs.existsSync(hooksPath)) {
    const backupPath = `${hooksPath}.backup.${Date.now()}`;
    await fs.promises.copyFile(hooksPath, backupPath);
    console.log(`[HookInjection] Backed up Cursor hooks to ${backupPath}`);
  }
  await fs.promises.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), "utf-8");
  console.log("[HookInjection] Injected Edison hook into Cursor hooks");
  return true;
}
async function removeCursorHook() {
  const hooksPath = getCursorHooksPath();
  if (!fs.existsSync(hooksPath)) return false;
  const content = await fs.promises.readFile(hooksPath, "utf-8");
  const hooksFile = JSON.parse(content);
  let removed = false;
  const existingSessionStart = hooksFile.hooks?.sessionStart ?? [];
  const filteredSessionStart = existingSessionStart.filter((h) => !h.command?.includes("edison-hook"));
  if (filteredSessionStart.length !== existingSessionStart.length) {
    removed = true;
    if (filteredSessionStart.length > 0) {
      hooksFile.hooks.sessionStart = filteredSessionStart;
    } else {
      delete hooksFile.hooks.sessionStart;
    }
  }
  const existingBeforeMCP = hooksFile.hooks?.beforeMCPExecution ?? [];
  const filteredBeforeMCP = existingBeforeMCP.filter((h) => !h.command?.includes("edison-session-hook"));
  if (filteredBeforeMCP.length !== existingBeforeMCP.length) {
    removed = true;
    if (filteredBeforeMCP.length > 0) {
      hooksFile.hooks.beforeMCPExecution = filteredBeforeMCP;
    } else {
      delete hooksFile.hooks.beforeMCPExecution;
    }
  }
  const existingPreToolUse = hooksFile.hooks?.preToolUse ?? [];
  const filteredPreToolUse = existingPreToolUse.filter((h) => !h.command?.includes("edison-session-hook"));
  if (filteredPreToolUse.length !== existingPreToolUse.length) {
    removed = true;
    if (filteredPreToolUse.length > 0) {
      hooksFile.hooks.preToolUse = filteredPreToolUse;
    } else {
      delete hooksFile.hooks.preToolUse;
    }
  }
  const existingSessionEnd = hooksFile.hooks?.sessionEnd ?? [];
  const filteredSessionEnd = existingSessionEnd.filter((h) => !h.command?.includes("edison-session-end"));
  if (filteredSessionEnd.length !== existingSessionEnd.length) {
    removed = true;
    if (filteredSessionEnd.length > 0) {
      hooksFile.hooks.sessionEnd = filteredSessionEnd;
    } else {
      delete hooksFile.hooks.sessionEnd;
    }
  }
  if (!removed) {
    console.log("[HookInjection] No Edison hook found in Cursor hooks");
    return false;
  }
  await fs.promises.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), "utf-8");
  console.log("[HookInjection] Removed Edison hook from Cursor hooks");
  return true;
}
const CURSOR_TOTAL_HOOKS = 3;
async function getCursorHookStatus() {
  const installed2 = isCursorInstalled();
  let hookCount = 0;
  if (installed2) {
    try {
      const hooksPath = getCursorHooksPath();
      if (fs.existsSync(hooksPath)) {
        const content = await fs.promises.readFile(hooksPath, "utf-8");
        const hooksFile = JSON.parse(content);
        const sessionStart = hooksFile.hooks?.sessionStart ?? [];
        const beforeMCP = hooksFile.hooks?.beforeMCPExecution ?? [];
        const preToolUse = hooksFile.hooks?.preToolUse ?? [];
        const sessionEnd = hooksFile.hooks?.sessionEnd ?? [];
        if (sessionStart.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"))) hookCount++;
        if (beforeMCP.some((h) => h.command?.includes("edison-session-hook")) || preToolUse.some((h) => h.command?.includes("edison-session-hook"))) hookCount++;
        if (sessionEnd.some((h) => h.command?.includes("edison-session-end"))) hookCount++;
      }
    } catch {
    }
  }
  return { installed: installed2, hasHook: hookCount === CURSOR_TOTAL_HOOKS, hookCount, totalHooks: CURSOR_TOTAL_HOOKS };
}
const meta$3 = CLIENT_DISPLAY["cursor"];
const integration$6 = {
  id: "cursor",
  display: { name: meta$3.name, brandColor: meta$3.brandColor },
  isInstalled: isCursorInstalled,
  async discoverServers() {
    const [file, state] = await Promise.all([
      discoverCursor(),
      discoverCursorMarketplaceMcps()
    ]);
    const known = new Set(file.map((s) => s.name.toLowerCase()));
    return [...file, ...state.filter((s) => !known.has(s.name.toLowerCase()))];
  },
  async configEntries() {
    const entries = [
      { client: "cursor", path: getCursorConfigPath(), kind: "jsonc", scope: "user" },
      { client: "cursor", path: getCursorStateDbPath(), kind: "sqlite-state", scope: "marketplace" }
    ];
    for (const p of getCursorPluginsInstalledPaths()) {
      entries.push({
        client: "cursor",
        path: p,
        kind: "json",
        scope: "plugin-registry",
        triggersDynamicRescan: "cursor-plugins"
      });
    }
    for (const p of await getCursorProjectMcpPaths()) {
      entries.push({ client: "cursor", path: p, kind: "jsonc", scope: "project" });
    }
    for (const p of await getCursorPluginMcpPaths()) {
      entries.push({ client: "cursor", path: p, kind: "json", scope: "user" });
    }
    return entries;
  },
  async watchTargets() {
    const dirs = [
      {
        path: getCursorWorkspaceStoragePath(),
        depth: 1,
        onChange: "rescan-dynamic-config-paths"
      },
      {
        path: getCursorPluginCachePath(),
        depth: 3,
        onChange: "rescan-dynamic-config-paths"
      }
    ];
    return {
      files: await integration$6.configEntries(),
      dirs,
      // State DB writes aren't file-touch events; rescan periodically so
      // marketplace installs and Extension API registrations are picked up.
      needsPeriodicRescan: true
    };
  },
  hooks: {
    supportedEvents: {
      "session-start": { nativeName: "sessionStart" },
      "pre-tool-use": { nativeName: "beforeMCPExecution" },
      "session-end": { nativeName: "sessionEnd" }
    },
    sessionIdStrategy: { kind: "native-stdin", field: "conversation_id" },
    inject: injectCursorHook,
    remove: removeCursorHook,
    getStatus: getCursorHookStatus
  },
  backups: {
    globs: () => [
      `${getCursorConfigPath()}.backup.*`,
      `${getCursorHooksPath()}.backup.*`
    ]
  }
};
function getVsCodeCopilotHooksPath() {
  return path.join(os.homedir(), ".copilot", "hooks", "edison-watch.json");
}
function isVsCodeCopilotInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".copilot"));
}
async function injectVsCodeCopilotHook() {
  const hooksPath = getVsCodeCopilotHooksPath();
  const scriptPath = await ensureHookScript();
  const sessionScriptPath = await ensureSessionHookScript();
  const sessionStartScriptPath = await ensureSessionStartHookScript();
  const sessionEndScriptPath = await ensureSessionEndHookScript();
  if (fs.existsSync(hooksPath)) {
    try {
      const content = await fs.promises.readFile(hooksPath, "utf-8");
      const existing = JSON.parse(content);
      const hasSessionStart = existing.hooks?.SessionStart?.some((h) => h.command?.includes("edison-session-start"));
      const hasUserPrompt = existing.hooks?.UserPromptSubmit?.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"));
      const hasPreToolUse = existing.hooks?.PreToolUse?.some((h) => h.command?.includes("edison-session-hook") && !h.command?.includes("edison-session-end"));
      const hasStop = existing.hooks?.Stop?.some((h) => h.command?.includes("edison-session-end"));
      if (hasSessionStart && hasUserPrompt && hasPreToolUse && hasStop) {
        console.log("[HookInjection] Edison hooks already exist in VSCode Copilot hooks");
        return false;
      }
    } catch {
    }
  }
  const hooksDir = path.dirname(hooksPath);
  if (!fs.existsSync(hooksDir)) {
    await fs.promises.mkdir(hooksDir, { recursive: true });
  }
  const hooksFile = {
    hooks: {
      SessionStart: [{ type: "command", command: `"${sessionStartScriptPath}"` }],
      UserPromptSubmit: [{ type: "command", command: `"${scriptPath}" vscode` }],
      PreToolUse: [{ type: "command", command: `"${sessionScriptPath}"` }],
      Stop: [{ type: "command", command: `"${sessionEndScriptPath}"` }]
    }
  };
  if (fs.existsSync(hooksPath)) {
    await fs.promises.copyFile(hooksPath, `${hooksPath}.backup.${Date.now()}`);
  }
  await fs.promises.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), "utf-8");
  console.log("[HookInjection] Injected Edison hooks into VSCode Copilot hooks");
  return true;
}
async function removeVsCodeCopilotHook() {
  const hooksPath = getVsCodeCopilotHooksPath();
  if (!fs.existsSync(hooksPath)) return false;
  await fs.promises.unlink(hooksPath);
  console.log("[HookInjection] Removed Edison hooks from VSCode Copilot");
  return true;
}
const VSCODE_TASK_LABEL = "Edison Watch Registration";
async function injectVsCodeWorkspaceHook(workspacePath) {
  const vscodePath = path.join(workspacePath, ".vscode");
  const tasksPath = path.join(vscodePath, "tasks.json");
  const scriptPath = await ensureHookScript();
  let tasksFile = { version: "2.0.0", tasks: [] };
  if (fs.existsSync(tasksPath)) {
    try {
      const content = await fs.promises.readFile(tasksPath, "utf-8");
      tasksFile = JSON.parse(content);
    } catch {
      tasksFile = { version: "2.0.0", tasks: [] };
    }
  }
  if (!Array.isArray(tasksFile.tasks)) tasksFile.tasks = [];
  const alreadyExists = tasksFile.tasks.some((t) => t.label === VSCODE_TASK_LABEL);
  if (alreadyExists) return false;
  if (fs.existsSync(tasksPath)) {
    await fs.promises.copyFile(tasksPath, `${tasksPath}.backup.${Date.now()}`);
  }
  await fs.promises.mkdir(vscodePath, { recursive: true });
  tasksFile.tasks.push({
    label: VSCODE_TASK_LABEL,
    type: "shell",
    command: `"${scriptPath}"`,
    args: ["vscode"],
    runOptions: { runOn: "folderOpen" },
    presentation: { reveal: "never", panel: "shared" }
  });
  await fs.promises.writeFile(tasksPath, JSON.stringify(tasksFile, null, 2), "utf-8");
  console.log(`[HookInjection] Injected VS Code workspace hook into ${tasksPath}`);
  return true;
}
async function removeVsCodeWorkspaceHook(workspacePath) {
  const tasksPath = path.join(workspacePath, ".vscode", "tasks.json");
  if (!fs.existsSync(tasksPath)) return false;
  let tasksFile;
  try {
    const content = await fs.promises.readFile(tasksPath, "utf-8");
    tasksFile = JSON.parse(content);
  } catch {
    return false;
  }
  const before = tasksFile.tasks?.length ?? 0;
  tasksFile.tasks = (tasksFile.tasks ?? []).filter((t) => t.label !== VSCODE_TASK_LABEL);
  if (tasksFile.tasks.length === before) return false;
  await fs.promises.writeFile(tasksPath, JSON.stringify(tasksFile, null, 2), "utf-8");
  console.log(`[HookInjection] Removed VS Code workspace hook from ${tasksPath}`);
  return true;
}
const VSCODE_INSTALL_HINTS = {
  mac: ["Visual Studio Code.app"],
  win: ["Microsoft VS Code\\Code.exe"],
  linux: ["code"]
};
async function getVsCodeHookStatus() {
  if (!appInstalled(VSCODE_INSTALL_HINTS)) {
    return { installed: false, hasHook: false, hookCount: 0, totalHooks: 1 };
  }
  try {
    const workspacePaths = await getVsCodeWorkspacePaths();
    let hookCount = 0;
    let totalHooks = 0;
    if (workspacePaths.length > 0) totalHooks++;
    for (const wsPath of workspacePaths) {
      const tasksPath = path.join(wsPath, ".vscode", "tasks.json");
      if (!fs.existsSync(tasksPath)) continue;
      try {
        const content = await fs.promises.readFile(tasksPath, "utf-8");
        const tasksFile = JSON.parse(content);
        if (tasksFile.tasks?.some((t) => t.label === VSCODE_TASK_LABEL)) {
          hookCount++;
          break;
        }
      } catch {
      }
    }
    const copilotInstalled = isVsCodeCopilotInstalled();
    if (copilotInstalled) {
      totalHooks += 4;
      try {
        const copilotHooksPath = getVsCodeCopilotHooksPath();
        if (fs.existsSync(copilotHooksPath)) {
          const content = await fs.promises.readFile(copilotHooksPath, "utf-8");
          const hooksFile = JSON.parse(content);
          if (hooksFile.hooks?.SessionStart?.some((h) => h.command?.includes("edison-session-start"))) hookCount++;
          if (hooksFile.hooks?.UserPromptSubmit?.some((h) => h.command?.includes("edison-hook") && !h.command?.includes("edison-session-hook"))) hookCount++;
          if (hooksFile.hooks?.PreToolUse?.some((h) => h.command?.includes("edison-session-hook") && !h.command?.includes("edison-session-end"))) hookCount++;
          if (hooksFile.hooks?.Stop?.some((h) => h.command?.includes("edison-session-end"))) hookCount++;
        }
      } catch {
      }
    }
    const installed2 = workspacePaths.length > 0 || copilotInstalled;
    return {
      installed: installed2,
      hasHook: totalHooks > 0 && hookCount === totalHooks,
      hookCount,
      totalHooks
    };
  } catch {
    return { installed: false, hasHook: false, hookCount: 0, totalHooks: 1 };
  }
}
const meta$2 = CLIENT_DISPLAY["vscode"];
const integration$5 = {
  id: "vscode",
  display: { name: meta$2.name, brandColor: meta$2.brandColor },
  isInstalled() {
    return appInstalled(VSCODE_INSTALL_HINTS);
  },
  async discoverServers() {
    const results = [];
    try {
      await fs.promises.access(getVscodeUserMcpPath());
      results.push(...await parseVscodeMcpJson(getVscodeUserMcpPath(), "vscode"));
    } catch {
    }
    const state = await discoverVscodeStateMcps("vscode");
    const known = new Set(results.map((s) => s.name.toLowerCase()));
    for (const s of state) {
      if (!known.has(s.name.toLowerCase())) results.push(s);
    }
    return results;
  },
  async configEntries() {
    return [
      { client: "vscode", path: getVscodeUserMcpPath(), kind: "json", scope: "user" },
      { client: "vscode", path: getVscodeStateDbPath(), kind: "sqlite-state", scope: "marketplace" }
    ];
  },
  async watchTargets() {
    return {
      files: await integration$5.configEntries(),
      dirs: [],
      needsPeriodicRescan: true
    };
  },
  hooks: {
    supportedEvents: {
      "session-start": { nativeName: "SessionStart" },
      "user-prompt-submit": { nativeName: "UserPromptSubmit" },
      "pre-tool-use": { nativeName: "PreToolUse" },
      "session-end": { nativeName: "Stop" }
    },
    sessionIdStrategy: { kind: "native-stdin", field: "sessionId" },
    inject: async () => {
      if (!isVsCodeCopilotInstalled()) return false;
      return injectVsCodeCopilotHook();
    },
    remove: removeVsCodeCopilotHook,
    getStatus: getVsCodeHookStatus
  },
  backups: {
    globs: () => [
      `${getVscodeUserMcpPath()}.backup.*`,
      `${getVsCodeCopilotHooksPath()}.backup.*`
    ]
  }
};
function getWindsurfHooksPath() {
  return path.join(os.homedir(), ".codeium", "windsurf", "hooks.json");
}
function isWindsurfInstalled() {
  return fs.existsSync(path.join(os.homedir(), ".codeium", "windsurf")) && appInstalled({
    mac: ["Windsurf.app"],
    win: ["Windsurf\\Windsurf.exe"],
    linux: ["windsurf"]
  });
}
async function injectWindsurfHook() {
  const hooksPath = getWindsurfHooksPath();
  const scriptPath = await ensureHookScript();
  const hooksDir = path.dirname(hooksPath);
  if (!fs.existsSync(hooksDir)) {
    await fs.promises.mkdir(hooksDir, { recursive: true });
  }
  let hooksFile = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const content = await fs.promises.readFile(hooksPath, "utf-8");
      hooksFile = JSON.parse(content);
    } catch {
      hooksFile = { hooks: {} };
    }
  }
  if (!hooksFile.hooks) hooksFile.hooks = {};
  const existingHooks = hooksFile.hooks.pre_user_prompt ?? [];
  const hasEdisonHook = existingHooks.some((h) => h.command?.includes("edison-hook"));
  if (hasEdisonHook) {
    console.log("[HookInjection] Edison hook already exists in Windsurf hooks");
    return false;
  }
  hooksFile.hooks.pre_user_prompt = [
    ...existingHooks,
    { command: `"${scriptPath}" windsurf`, show_output: false }
  ];
  if (fs.existsSync(hooksPath)) {
    await fs.promises.copyFile(hooksPath, `${hooksPath}.backup.${Date.now()}`);
    console.log("[HookInjection] Backed up Windsurf hooks");
  }
  await fs.promises.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), "utf-8");
  console.log("[HookInjection] Injected Edison hook into Windsurf hooks");
  return true;
}
async function removeWindsurfHook() {
  const hooksPath = getWindsurfHooksPath();
  if (!fs.existsSync(hooksPath)) return false;
  const content = await fs.promises.readFile(hooksPath, "utf-8");
  const hooksFile = JSON.parse(content);
  const existingHooks = hooksFile.hooks?.pre_user_prompt ?? [];
  const filteredHooks = existingHooks.filter((h) => !h.command?.includes("edison-hook"));
  if (filteredHooks.length === existingHooks.length) {
    console.log("[HookInjection] No Edison hook found in Windsurf hooks");
    return false;
  }
  if (filteredHooks.length > 0) {
    hooksFile.hooks.pre_user_prompt = filteredHooks;
  } else {
    delete hooksFile.hooks.pre_user_prompt;
  }
  await fs.promises.writeFile(hooksPath, JSON.stringify(hooksFile, null, 2), "utf-8");
  console.log("[HookInjection] Removed Edison hook from Windsurf hooks");
  return true;
}
const WINDSURF_TOTAL_HOOKS = 1;
async function getWindsurfHookStatus() {
  const installed2 = isWindsurfInstalled();
  let hasHook = false;
  if (installed2) {
    try {
      const hooksPath = getWindsurfHooksPath();
      if (fs.existsSync(hooksPath)) {
        const content = await fs.promises.readFile(hooksPath, "utf-8");
        const hooksFile = JSON.parse(content);
        const hooks = hooksFile.hooks?.pre_user_prompt ?? [];
        hasHook = hooks.some((h) => h.command?.includes("edison-hook"));
      }
    } catch {
    }
  }
  return { installed: installed2, hasHook, hookCount: hasHook ? 1 : 0, totalHooks: WINDSURF_TOTAL_HOOKS };
}
const meta$1 = CLIENT_DISPLAY["windsurf"];
const integration$4 = {
  id: "windsurf",
  display: { name: meta$1.name, brandColor: meta$1.brandColor },
  isInstalled: isWindsurfInstalled,
  discoverServers: discoverWindsurf,
  async configEntries() {
    return [{ client: "windsurf", path: getWindsurfConfigPath(), kind: "json", scope: "user" }];
  },
  async watchTargets() {
    return {
      files: await integration$4.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  hooks: {
    supportedEvents: {
      "user-prompt-submit": { nativeName: "pre_user_prompt" }
    },
    sessionIdStrategy: {
      kind: "heuristic",
      note: "Windsurf pre_user_prompt does not expose a session id."
    },
    inject: injectWindsurfHook,
    remove: removeWindsurfHook,
    getStatus: getWindsurfHookStatus
  },
  backups: {
    globs: () => [
      `${getWindsurfConfigPath()}.backup.*`,
      `${getWindsurfHooksPath()}.backup.*`
    ]
  }
};
const meta = CLIENT_DISPLAY["zed"];
const integration$3 = {
  id: "zed",
  display: { name: meta.name, brandColor: meta.brandColor },
  isInstalled() {
    return fs.existsSync(path.dirname(getZedConfigPath())) && appInstalled({
      mac: ["Zed.app"],
      win: ["Zed\\zed.exe"],
      linux: ["zed", "zeditor"]
    });
  },
  discoverServers: discoverZed,
  async configEntries() {
    return [{ client: "zed", path: getZedConfigPath(), kind: "json", scope: "user" }];
  },
  async watchTargets() {
    return {
      files: await integration$3.configEntries(),
      dirs: [],
      needsPeriodicRescan: false
    };
  },
  backups: {
    globs: () => [`${getZedConfigPath()}.backup.*`]
  }
};
function getJetBrainsBaseDir() {
  const plat = os.platform();
  if (plat === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "JetBrains");
  }
  if (plat === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "JetBrains");
  }
  return null;
}
const JETBRAINS_IDE_PREFIXES = [
  { prefix: "IntelliJIdea", client: "intellij" },
  { prefix: "PyCharm", client: "pycharm" },
  { prefix: "WebStorm", client: "webstorm" }
];
async function getInstalledJetBrainsIdes() {
  const base = getJetBrainsBaseDir();
  if (!base) return /* @__PURE__ */ new Set();
  const result = /* @__PURE__ */ new Set();
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      for (const { prefix, client } of JETBRAINS_IDE_PREFIXES) {
        if (dirent.name.startsWith(prefix)) {
          result.add(client);
          break;
        }
      }
    }
  } catch {
  }
  return result;
}
async function getJetBrainsMcpConfigPaths() {
  const base = getJetBrainsBaseDir();
  if (!base) return [];
  const result = [];
  try {
    const entries = await fs.promises.readdir(base, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      for (const { prefix, client } of JETBRAINS_IDE_PREFIXES) {
        if (name.startsWith(prefix)) {
          const serversPath = path.join(base, name, "mcp", "servers.json");
          try {
            await fs.promises.access(serversPath);
            result.push({ client, path: serversPath });
          } catch {
          }
          break;
        }
      }
    }
  } catch {
  }
  return result;
}
async function parseJetBrainsServersJson(filePath, client) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const servers = [];
  const entries = Object.entries(json.mcpServers ?? {});
  for (const [name, cfg] of entries) {
    servers.push({
      name,
      client,
      source: "user",
      path: filePath,
      config: cfg
    });
  }
  return servers;
}
const MAC_APP_NAMES = {
  vscode: ["Visual Studio Code.app"],
  cursor: ["Cursor.app"],
  // Claude Desktop and Cowork ship the same .app bundle. Cowork is
  // distinguished only by the `vm_bundles/` sibling directory under
  // ~/Library/Application Support/Claude/, which is checked separately
  // (see clients/claude-cowork/index.ts and the detectClients handler).
  "claude-desktop": ["Claude.app"],
  "claude-cowork": ["Claude.app"],
  windsurf: ["Windsurf.app"],
  zed: ["Zed.app"],
  intellij: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Ultimate.app"],
  pycharm: ["PyCharm.app", "PyCharm CE.app"],
  webstorm: ["WebStorm.app"]
};
async function macAppExists(clientId) {
  if (os.platform() !== "darwin") return true;
  const appNames = MAC_APP_NAMES[clientId];
  if (!appNames) return true;
  for (const appName of appNames) {
    try {
      await fs.promises.access(path.join("/Applications", appName));
      return true;
    } catch {
    }
    try {
      await fs.promises.access(path.join(os.homedir(), "Applications", appName));
      return true;
    } catch {
    }
  }
  return false;
}
const JETBRAINS_WIN_EXES = {
  intellij: [
    "JetBrains\\IntelliJ IDEA Ultimate\\bin\\idea64.exe",
    "JetBrains\\IntelliJ IDEA Community Edition\\bin\\idea64.exe",
    "JetBrains\\Toolbox\\scripts\\idea.cmd"
  ],
  pycharm: [
    "JetBrains\\PyCharm Professional\\bin\\pycharm64.exe",
    "JetBrains\\PyCharm Community Edition\\bin\\pycharm64.exe",
    "JetBrains\\Toolbox\\scripts\\pycharm.cmd"
  ],
  webstorm: [
    "JetBrains\\WebStorm\\bin\\webstorm64.exe",
    "JetBrains\\Toolbox\\scripts\\webstorm.cmd"
  ]
};
const JETBRAINS_LINUX_BINS = {
  intellij: ["idea", "intellij-idea-ultimate", "intellij-idea-community", "jetbrains-idea", "jetbrains-idea-ce"],
  pycharm: ["pycharm", "pycharm-professional", "pycharm-community", "jetbrains-pycharm", "jetbrains-pycharm-ce"],
  webstorm: ["webstorm", "jetbrains-webstorm"]
};
function createJetBrainsIntegration(id) {
  const meta2 = CLIENT_DISPLAY[id];
  const hints = {
    mac: MAC_APP_NAMES[id] ?? [],
    win: JETBRAINS_WIN_EXES[id] ?? [],
    linux: JETBRAINS_LINUX_BINS[id] ?? []
  };
  const self = {
    id,
    display: { name: meta2.name, brandColor: meta2.brandColor },
    isInstalled() {
      return appInstalled(hints);
    },
    async discoverServers() {
      const installed2 = await getInstalledJetBrainsIdes();
      if (!installed2.has(id)) return [];
      const paths = await getJetBrainsMcpConfigPaths();
      const results = [];
      for (const { client, path: path2 } of paths) {
        if (client !== id) continue;
        try {
          results.push(...await parseJetBrainsServersJson(path2, client));
        } catch {
        }
      }
      return results;
    },
    async configEntries() {
      const paths = await getJetBrainsMcpConfigPaths();
      return paths.filter((p) => p.client === id).map((p) => ({ client: id, path: p.path, kind: "json", scope: "user" }));
    },
    async watchTargets() {
      return {
        files: await self.configEntries(),
        dirs: [],
        needsPeriodicRescan: false
      };
    },
    backups: {
      globs: () => []
      // JetBrains integration doesn't write backups today.
    }
  };
  return self;
}
const integration$2 = createJetBrainsIntegration("intellij");
const integration$1 = createJetBrainsIntegration("pycharm");
const integration = createJetBrainsIntegration("webstorm");
const CLIENTS = {
  "claude-code": integration$a,
  "claude-desktop": integration$9,
  "claude-cowork": integration$8,
  codex: integration$7,
  cursor: integration$6,
  vscode: integration$5,
  windsurf: integration$4,
  zed: integration$3,
  intellij: integration$2,
  pycharm: integration$1,
  webstorm: integration
};
const CLIENT_LIST = Object.values(CLIENTS);
async function getAllConfigEntries() {
  const perClient = await Promise.all(CLIENT_LIST.map((c) => c.configEntries()));
  return perClient.flat();
}
function buildEntryMap(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const e of entries) {
    map.set(e.path, e);
  }
  return map;
}
function getWatchablePaths(entries) {
  return entries.filter((e) => e.kind !== "sqlite-state").map((e) => e.path);
}
function isOpaqueConfig(config) {
  return "type" in config && config.type === "opaque";
}
function hasMalformedHeaders(config) {
  if (!("headers" in config)) return false;
  const headers = config.headers;
  if (headers === void 0 || headers === null) return false;
  if (typeof headers !== "object" || Array.isArray(headers) || Object.getPrototypeOf(headers) !== Object.prototype) {
    return true;
  }
  for (const v of Object.values(headers)) {
    if (typeof v !== "string") return true;
  }
  return false;
}
function describeUnsupportedReason(server) {
  if (isOpaqueConfig(server.config)) {
    if (server.client === "cursor" && server.source === "marketplace") {
      return "Cursor marketplace plugin: only SERVER_METADATA.json is exposed (no launch config)";
    }
    if (server.client === "vscode" && server.source === "marketplace") {
      return "VS Code-style extension-managed server: state DB exposes no launch URL or command";
    }
    if (server.source === "marketplace") {
      return `${server.client} marketplace install exposes no launch config`;
    }
    return "Opaque config (no launch command or URL surfaced by the host)";
  }
  if (hasMalformedHeaders(server.config)) {
    return 'Invalid `headers`: expected a JSON object mapping name → value (e.g. {"Authorization": "Bearer ..."})';
  }
  if ("command" in server.config && server.config.command) {
    return "Local stdio servers are not yet supported";
  }
  return null;
}
function sortedStringify(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const obj = value;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
}
function configFingerprint(config) {
  return sortedStringify(config);
}
function findDuplicateGroups(servers) {
  const groups = [];
  const byFp = /* @__PURE__ */ new Map();
  for (const s of servers) {
    const fp = configFingerprint(s.config);
    const group = byFp.get(fp) ?? [];
    group.push(s);
    byFp.set(fp, group);
  }
  for (const [fp, group] of byFp) {
    if (new Set(group.map((s) => s.name)).size > 1) {
      groups.push({
        fingerprint: fp,
        kind: "same-config",
        servers: group.map((s) => ({ name: s.name, originalName: s.originalName, client: s.client, clients: s.clients, config: s.config }))
      });
    }
  }
  const byOrigName = /* @__PURE__ */ new Map();
  for (const s of servers) {
    if (!s.originalName) continue;
    const group = byOrigName.get(s.originalName) ?? [];
    group.push(s);
    byOrigName.set(s.originalName, group);
  }
  for (const [origName, group] of byOrigName) {
    if (group.length > 1) {
      const isProfileConflict = group.length > 1 && new Set(group.map((s) => s.client)).size === 1 && group.some((s) => s.profileName);
      groups.push({
        fingerprint: isProfileConflict ? `profile-conflict:${origName}` : `name-conflict:${origName}`,
        kind: isProfileConflict ? "profile-conflict" : "name-conflict",
        servers: group.map((s) => ({ name: s.name, originalName: s.originalName, client: s.client, clients: s.clients, config: s.config, profileName: s.profileName }))
      });
    }
  }
  return groups;
}
function buildRemovalMap(raw, deduped) {
  const seenRaw = /* @__PURE__ */ new Set();
  const uniqueRaw = [];
  for (const s of raw) {
    const key = `${s.name}\0${s.path}\0${s.projectName ?? ""}\0${s.profileName ?? ""}`;
    if (!seenRaw.has(key)) {
      seenRaw.add(key);
      uniqueRaw.push(s);
    }
  }
  const rawByName = /* @__PURE__ */ new Map();
  for (const s of uniqueRaw) {
    const group = rawByName.get(s.name) ?? [];
    group.push(s);
    rawByName.set(s.name, group);
  }
  const map = /* @__PURE__ */ new Map();
  for (const server of deduped) {
    const origName = server.originalName ?? server.name;
    const rawEntries = rawByName.get(origName) ?? [];
    if (server.originalName) {
      const matched = rawEntries.filter(
        (r) => configsEqual(r.config, server.config) && r.path === server.path && r.projectName === server.projectName && r.profileName === server.profileName
      );
      map.set(server.name, matched.length > 0 ? matched : [server]);
    } else {
      map.set(server.name, rawEntries);
    }
  }
  return map;
}
const CLIENT_SHORT_ALIAS = {
  "vscode": "vscode",
  "cursor": "cursor",
  "claude-code": "ccode",
  "claude-desktop": "cdesktop",
  "claude-cowork": "ccowork",
  "windsurf": "windsurf",
  "zed": "zed",
  "codex": "codex",
  "intellij": "intellij",
  "pycharm": "pycharm",
  "webstorm": "webstorm"
};
function clientAlias(clientId) {
  return CLIENT_SHORT_ALIAS[clientId] ?? clientId;
}
function configsEqual(a, b) {
  return sortedStringify(a) === sortedStringify(b);
}
function deduplicateServers(servers) {
  const byName = /* @__PURE__ */ new Map();
  for (const s of servers) {
    const group = byName.get(s.name);
    if (group) group.push(s);
    else byName.set(s.name, [s]);
  }
  const result = [];
  for (const [, group] of byName) {
    const first = group[0];
    if (group.length === 1) {
      result.push({ ...first, clients: first.clients ?? [first.client] });
      continue;
    }
    const allSame = group.every((s) => configsEqual(s.config, first.config));
    if (allSame) {
      const clients = [...new Set(group.flatMap((s) => s.clients ?? [s.client]))];
      result.push({ ...first, clients });
    } else {
      const clientSet = new Set(group.map((s) => s.client));
      if (clientSet.size === group.length) {
        for (const s of group) {
          result.push({ ...s, name: `${s.name}_${clientAlias(s.client)}`, originalName: s.name, clients: s.clients ?? [s.client] });
        }
      } else {
        const clientCounter = /* @__PURE__ */ new Map();
        for (const s of group) {
          const alias = clientAlias(s.client);
          const count = (clientCounter.get(alias) ?? 0) + 1;
          clientCounter.set(alias, count);
          const hasSameClient = group.filter((o) => o.client === s.client).length > 1;
          const suffix = count > 1 || hasSameClient ? `${alias}_${count}` : alias;
          result.push({ ...s, name: `${s.name}_${suffix}`, originalName: s.name, clients: s.clients ?? [s.client] });
        }
      }
    }
  }
  return result;
}
const SECRET_PREFIXES = [
  "sk-",
  "sk_live_",
  "sk_test_",
  "ghp_",
  "gho_",
  "ghs_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xoxs-",
  "xapp-",
  "eyJ"
];
const CONNECTION_STRING_PREFIXES = ["mongodb+srv://", "postgres://", "mysql://"];
const SENSITIVE_KEY_WORDS = ["key", "token", "secret", "password", "credential", "auth", "bearer"];
const NON_SECRET_FLAGS = /* @__PURE__ */ new Set([
  "-y",
  "--yes",
  "-n",
  "--no",
  "--verbose",
  "--debug",
  "--quiet",
  "-q",
  "--version",
  "-v",
  "--help",
  "-h",
  "--port",
  "-p",
  "--host",
  "--name",
  "--config",
  "-c",
  "--output",
  "-o",
  "--input",
  "-i",
  "--dir",
  "--cwd",
  "--format",
  "--level",
  "--log-level",
  "--timeout",
  "--retry",
  "--max-retries"
]);
function isSensitiveKeyName(name) {
  const lower = name.toLowerCase();
  return SENSITIVE_KEY_WORDS.some((w) => lower.includes(w));
}
function isNonSecretFlag(flag) {
  return NON_SECRET_FLAGS.has(flag.toLowerCase());
}
function hasKnownSecretPrefix(value) {
  return SECRET_PREFIXES.some((p) => value.startsWith(p));
}
function isConnectionString(value) {
  return CONNECTION_STRING_PREFIXES.some((p) => value.startsWith(p));
}
function looksLikeNonSecret(value) {
  if (/^https?:\/\//.test(value)) return true;
  if (/^@[\w-]+\/[\w.-]+/.test(value)) return true;
  if (/^[a-z][\w.-]*$/.test(value) && !hasKnownSecretPrefix(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("~")) return true;
  if (/^[A-Z]:\\/.test(value)) return true;
  return false;
}
function looksLikeApiKey(value) {
  if (value.length < 32) return false;
  if (looksLikeNonSecret(value)) return false;
  const alphanumCount = (value.match(/[A-Za-z0-9_\-+/=]/g) || []).length;
  return alphanumCount / value.length > 0.85;
}
function extractAuthToken(value) {
  const headerMatch = value.match(/^(.*?(?:Bearer|Basic)\s+)(.+)$/i);
  if (headerMatch?.[1] !== void 0 && headerMatch[2] !== void 0) {
    const token = headerMatch[2];
    if (hasKnownSecretPrefix(token) || looksLikeApiKey(token) || token.length >= 8) {
      return { prefix: headerMatch[1], token };
    }
  }
  return null;
}
function isSecretValue(value) {
  return hasKnownSecretPrefix(value) || isConnectionString(value) || looksLikeApiKey(value);
}
function flagToVarName(flag) {
  return flag.replace(/^-+/, "").replace(/[-. ]/g, "_").toUpperCase();
}
function descriptionFor(context, varName) {
  switch (context) {
    case "arg":
      return `Secret value detected in command-line argument (${varName})`;
    case "env":
      return `Environment variable ${varName}`;
    case "header":
      return `HTTP header value for ${varName}`;
    case "url":
      return `Credential embedded in server URL`;
  }
}
function parseFlagValuePairs(args) {
  const pairs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === void 0 || !arg.startsWith("-")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      pairs.push({
        index: i,
        flag: arg.slice(0, eqIdx),
        value: arg.slice(eqIdx + 1),
        nextArg: false
      });
      continue;
    }
    const nextVal = args[i + 1];
    if (nextVal !== void 0 && !nextVal.startsWith("-")) {
      pairs.push({
        index: i,
        flag: arg,
        value: nextVal,
        nextArg: true
      });
    }
  }
  return pairs;
}
function ensureUniqueVarName(desired, existing, serverName) {
  if (!existing.has(desired)) return desired;
  const prefixed = `${serverName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${desired}`;
  if (!existing.has(prefixed)) return prefixed;
  let n = 2;
  while (existing.has(`${desired}_${n}`)) n++;
  return `${desired}_${n}`;
}
function detectSecrets(server) {
  const config = server.config;
  const usedNames = /* @__PURE__ */ new Set();
  const templateFields = {};
  const secretValues = {};
  if ("command" in config && config.command) {
    const clonedArgs = config.args ? [...config.args] : void 0;
    const clonedEnv = config.env ? { ...config.env } : void 0;
    if (clonedArgs && clonedArgs.length > 0) {
      const argsFields = {};
      const pairs = parseFlagValuePairs(clonedArgs);
      for (const pair of pairs) {
        if (isNonSecretFlag(pair.flag)) continue;
        const flagIsSensitive = isSensitiveKeyName(pair.flag);
        const authToken = extractAuthToken(pair.value);
        if (authToken) {
          const varName = ensureUniqueVarName(flagToVarName(pair.flag) + "_TOKEN", usedNames, server.name);
          usedNames.add(varName);
          argsFields[varName] = {
            description: descriptionFor("arg", varName),
            example: ""
          };
          secretValues[varName] = authToken.token;
          const replaced = `${authToken.prefix}{${varName}}`;
          if (pair.nextArg) {
            clonedArgs[pair.index + 1] = replaced;
          } else {
            clonedArgs[pair.index] = `${pair.flag}=${replaced}`;
          }
          continue;
        }
        const valueIsSecret = isSecretValue(pair.value);
        if (flagIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(flagToVarName(pair.flag), usedNames, server.name);
          usedNames.add(varName);
          argsFields[varName] = {
            description: descriptionFor("arg", varName),
            example: ""
          };
          secretValues[varName] = pair.value;
          if (pair.nextArg) {
            clonedArgs[pair.index + 1] = `{${varName}}`;
          } else {
            clonedArgs[pair.index] = `${pair.flag}={${varName}}`;
          }
        }
      }
      const pairIndices = /* @__PURE__ */ new Set();
      for (const p of pairs) {
        pairIndices.add(p.index);
        if (p.nextArg) pairIndices.add(p.index + 1);
      }
      for (let i = 0; i < clonedArgs.length; i++) {
        if (pairIndices.has(i)) continue;
        const arg = clonedArgs[i];
        if (arg === void 0 || arg.startsWith("-") || arg.startsWith("{")) continue;
        const authToken = extractAuthToken(arg);
        if (authToken) {
          const varName = ensureUniqueVarName(
            `${server.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_TOKEN`,
            usedNames,
            server.name
          );
          usedNames.add(varName);
          argsFields[varName] = {
            description: descriptionFor("arg", varName),
            example: ""
          };
          secretValues[varName] = authToken.token;
          clonedArgs[i] = `${authToken.prefix}{${varName}}`;
          continue;
        }
        if (isSecretValue(arg)) {
          const varName = ensureUniqueVarName(
            `${server.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_SECRET`,
            usedNames,
            server.name
          );
          usedNames.add(varName);
          argsFields[varName] = {
            description: descriptionFor("arg", varName),
            example: ""
          };
          secretValues[varName] = arg;
          clonedArgs[i] = `{${varName}}`;
        }
      }
      if (Object.keys(argsFields).length > 0) {
        templateFields.args = argsFields;
      }
    }
    if (clonedEnv) {
      const envFields = {};
      for (const [key, value] of Object.entries(clonedEnv)) {
        const keyIsSensitive = isSensitiveKeyName(key);
        const authToken = extractAuthToken(value);
        if (authToken) {
          const varName = ensureUniqueVarName(key + "_TOKEN", usedNames, server.name);
          usedNames.add(varName);
          envFields[varName] = {
            description: descriptionFor("env", key),
            example: ""
          };
          secretValues[varName] = authToken.token;
          clonedEnv[key] = `${authToken.prefix}{${varName}}`;
          continue;
        }
        const valueIsSecret = isSecretValue(value);
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(key, usedNames, server.name);
          usedNames.add(varName);
          envFields[varName] = {
            description: descriptionFor("env", key),
            example: ""
          };
          secretValues[varName] = value;
          clonedEnv[key] = `{${varName}}`;
        }
      }
      if (Object.keys(envFields).length > 0) {
        templateFields.env = envFields;
      }
    }
    const clonedConfig = {
      command: config.command,
      ...clonedArgs && { args: clonedArgs },
      ...clonedEnv && { env: clonedEnv },
      ...config.envFile && { envFile: config.envFile }
    };
    return { config: clonedConfig, templateFields, secretValues };
  } else if ("url" in config && config.url) {
    let clonedUrl = config.url;
    const clonedHeaders = config.headers ? { ...config.headers } : void 0;
    try {
      const parsed = new URL(clonedUrl);
      if (parsed.username || parsed.password) {
        if (parsed.password) {
          const varName = ensureUniqueVarName("URL_PASSWORD", usedNames, server.name);
          usedNames.add(varName);
          secretValues[varName] = parsed.password;
          if (!templateFields.env) templateFields.env = {};
          templateFields.env[varName] = {
            description: descriptionFor("url", varName),
            example: ""
          };
          parsed.password = `{${varName}}`;
        }
        if (parsed.username) {
          const varName = ensureUniqueVarName("URL_USERNAME", usedNames, server.name);
          usedNames.add(varName);
          secretValues[varName] = parsed.username;
          if (!templateFields.env) templateFields.env = {};
          templateFields.env[varName] = {
            description: descriptionFor("url", varName),
            example: ""
          };
          parsed.username = `{${varName}}`;
        }
        clonedUrl = parsed.toString();
      }
      for (const [key, value] of [...parsed.searchParams.entries()]) {
        const keyIsSensitive = isSensitiveKeyName(key);
        const valueIsSecret = isSecretValue(value);
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(
            key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase(),
            usedNames,
            server.name
          );
          usedNames.add(varName);
          secretValues[varName] = value;
          if (!templateFields.env) templateFields.env = {};
          templateFields.env[varName] = {
            description: descriptionFor("url", varName),
            example: ""
          };
          clonedUrl = clonedUrl.replace(
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
            `${encodeURIComponent(key)}={${varName}}`
          );
          clonedUrl = clonedUrl.replace(
            `${key}=${value}`,
            `${key}={${varName}}`
          );
        }
      }
    } catch {
    }
    if (clonedHeaders) {
      const envFields = templateFields.env ?? {};
      for (const [key, value] of Object.entries(clonedHeaders)) {
        const keyIsSensitive = isSensitiveKeyName(key);
        const authToken = extractAuthToken(value);
        if (authToken) {
          const varName = ensureUniqueVarName(
            `${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_TOKEN`,
            usedNames,
            server.name
          );
          usedNames.add(varName);
          envFields[varName] = {
            description: descriptionFor("header", key),
            example: ""
          };
          secretValues[varName] = authToken.token;
          clonedHeaders[key] = `${authToken.prefix}{${varName}}`;
          continue;
        }
        const valueIsSecret = isSecretValue(value);
        if (keyIsSensitive || valueIsSecret) {
          const varName = ensureUniqueVarName(
            `${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_HEADER`,
            usedNames,
            server.name
          );
          usedNames.add(varName);
          envFields[varName] = {
            description: descriptionFor("header", key),
            example: ""
          };
          secretValues[varName] = value;
          clonedHeaders[key] = `{${varName}}`;
        }
      }
      if (Object.keys(envFields).length > 0) {
        templateFields.env = envFields;
      }
    }
    const clonedConfig = config.type ? { type: config.type, url: clonedUrl, ...clonedHeaders && { headers: clonedHeaders } } : { url: clonedUrl, ...clonedHeaders && { headers: clonedHeaders } };
    return { config: clonedConfig, templateFields, secretValues };
  }
  return { config: { ...config }, templateFields: {}, secretValues: {} };
}
function composeKey(orgId, fingerprint) {
  return `${orgId}:${fingerprint}`;
}
const TEMPLATE_PLACEHOLDER_RE = /\{[^{}]*\}/g;
function normalizePlaceholders(s) {
  return s.replace(TEMPLATE_PLACEHOLDER_RE, "{}");
}
function getServerFingerprint(server) {
  const { config: templatized } = detectSecrets(server);
  const config = templatized;
  let identifier;
  if ("command" in config && config.command) {
    const args = (config.args ?? []).map(normalizePlaceholders).join(" ");
    identifier = `${server.name}:${normalizePlaceholders(config.command)}:${args}`;
  } else if ("url" in config && config.url) {
    identifier = `${server.name}:${normalizePlaceholders(config.url)}`;
  } else {
    identifier = `${server.name}:${server.client}`;
  }
  return crypto.createHash("sha256").update(identifier).digest("hex").slice(0, 16);
}
class SeenServersStore {
  storePath;
  data = { servers: {} };
  loaded = false;
  constructor(storePath) {
    this.storePath = storePath ?? path.join(electron.app.getPath("userData"), "seen-servers.json");
  }
  async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw = await fs.promises.readFile(this.storePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "servers" in parsed) {
        const rawServers = parsed.servers;
        if (rawServers && typeof rawServers === "object") {
          const filtered = {};
          for (const [key, value] of Object.entries(rawServers)) {
            if (!value || typeof value !== "object") continue;
            const entry = value;
            if (typeof entry.org_id !== "string" || !entry.org_id || typeof entry.fingerprint !== "string" || !entry.fingerprint || key !== composeKey(entry.org_id, entry.fingerprint)) {
              continue;
            }
            filtered[key] = entry;
          }
          this.data = { servers: filtered };
        }
      }
    } catch {
      this.data = { servers: {} };
    }
    this.loaded = true;
  }
  async save() {
    try {
      await fs.promises.writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save seen servers store:", err);
    }
  }
  async hasSeen(orgId, server) {
    await this.ensureLoaded();
    return composeKey(orgId, getServerFingerprint(server)) in this.data.servers;
  }
  async hasAction(orgId, server) {
    await this.ensureLoaded();
    const seen = this.data.servers[composeKey(orgId, getServerFingerprint(server))];
    return seen?.action !== null && seen?.action !== void 0;
  }
  /**
   * Mark a server as seen under the given org, optionally with an action and
   * quarantine info.
   */
  async markSeen(orgId, server, action, quarantineInfo) {
    await this.ensureLoaded();
    const fingerprint = getServerFingerprint(server);
    const key = composeKey(orgId, fingerprint);
    const now = Date.now();
    const existing = this.data.servers[key];
    const finalAction = action ?? existing?.action ?? null;
    this.data.servers[key] = {
      org_id: orgId,
      fingerprint,
      name: server.name,
      sourceApp: server.client,
      configPath: server.path,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      action: finalAction,
      actionAt: action ? now : existing?.actionAt ?? null,
      disabledPath: quarantineInfo?.disabledPath ?? existing?.disabledPath,
      quarantinedAt: quarantineInfo?.quarantinedAt ?? existing?.quarantinedAt
    };
    console.log(
      `[SeenStore] markSeen org=${orgId} name=${server.name} fp=${fingerprint} action=${finalAction ?? "null"} (${existing ? "update" : "insert"})`
    );
    await this.save();
  }
  async markAction(orgId, fingerprint, action) {
    await this.ensureLoaded();
    const key = composeKey(orgId, fingerprint);
    if (this.data.servers[key]) {
      this.data.servers[key].action = action;
      this.data.servers[key].actionAt = Date.now();
      await this.save();
    }
  }
  /**
   * Upsert an entry from the backend's authoritative server list.
   * Backend wins: any existing local action is overwritten with the
   * backend-supplied action because the server-side view (approved or
   * pending admin review) is the strongest authority.
   *
   * `action` is 'registered' for approved TemplateMcpServerDefinitions rows
   * and 'requested' for pending mcp_server_requests rows - see
   * src/api/v1/routes/servers_fingerprints.py for the classification.
   */
  async markFromBackend(orgId, fingerprint, name, action) {
    await this.ensureLoaded();
    const key = composeKey(orgId, fingerprint);
    const now = Date.now();
    const existing = this.data.servers[key];
    this.data.servers[key] = {
      org_id: orgId,
      fingerprint,
      name: existing?.name ?? name,
      sourceApp: existing?.sourceApp ?? "",
      configPath: existing?.configPath ?? "",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: existing?.lastSeenAt ?? now,
      action,
      actionAt: now,
      disabledPath: existing?.disabledPath,
      quarantinedAt: existing?.quarantinedAt
    };
    console.log(
      `[SeenStore] markFromBackend org=${orgId} name=${name} fp=${fingerprint} action=${action} (${existing ? `update, was action=${existing.action}` : "insert"})`
    );
    await this.save();
  }
  async get(orgId, fingerprint) {
    await this.ensureLoaded();
    return this.data.servers[composeKey(orgId, fingerprint)] ?? null;
  }
  async getAll() {
    await this.ensureLoaded();
    return Object.values(this.data.servers);
  }
  /** Return all entries for a specific org. */
  async getAllForOrg(orgId) {
    await this.ensureLoaded();
    return Object.values(this.data.servers).filter((s) => s.org_id === orgId);
  }
  async remove(orgId, fingerprint) {
    await this.ensureLoaded();
    delete this.data.servers[composeKey(orgId, fingerprint)];
    await this.save();
  }
  /**
   * Delete any entries for the given org whose fingerprint is NOT in
   * `keepFingerprints`. Entries for other orgs are untouched.
   *
   * Used by the backend sync to reconcile the local store against the org's
   * authoritative server list after a fetch.
   */
  async pruneForOrg(orgId, keepFingerprints) {
    await this.ensureLoaded();
    const removed = [];
    for (const [key, entry] of Object.entries(this.data.servers)) {
      if (entry.org_id !== orgId) continue;
      if (keepFingerprints.has(entry.fingerprint)) continue;
      removed.push(`${entry.name}(fp=${entry.fingerprint} action=${entry.action})`);
      delete this.data.servers[key];
    }
    if (removed.length > 0) {
      console.log(`[SeenStore] pruneForOrg org=${orgId} removed ${removed.length} stale: ${removed.join(", ")}`);
      await this.save();
    } else {
      console.log(`[SeenStore] pruneForOrg org=${orgId} - nothing to prune (kept=${keepFingerprints.size})`);
    }
  }
  /** Clear all seen servers (for debugging/reset). */
  async clear() {
    this.data = { servers: {} };
    await this.save();
  }
}
let sharedInstance = null;
function getSharedSeenStore() {
  if (!sharedInstance) sharedInstance = new SeenServersStore();
  return sharedInstance;
}
const LAUNCHER_RE = /^(npx|bunx|pnpx|yarn|pnpm)$/;
function coerceArgs(raw) {
  if (Array.isArray(raw)) return raw.map((a) => String(a));
  if (typeof raw !== "string") return [];
  const out = [];
  const re = /[^\s'"]+|"([^"]*)"|'([^']*)'/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[0]);
  }
  return out;
}
const MCP_REMOTE_RE = /(^|\/)mcp-remote(@[\w.+-]+)?$/;
const VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--header",
  "-H",
  "--transport",
  "--client",
  "--port",
  "--callback-port"
]);
function unwrapStdioShim(config) {
  if (!("command" in config) || !config.command) return null;
  const command = String(config.command);
  const args = coerceArgs(config.args);
  let remoteIdx = -1;
  if (MCP_REMOTE_RE.test(command)) {
    remoteIdx = -1;
  } else if (LAUNCHER_RE.test(command)) {
    let start = 0;
    if ((command === "yarn" || command === "pnpm") && (args[0] === "dlx" || args[0] === "exec")) {
      start = 1;
    }
    for (let i2 = start; i2 < args.length; i2++) {
      const a = args[i2];
      if (a === void 0) continue;
      if (a.startsWith("-")) continue;
      if (MCP_REMOTE_RE.test(a)) {
        remoteIdx = i2;
        break;
      }
      return null;
    }
    if (remoteIdx < 0) return null;
  } else {
    return null;
  }
  let url2;
  const headers = {};
  let i = remoteIdx + 1;
  while (i < args.length) {
    const tok = args[i];
    if (tok === void 0) {
      i += 1;
      continue;
    }
    if (tok === "--header" || tok === "-H") {
      const value = args[i + 1];
      if (value) {
        const sep = value.indexOf(":");
        if (sep > 0) {
          const name = value.slice(0, sep).trim();
          const val = value.slice(sep + 1).trimStart();
          if (name) headers[name] = val;
        }
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (tok.startsWith("--") || tok.startsWith("-")) {
      const next = args[i + 1];
      const takesValue = VALUE_FLAGS.has(tok);
      const nextLooksLikeUrl = next !== void 0 && /^https?:\/\//i.test(next);
      if (next !== void 0 && !next.startsWith("-") && (takesValue || !nextLooksLikeUrl)) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (!url2 && /^https?:\/\//i.test(tok)) {
      url2 = tok;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (!url2) return null;
  const path2 = url2.split("?")[0].replace(/\/+$/, "");
  const type = path2.endsWith("/sse") ? "sse" : "http";
  return Object.keys(headers).length > 0 ? { type, url: url2, headers } : { type, url: url2 };
}
async function discoverMcpServers(opts) {
  const perClient = await Promise.all(CLIENT_LIST.map((c) => c.discoverServers()));
  const results = perClient.flat();
  for (const s of results) {
    const unwrapped = unwrapStdioShim(s.config);
    if (unwrapped) s.config = unwrapped;
  }
  const supported = [];
  const unsupportedRaw = [];
  for (const s of results) {
    if (isOpaqueConfig(s.config)) {
      unsupportedRaw.push(s);
    } else if (hasMalformedHeaders(s.config)) {
      unsupportedRaw.push(s);
    } else if ("command" in s.config && s.config.command) {
      unsupportedRaw.push(s);
    } else {
      supported.push(s);
    }
  }
  const unsupported = [];
  const seenUnsupported = /* @__PURE__ */ new Set();
  for (const s of unsupportedRaw) {
    const key = `${s.name}:${s.client}`;
    if (!seenUnsupported.has(key)) {
      seenUnsupported.add(key);
      unsupported.push(s);
    }
  }
  const deduped = deduplicateByNameAndConfig(supported);
  const wrap = (servers) => opts?.includeRaw ? { servers, raw: supported, unsupported } : servers;
  if (os.platform() !== "darwin") return wrap(deduped);
  const installedCache = /* @__PURE__ */ new Map();
  const filtered = [];
  for (const server of deduped) {
    const clientsToCheck = server.clients ?? [server.client];
    let anyInstalled = false;
    for (const c of clientsToCheck) {
      let installed2 = installedCache.get(c);
      if (installed2 === void 0) {
        installed2 = await macAppExists(c);
        installedCache.set(c, installed2);
      }
      if (installed2) {
        anyInstalled = true;
        break;
      }
    }
    if (anyInstalled) filtered.push(server);
  }
  return wrap(filtered);
}
function deduplicateByNameAndConfig(servers) {
  const byName = /* @__PURE__ */ new Map();
  for (const server of servers) {
    const group = byName.get(server.name) ?? [];
    group.push(server);
    byName.set(server.name, group);
  }
  const configKey = (s) => {
    const c = s.config;
    if ("command" in c && c.command) return JSON.stringify({ command: c.command, args: c.args ?? [] });
    if ("url" in c) return JSON.stringify({ url: c.url });
    return JSON.stringify(c);
  };
  const result = [];
  for (const [, group] of byName) {
    if (group.length === 1) {
      result.push({ ...group[0], clients: [group[0].client] });
      continue;
    }
    const seen = /* @__PURE__ */ new Map();
    for (const server of group) {
      const key = configKey(server);
      const existing = seen.get(key);
      if (existing) {
        const clients = existing.clients ?? [existing.client];
        if (!clients.includes(server.client)) clients.push(server.client);
        existing.clients = clients;
      } else {
        seen.set(key, { ...server, clients: [server.client] });
      }
    }
    const unique = [...seen.values()];
    if (unique.length === 1) {
      result.push(unique[0]);
    } else {
      const clientSet = new Set(unique.map((e) => e.client));
      if (clientSet.size === unique.length) {
        for (const entry of unique) {
          const alias = clientAlias(entry.client);
          result.push({ ...entry, name: `${entry.name}_${alias}`, originalName: entry.name });
        }
      } else {
        const clientCounter = /* @__PURE__ */ new Map();
        for (const entry of unique) {
          const alias = clientAlias(entry.client);
          const count = (clientCounter.get(alias) ?? 0) + 1;
          clientCounter.set(alias, count);
          const suffix = count > 1 || unique.filter((e) => e.client === entry.client).length > 1 ? `${alias}_${count}` : alias;
          result.push({ ...entry, name: `${entry.name}_${suffix}`, originalName: entry.name });
        }
      }
    }
  }
  return result;
}
const CURSOR_MCP_STATE_KEY = "anysphere.cursor-mcp";
async function quarantineCursorOAuthMcp(server) {
  const dbPath = server.path;
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY);
  if (!raw) {
    throw new Error(`Could not read ${CURSOR_MCP_STATE_KEY} from ${dbPath}`);
  }
  const state = JSON.parse(raw);
  const prefix = `[user-${server.name}] `;
  const removedEntries = {};
  const newState = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(prefix)) {
      removedEntries[key] = value;
    } else {
      newState[key] = value;
    }
  }
  if (Object.keys(removedEntries).length === 0) {
    throw new Error(`Server "${server.name}" not found in ${CURSOR_MCP_STATE_KEY}`);
  }
  await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(newState));
  console.log(`[MCP Quarantine SQLite] Removed "${server.name}" from ${CURSOR_MCP_STATE_KEY} in ${dbPath}`);
  return removedEntries;
}
async function removeCursorPluginFromStateDb(pluginDirPrefixes) {
  const dbPath = getCursorStateDbPath();
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY);
  if (!raw) return;
  const state = JSON.parse(raw);
  const newState = {};
  let removedCount = 0;
  for (const [key, value] of Object.entries(state)) {
    const matched = pluginDirPrefixes.some((p) => key.startsWith(`[${p}] `));
    if (matched) {
      removedCount++;
    } else {
      newState[key] = value;
    }
  }
  if (removedCount > 0) {
    await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(newState));
    console.log(`[MCP Quarantine SQLite] Removed ${removedCount} plugin entries from ${CURSOR_MCP_STATE_KEY}`);
  }
}
const CURSOR_SERVER_CONFIG_KEY = "cursorai/serverConfig";
async function removeCursorPluginsFromServerConfig(pluginNames) {
  const dbPath = getCursorStateDbPath();
  const raw = await queryStateDb(dbPath, CURSOR_SERVER_CONFIG_KEY);
  if (!raw) return;
  try {
    const config = JSON.parse(raw);
    const onboarding = config.onboardingConfig;
    if (!onboarding?.marketplacePluginNames || !Array.isArray(onboarding.marketplacePluginNames)) return;
    const removeSet = new Set(pluginNames.map((n) => n.toLowerCase()));
    const before = onboarding.marketplacePluginNames.length;
    onboarding.marketplacePluginNames = onboarding.marketplacePluginNames.filter(
      (name) => !removeSet.has(name.toLowerCase())
    );
    const removed = before - onboarding.marketplacePluginNames.length;
    if (removed > 0) {
      await updateStateDb(dbPath, CURSOR_SERVER_CONFIG_KEY, JSON.stringify(config));
      console.log(`[MCP Quarantine SQLite] Removed ${removed} plugin(s) from onboardingConfig.marketplacePluginNames`);
    }
  } catch (err) {
    console.warn(`[MCP Quarantine SQLite] Failed to update serverConfig:`, err);
  }
}
async function restoreCursorOAuthMcp(dbPath, entries) {
  const raw = await queryStateDb(dbPath, CURSOR_MCP_STATE_KEY);
  const state = raw ? JSON.parse(raw) : {};
  Object.assign(state, entries);
  await updateStateDb(dbPath, CURSOR_MCP_STATE_KEY, JSON.stringify(state));
  console.log(`[MCP Quarantine SQLite] Restored entries to ${CURSOR_MCP_STATE_KEY} in ${dbPath}`);
}
const VSCODE_MCP_TOOL_CACHE_KEY = "mcpToolCache";
async function quarantineVscodeExtensionMcp(server) {
  const dbPath = server.path;
  const raw = await queryStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY);
  if (!raw) {
    throw new Error(`Could not read ${VSCODE_MCP_TOOL_CACHE_KEY} from ${dbPath}`);
  }
  const cache = JSON.parse(raw);
  const removedData = {};
  const extIdx = cache.extensionServers.findIndex(
    (s) => s.id === server.name || s.label === server.name
  );
  if (extIdx !== -1) {
    removedData.extensionServer = cache.extensionServers.splice(extIdx, 1)[0];
  }
  const toolIdx = cache.serverTools.findIndex(
    ([id, entry]) => id === server.name || entry.serverName === server.name
  );
  if (toolIdx !== -1) {
    removedData.serverTool = cache.serverTools.splice(toolIdx, 1)[0];
  }
  if (Object.keys(removedData).length === 0) {
    throw new Error(`Server "${server.name}" not found in ${VSCODE_MCP_TOOL_CACHE_KEY}`);
  }
  await updateStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY, JSON.stringify(cache));
  console.log(`[MCP Quarantine SQLite] Removed "${server.name}" from ${VSCODE_MCP_TOOL_CACHE_KEY} in ${dbPath}`);
  return removedData;
}
async function restoreVscodeExtensionMcp(dbPath, serverName, removedData) {
  const raw = await queryStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY);
  if (!raw) {
    throw new Error(`Could not read ${VSCODE_MCP_TOOL_CACHE_KEY} from ${dbPath}`);
  }
  const cache = JSON.parse(raw);
  if (removedData.extensionServer) {
    cache.extensionServers.push(removedData.extensionServer);
  }
  if (removedData.serverTool) {
    cache.serverTools.push(removedData.serverTool);
  }
  await updateStateDb(dbPath, VSCODE_MCP_TOOL_CACHE_KEY, JSON.stringify(cache));
  console.log(`[MCP Quarantine SQLite] Restored "${serverName}" to ${VSCODE_MCP_TOOL_CACHE_KEY} in ${dbPath}`);
}
function getMarketplaceDisabledPath(stateDbPath) {
  const dir = path.dirname(stateDbPath);
  return path.join(dir, "disabled_marketplace_mcps.json");
}
async function readMarketplaceDisabledFile(disabledPath) {
  try {
    const content = await fs.promises.readFile(disabledPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { quarantinedBy: "Edison Watch", servers: {} };
  }
}
async function writeMarketplaceDisabledFile(disabledPath, data) {
  await fs.promises.writeFile(disabledPath, JSON.stringify(data, null, 2), "utf-8");
}
async function quarantineMarketplaceServer(server) {
  const dbPath = server.path;
  const disabledPath = getMarketplaceDisabledPath(dbPath);
  const quarantinedAt = (/* @__PURE__ */ new Date()).toISOString();
  console.log(`[MCP Quarantine] Quarantining marketplace server "${server.name}" from ${dbPath}`);
  let stateDbKey;
  let stateEntries;
  let cacheData;
  const isCursorDb = dbPath === getCursorStateDbPath();
  const isVscodeDb = dbPath === getVscodeStateDbPath();
  if (isCursorDb) {
    stateDbKey = "anysphere.cursor-mcp";
    stateEntries = await quarantineCursorOAuthMcp(server);
  } else if (isVscodeDb) {
    stateDbKey = "mcpToolCache";
    cacheData = await quarantineVscodeExtensionMcp(server);
  } else {
    throw new Error(`Unknown state database path for marketplace server: ${dbPath}`);
  }
  const disabledFile = await readMarketplaceDisabledFile(disabledPath);
  disabledFile.servers[server.name] = {
    originalFile: dbPath,
    quarantinedAt,
    stateDbKey,
    serverConfig: server.config,
    ...stateEntries && { stateEntries },
    ...cacheData && { cacheData }
  };
  await writeMarketplaceDisabledFile(disabledPath, disabledFile);
  console.log(`[MCP Quarantine] Stored marketplace server "${server.name}" in ${disabledPath}`);
  return { server, originalPath: dbPath, disabledPath, quarantinedAt };
}
async function restoreAllMarketplaceServers() {
  let restored = 0;
  const errors = [];
  const stateDbPaths = [getCursorStateDbPath(), getVscodeStateDbPath()];
  for (const dbPath of stateDbPaths) {
    const disabledPath = getMarketplaceDisabledPath(dbPath);
    try {
      await fs.promises.access(disabledPath);
    } catch {
      continue;
    }
    try {
      const disabledFile = await readMarketplaceDisabledFile(disabledPath);
      const serverNames = Object.keys(disabledFile.servers);
      if (serverNames.length === 0) {
        await fs.promises.unlink(disabledPath);
        continue;
      }
      const restoredNames = /* @__PURE__ */ new Set();
      for (const [name, entry] of Object.entries(disabledFile.servers)) {
        try {
          if (entry.stateEntries && entry.stateDbKey === "anysphere.cursor-mcp") {
            await restoreCursorOAuthMcp(dbPath, entry.stateEntries);
          } else if (entry.cacheData && entry.stateDbKey === "mcpToolCache") {
            await restoreVscodeExtensionMcp(dbPath, name, entry.cacheData);
          }
          restoredNames.add(name);
          restored++;
          console.log(`[MCP Quarantine Reset] Restored marketplace server "${name}" to ${dbPath}`);
        } catch (err) {
          const msg = `Failed to restore marketplace server "${name}" to ${dbPath}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`[MCP Quarantine Reset] ${msg}`);
          errors.push(msg);
        }
      }
      if (restoredNames.size === Object.keys(disabledFile.servers).length) {
        await fs.promises.unlink(disabledPath);
        console.log(`[MCP Quarantine Reset] Removed marketplace disabled file: ${disabledPath}`);
      } else if (restoredNames.size > 0) {
        for (const name of restoredNames) {
          delete disabledFile.servers[name];
        }
        await writeMarketplaceDisabledFile(disabledPath, disabledFile);
        console.log(`[MCP Quarantine Reset] Updated marketplace disabled file (kept ${Object.keys(disabledFile.servers).length} failed entries): ${disabledPath}`);
      }
    } catch (err) {
      const msg = `Failed to restore from ${disabledPath}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[MCP Quarantine Reset] ${msg}`);
      errors.push(msg);
    }
  }
  return { restored, errors };
}
const splitPath = (p) => p.split(/[/\\]/);
const CURSOR_PLUGIN_DISABLED_PREFIX = "ew-disabled-";
function stripDisabledPrefix(segment) {
  let s = segment;
  while (s.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) {
    s = s.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length);
  }
  return s;
}
function deriveCursorPluginDirPrefixes(server) {
  const parts = splitPath(server.path);
  const cacheIdx = parts.indexOf("cache");
  if (cacheIdx !== -1 && cacheIdx + 2 < parts.length) {
    const marketplace = stripDisabledPrefix(parts[cacheIdx + 1]);
    const pluginName = stripDisabledPrefix(parts[cacheIdx + 2]);
    return [
      `plugin-${pluginName}-${pluginName}`,
      `plugin-${marketplace}-${pluginName}`,
      `plugin-${pluginName}`
    ];
  }
  const name = stripDisabledPrefix(server.name);
  return [`plugin-${name}-${name}`, `plugin-${name}`];
}
async function quarantineCursorPlugin(server) {
  const pathParts = splitPath(server.path);
  if (pathParts.some((p) => p.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX))) {
    console.log(`[MCP Quarantine] Skipping "${server.name}" - path already contains ew-disabled-: ${server.path}`);
    return null;
  }
  const projectsDir = getCursorProjectsDir();
  const prefixes = deriveCursorPluginDirPrefixes(server);
  const quarantinedAt = (/* @__PURE__ */ new Date()).toISOString();
  let disabledCount = 0;
  console.log(`[MCP Quarantine] Quarantining Cursor plugin "${server.name}" - dirs: ${prefixes.join(", ")}`);
  try {
    const projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue;
      const mcpsDir = path.join(projectsDir, projDir.name, "mcps");
      try {
        const mcpEntries = await fs.promises.readdir(mcpsDir, { withFileTypes: true });
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory()) continue;
          if (mcpDir.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue;
          if (!prefixes.includes(mcpDir.name)) continue;
          const oldPath = path.join(mcpsDir, mcpDir.name);
          const newPath = path.join(mcpsDir, `${CURSOR_PLUGIN_DISABLED_PREFIX}${mcpDir.name}`);
          try {
            await fs.promises.rm(newPath, { recursive: true, force: true });
          } catch {
          }
          await fs.promises.rename(oldPath, newPath);
          disabledCount++;
          console.log(`[MCP Quarantine] Disabled plugin dir: ${oldPath} → ${newPath}`);
        }
      } catch {
      }
    }
  } catch {
  }
  try {
    await removeCursorPluginFromStateDb(prefixes);
  } catch {
  }
  try {
    const parts = splitPath(server.path);
    const cacheIdx = parts.indexOf("cache");
    const pluginName = cacheIdx !== -1 && cacheIdx + 2 < parts.length ? parts[cacheIdx + 2] : server.name;
    await removeCursorPluginsFromServerConfig([pluginName, server.name]);
  } catch {
  }
  try {
    const parts = splitPath(server.path);
    const cacheIdx = parts.indexOf("cache");
    if (cacheIdx !== -1 && cacheIdx + 2 < parts.length) {
      const pluginCacheDir = parts.slice(0, cacheIdx + 3).join(path.sep);
      const parentDir = path.dirname(pluginCacheDir);
      const pluginDirName = path.basename(pluginCacheDir);
      const disabledCacheDir = path.join(parentDir, `${CURSOR_PLUGIN_DISABLED_PREFIX}${pluginDirName}`);
      try {
        await fs.promises.rm(disabledCacheDir, { recursive: true, force: true });
      } catch {
      }
      await fs.promises.rename(pluginCacheDir, disabledCacheDir);
      console.log(`[MCP Quarantine] Disabled plugin cache: ${pluginCacheDir} → ${disabledCacheDir}`);
    }
  } catch (err) {
    console.warn(`[MCP Quarantine] Failed to disable plugin cache dir:`, err);
  }
  if (disabledCount === 0) {
    console.log(`[MCP Quarantine] No project directories found for plugin "${server.name}"`);
  }
  return { server, originalPath: server.path, disabledPath: projectsDir, quarantinedAt };
}
async function restoreAllCursorPlugins() {
  const projectsDir = getCursorProjectsDir();
  let restored = 0;
  const errors = [];
  try {
    const projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
    for (const projDir of projectEntries) {
      if (!projDir.isDirectory()) continue;
      const mcpsDir = path.join(projectsDir, projDir.name, "mcps");
      try {
        const mcpEntries = await fs.promises.readdir(mcpsDir, { withFileTypes: true });
        for (const mcpDir of mcpEntries) {
          if (!mcpDir.isDirectory()) continue;
          if (!mcpDir.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue;
          const originalName = mcpDir.name.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length);
          const oldPath = path.join(mcpsDir, mcpDir.name);
          const newPath = path.join(mcpsDir, originalName);
          try {
            await fs.promises.rename(oldPath, newPath);
            restored++;
            console.log(`[MCP Quarantine Reset] Restored plugin dir: ${oldPath} → ${newPath}`);
          } catch (err) {
            const msg = `Failed to restore plugin dir ${oldPath}: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
          }
        }
      } catch {
      }
    }
  } catch {
  }
  try {
    const cacheDir = getCursorPluginCachePath();
    const marketplaces = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    for (const mkt of marketplaces) {
      if (!mkt.isDirectory()) continue;
      const mktPath = path.join(cacheDir, mkt.name);
      const plugins = await fs.promises.readdir(mktPath, { withFileTypes: true });
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        if (!plugin.name.startsWith(CURSOR_PLUGIN_DISABLED_PREFIX)) continue;
        const originalName = plugin.name.slice(CURSOR_PLUGIN_DISABLED_PREFIX.length);
        const oldPath = path.join(mktPath, plugin.name);
        const newPath = path.join(mktPath, originalName);
        try {
          await fs.promises.rename(oldPath, newPath);
          restored++;
          console.log(`[MCP Quarantine Reset] Restored plugin cache: ${oldPath} → ${newPath}`);
        } catch (err) {
          const msg = `Failed to restore plugin cache ${oldPath}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
        }
      }
    }
  } catch {
  }
  return { restored, errors };
}
const execFileAsync$3 = util.promisify(child_process.execFile);
function supportsJsonc(client) {
  return client === "vscode" || client === "cursor";
}
async function readConfigFile(filePath, client) {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  if (client && supportsJsonc(client)) {
    return jsonc__namespace.parse(raw);
  }
  return JSON.parse(raw);
}
function getServersKey(client) {
  return client === "vscode" ? "servers" : "mcpServers";
}
function getServersFromConfig(config, client) {
  if (client === "zed") {
    return config.assistant?.mcp_servers;
  }
  const key = getServersKey(client);
  return config[key];
}
function resolveServersMap(config, server, configKey) {
  if (server.projectName && config.projects) {
    const projects = config.projects;
    const projCfg = projects[server.projectName];
    if (projCfg?.mcpServers && configKey in projCfg.mcpServers) {
      return { servers: projCfg.mcpServers, nested: true };
    }
  }
  if (server.profileName && config.profiles) {
    const profiles = config.profiles;
    const profileCfg = profiles[server.profileName];
    if (profileCfg?.mcpServers && configKey in profileCfg.mcpServers) {
      return { servers: profileCfg.mcpServers, nested: true };
    }
  }
  return { servers: getServersFromConfig(config, server.client), nested: false };
}
function setServersInConfig(config, client, servers) {
  if (client === "zed") {
    if (!config.assistant) {
      config.assistant = {};
    }
    config.assistant.mcp_servers = servers;
  } else {
    const key = getServersKey(client);
    config[key] = servers;
  }
}
async function removeServerFromConfig(server) {
  if (server.source === "plugin") {
    console.warn(`[MCP Config] Refusing to edit plugin cache file - use quarantineCursorPlugin instead: ${server.path}`);
    return;
  }
  const config = await readConfigFile(server.path, server.client);
  const configKey = server.originalName ?? server.name;
  const { servers, nested } = resolveServersMap(config, server, configKey);
  if (!servers || !(configKey in servers)) {
    throw new Error(`Server "${configKey}" not found in config file`);
  }
  if (fs.existsSync(server.path)) {
    const now = /* @__PURE__ */ new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const backupPath = `${server.path}.backup.${timestamp}.json`;
    await fs.promises.copyFile(server.path, backupPath);
    console.log(`[MCP Config] Created backup: ${backupPath}`);
  }
  delete servers[configKey];
  if (!nested) {
    setServersInConfig(config, server.client, servers);
  }
  await fs.promises.writeFile(server.path, JSON.stringify(config, null, 2), "utf-8");
  console.log(`[MCP Config] Removed server "${configKey}" from ${server.path}`);
}
function getDisabledConfigPath(originalPath) {
  const dir = path.dirname(originalPath);
  const filename = path.basename(originalPath);
  return path.join(dir, `disabled_${filename}`);
}
async function readQuarantinedServersFile(disabledPath) {
  try {
    const content = await fs.promises.readFile(disabledPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      quarantinedBy: "Edison Watch",
      servers: {}
    };
  }
}
async function quarantineServer(server) {
  if (server.source === "marketplace") {
    return quarantineMarketplaceServer(server);
  }
  if (server.source === "plugin" && server.client === "cursor") {
    return quarantineCursorPlugin(server);
  }
  if (server.client === "claude-code" && server.source === "project" && server.projectName) {
    const configKey2 = server.originalName ?? server.name;
    const quarantinedAt2 = (/* @__PURE__ */ new Date()).toISOString();
    console.log(`[MCP Quarantine] Removing Claude Code project-scoped server "${configKey2}" via CLI (project=${server.projectName})`);
    const removeArgs = ["mcp", "remove", configKey2];
    logClaudeCmd(removeArgs, { cwd: server.projectName });
    try {
      await execFileAsync$3("claude", removeArgs, {
        timeout: 1e4,
        cwd: server.projectName
      });
      console.log(`[MCP Quarantine] Removed "${configKey2}" via claude mcp remove`);
    } catch (err) {
      console.warn(`[MCP Quarantine] claude mcp remove failed for "${configKey2}": ${err}`);
    }
    return { server, originalPath: server.path, disabledPath: "", quarantinedAt: quarantinedAt2 };
  }
  const originalPath = server.path;
  const disabledPath = getDisabledConfigPath(originalPath);
  const quarantinedAt = (/* @__PURE__ */ new Date()).toISOString();
  const configKey = server.originalName ?? server.name;
  console.log(`[MCP Quarantine] Quarantining server "${configKey}" from ${originalPath}`);
  const disabledFile = await readQuarantinedServersFile(disabledPath);
  disabledFile.servers[configKey] = {
    ...server.config,
    originalFile: originalPath,
    quarantinedAt
  };
  await fs.promises.writeFile(disabledPath, JSON.stringify(disabledFile, null, 2), "utf-8");
  console.log(`[MCP Quarantine] Added server "${configKey}" to ${disabledPath}`);
  try {
    const raw = await fs.promises.readFile(originalPath, "utf-8");
    const parsed = jsonc__namespace.parse(raw);
    const serversKey = server.client === "zed" ? ["assistant", "mcp_servers"] : [getServersKey(server.client)];
    let serverPath = [...serversKey, configKey];
    let servers = server.client === "zed" ? parsed.assistant?.mcp_servers : parsed[serversKey[0]];
    let serverExists = servers && configKey in servers;
    if (!serverExists && server.projectName && parsed.projects) {
      const projects = parsed.projects;
      const projCfg = projects[server.projectName];
      if (projCfg?.mcpServers && configKey in projCfg.mcpServers) {
        servers = projCfg.mcpServers;
        serverPath = ["projects", server.projectName, "mcpServers", configKey];
        serverExists = true;
      }
    }
    if (!serverExists && server.profileName && parsed.profiles) {
      const profiles = parsed.profiles;
      const profileCfg = profiles[server.profileName];
      if (profileCfg?.mcpServers && configKey in profileCfg.mcpServers) {
        servers = profileCfg.mcpServers;
        serverPath = ["profiles", server.profileName, "mcpServers", configKey];
        serverExists = true;
      }
    }
    if (serverExists) {
      if (fs.existsSync(originalPath)) {
        const now = /* @__PURE__ */ new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
        const backupPath = `${originalPath}.backup.${timestamp}.json`;
        await fs.promises.copyFile(originalPath, backupPath);
        console.log(`[MCP Quarantine] Created backup: ${backupPath}`);
      }
      const edits = jsonc__namespace.modify(raw, serverPath, void 0, {
        formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
      });
      const modified = jsonc__namespace.applyEdits(raw, edits);
      await fs.promises.writeFile(originalPath, modified, "utf-8");
      console.log(`[MCP Quarantine] Removed server "${configKey}" from ${originalPath}`);
    } else {
      const rollbackFile = await readQuarantinedServersFile(disabledPath);
      delete rollbackFile.servers[configKey];
      await fs.promises.writeFile(disabledPath, JSON.stringify(rollbackFile, null, 2), "utf-8");
      console.log(`[MCP Quarantine] Server "${configKey}" already absent from ${originalPath} - skipped`);
      return null;
    }
  } catch (err) {
    console.error(
      `[MCP Quarantine] Failed to remove server from original config, rolling back:`,
      err
    );
    try {
      const rollbackDisabledFile = await readQuarantinedServersFile(disabledPath);
      delete rollbackDisabledFile.servers[configKey];
      await fs.promises.writeFile(disabledPath, JSON.stringify(rollbackDisabledFile, null, 2), "utf-8");
      console.log(`[MCP Quarantine] Rolled back: removed server from ${disabledPath}`);
    } catch (rollbackErr) {
      console.error(`[MCP Quarantine] Rollback failed:`, rollbackErr);
    }
    throw err;
  }
  return {
    server,
    originalPath,
    disabledPath,
    quarantinedAt
  };
}
async function restoreAllQuarantinedServers() {
  const entries = await getAllConfigEntries();
  const entryMap = buildEntryMap(entries);
  const fileEntries = entries.filter((e) => e.kind !== "sqlite-state");
  const allOriginalPaths = [...new Set(fileEntries.map((e) => e.path))];
  let restored = 0;
  const errors = [];
  const marketplace = await restoreAllMarketplaceServers();
  restored += marketplace.restored;
  errors.push(...marketplace.errors);
  const plugins = await restoreAllCursorPlugins();
  restored += plugins.restored;
  errors.push(...plugins.errors);
  for (const originalPath of allOriginalPaths) {
    const disabledPath = getDisabledConfigPath(originalPath);
    try {
      await fs.promises.access(disabledPath);
    } catch {
      continue;
    }
    try {
      const disabledFile = await readQuarantinedServersFile(disabledPath);
      const serverNames = Object.keys(disabledFile.servers);
      if (serverNames.length === 0) {
        await fs.promises.unlink(disabledPath);
        continue;
      }
      const entry = entryMap.get(originalPath);
      const clientId = entry?.client ?? inferClientFromPath(originalPath);
      if (clientId === "codex") {
        const msg = `Codex config restore not yet supported (TOML format): ${originalPath}`;
        console.log(`[MCP Quarantine Reset] ${msg}`);
        errors.push(msg);
        continue;
      }
      let config;
      try {
        config = await readConfigFile(originalPath, clientId);
      } catch {
        config = {};
      }
      let servers = getServersFromConfig(config, clientId);
      if (!servers) {
        servers = {};
      }
      for (const [name, serverData] of Object.entries(disabledFile.servers)) {
        const { originalFile: _of, quarantinedAt: _qa, ...serverConfig } = serverData;
        servers[name] = serverConfig;
        restored++;
        console.log(`[MCP Quarantine Reset] Restored server "${name}" to ${originalPath}`);
      }
      setServersInConfig(config, clientId, servers);
      await fs.promises.writeFile(originalPath, JSON.stringify(config, null, 2), "utf-8");
      await fs.promises.unlink(disabledPath);
      console.log(`[MCP Quarantine Reset] Removed disabled file: ${disabledPath}`);
    } catch (err) {
      const msg = `Failed to restore from ${disabledPath}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[MCP Quarantine Reset] ${msg}`);
      errors.push(msg);
    }
  }
  return { restored, errors };
}
function inferClientFromPath(configPath) {
  const lower = configPath.toLowerCase();
  if (lower.includes(".codex")) return "codex";
  if (lower.includes(".cursor")) return "cursor";
  if (lower.includes(".claude")) return "claude-code";
  if (lower.includes("code - insiders")) return "vscode";
  if (lower.includes("code") && lower.includes("user") && lower.includes("mcp.json"))
    return "vscode";
  if (lower.includes("windsurf") || lower.includes("codeium")) return "windsurf";
  if (lower.includes("zed")) return "zed";
  if (lower.includes("intellij")) return "intellij";
  if (lower.includes("pycharm")) return "pycharm";
  if (lower.includes("webstorm")) return "webstorm";
  return "claude-code";
}
const execFileAsync$2 = util.promisify(child_process.execFile);
const NEEDS_MCP_REMOTE_SHIM = /* @__PURE__ */ new Set(["claude-desktop", "claude-cowork"]);
function buildEdisonEntry(clientId, url2, headers) {
  if (NEEDS_MCP_REMOTE_SHIM.has(clientId)) {
    const headerArgs = headers ? Object.entries(headers).flatMap(([k, v]) => ["--header", `${k}: ${v}`]) : [];
    return {
      command: "npx",
      args: ["-y", "mcp-remote", url2, ...headerArgs]
    };
  }
  return { type: "http", url: url2, ...headers && { headers } };
}
function extractEdisonUrl(entry) {
  if (!entry) return null;
  if (typeof entry.url === "string") return entry.url;
  if (Array.isArray(entry.args)) {
    for (const a of entry.args) {
      if (typeof a === "string" && /^https?:\/\//.test(a)) return a;
    }
  }
  return null;
}
async function getPathForApp(appId) {
  const STATIC_MAP = {
    vscode: getVscodeUserMcpPath,
    cursor: getCursorConfigPath,
    "claude-desktop": getClaudeDesktopConfigPath,
    "claude-cowork": getClaudeCoworkConfigPath,
    windsurf: getWindsurfConfigPath,
    zed: getZedConfigPath
  };
  if (STATIC_MAP[appId]) {
    return { configPath: STATIC_MAP[appId](), clientId: appId };
  }
  if (["intellij", "pycharm", "webstorm"].includes(appId)) {
    const jbPaths = await getJetBrainsMcpConfigPaths();
    const match = jbPaths.find((p) => p.client === appId);
    if (match) return { configPath: match.path, clientId: match.client };
    return null;
  }
  return null;
}
async function cleanupHomeMcpJson() {
  const homeMcpJson = path.join(os.homedir(), ".mcp.json");
  if (!fs.existsSync(homeMcpJson)) return;
  try {
    const raw = await fs.promises.readFile(homeMcpJson, "utf-8");
    const json = JSON.parse(raw);
    const servers = json.mcpServers;
    if (!servers || !("edison-watch" in servers)) return;
    delete servers["edison-watch"];
    const remainingKeys = Object.keys(json).filter((k) => k !== "mcpServers");
    if (Object.keys(servers).length === 0 && remainingKeys.length === 0) {
      await fs.promises.unlink(homeMcpJson);
      console.log("[mcpConfigWriter] Removed empty ~/.mcp.json after cleaning edison-watch entry");
    } else {
      json.mcpServers = servers;
      await fs.promises.writeFile(homeMcpJson, JSON.stringify(json, null, 2), "utf-8");
      console.log("[mcpConfigWriter] Removed edison-watch from ~/.mcp.json");
    }
  } catch {
  }
}
async function cleanupCursorProjectMcpJson() {
  let projectPaths;
  try {
    projectPaths = await getCursorProjectMcpPaths();
  } catch {
    return;
  }
  for (const mcpPath of projectPaths) {
    if (!fs.existsSync(mcpPath)) continue;
    try {
      const raw = await fs.promises.readFile(mcpPath, "utf-8");
      const json = jsonc__namespace.parse(raw);
      const servers = json.mcpServers;
      if (!servers || !("edison-watch" in servers)) continue;
      const edits = jsonc__namespace.modify(raw, ["mcpServers", "edison-watch"], void 0, {
        formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" }
      });
      const updated = jsonc__namespace.applyEdits(raw, edits);
      await fs.promises.writeFile(mcpPath, updated, "utf-8");
      console.log(
        `[mcpConfigWriter] Removed stale edison-watch from Cursor project config: ${mcpPath}`
      );
    } catch {
    }
  }
}
async function applyToClaudeCode(url2, headers, timestamp, dryRun2) {
  if (dryRun2) {
    console.log(`[dry-run] Would add edison-watch to Claude Code via CLI: ${url2}`);
    return { appId: "claude-code", configPath: "(via claude mcp add)", backupPath: "" };
  }
  await cleanupHomeMcpJson();
  const removeUserArgs = ["mcp", "remove", "edison-watch", "--scope", "user"];
  logClaudeCmd(removeUserArgs);
  try {
    await execFileAsync$2("claude", removeUserArgs, { timeout: 1e4 });
  } catch {
  }
  const removeProjectArgs = ["mcp", "remove", "edison-watch", "--scope", "project"];
  logClaudeCmd(removeProjectArgs);
  try {
    await execFileAsync$2("claude", removeProjectArgs, { timeout: 1e4 });
  } catch {
  }
  const headerArgs = headers ? Object.entries(headers).flatMap(([k, v]) => ["--header", `${k}: ${v}`]) : [];
  const args = [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "user",
    ...headerArgs,
    "edison-watch",
    url2
  ];
  logClaudeCmd(args);
  try {
    await execFileAsync$2("claude", args, { timeout: 1e4 });
    console.log("[mcpConfigWriter] Added edison-watch to Claude Code via CLI");
    return { appId: "claude-code", configPath: getClaudeCodeHomeJsonPath(), backupPath: "" };
  } catch (err) {
    console.warn(
      `[mcpConfigWriter] claude mcp add failed, falling back to direct write: ${err instanceof Error ? err.message : String(err)}`
    );
    return await applyToClaudeCodeFallback(url2, headers, timestamp);
  }
}
async function applyToClaudeCodeFallback(url2, headers, timestamp) {
  const configPath = getClaudeCodeHomeJsonPath();
  const backupPath = `${configPath}.backup.${timestamp}.json`;
  if (fs.existsSync(configPath)) {
    await fs.promises.copyFile(configPath, backupPath);
  }
  let json = {};
  try {
    const raw = await fs.promises.readFile(configPath, "utf-8");
    json = JSON.parse(raw);
  } catch {
  }
  const mcpServers = json.mcpServers ?? {};
  mcpServers["edison-watch"] = { type: "http", url: url2, ...headers && { headers } };
  json.mcpServers = mcpServers;
  await fs.promises.writeFile(configPath, JSON.stringify(json, null, 2), "utf-8");
  console.log("[mcpConfigWriter] Added edison-watch to ~/.claude.json (fallback)");
  return {
    appId: "claude-code",
    configPath,
    backupPath: fs.existsSync(backupPath) ? backupPath : ""
  };
}
async function mergeEdisonEntry(configPath, clientId, edisonEntry) {
  let config = {};
  try {
    config = await readConfigFile(configPath, clientId);
  } catch {
  }
  const servers = { ...getServersFromConfig(config, clientId) ?? {} };
  servers["edison-watch"] = edisonEntry;
  setServersInConfig(config, clientId, servers);
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}
async function applyToCodex(url2, headers, timestamp, dryRun2) {
  const configPath = getCodexConfigPath();
  const backupPath = `${configPath}.backup.${timestamp}.toml`;
  if (dryRun2) {
    console.log(`[dry-run] Would write edison-watch MCP to Codex config.toml: ${url2}`);
    return { appId: "codex", configPath, backupPath: "" };
  }
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  let existing = "";
  if (fs.existsSync(configPath)) {
    existing = await fs.promises.readFile(configPath, "utf-8");
    await fs.promises.copyFile(configPath, backupPath);
  }
  const sectionRegex = /\n?\[mcp_servers\.edison-watch(?:\.[^\]]+)?\][^\n]*\n(?:(?!\n\[)[\s\S])*?(?=\n\[|\s*$)/g;
  let cleaned = existing.replace(sectionRegex, "");
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let tomlSection = '\n[mcp_servers.edison-watch]\nurl = "' + esc(url2) + '"\n';
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      tomlSection += `http_headers."${esc(key)}" = "${esc(value)}"
`;
    }
  }
  cleaned = cleaned.replace(/\n*$/, "");
  const final = cleaned ? cleaned + "\n" + tomlSection : tomlSection.replace(/^\n/, "");
  await fs.promises.writeFile(configPath, final, "utf-8");
  console.log("[mcpConfigWriter] Added edison-watch MCP to Codex config.toml");
  return {
    appId: "codex",
    configPath,
    backupPath: fs.existsSync(backupPath) ? backupPath : ""
  };
}
async function applyToApp(appId, url2, headers, timestamp, dryRun2) {
  if (appId === "claude-code") {
    return applyToClaudeCode(url2, headers, timestamp, dryRun2);
  }
  if (appId === "codex") {
    return applyToCodex(url2, headers, timestamp, dryRun2);
  }
  if (appId === "cursor" && !dryRun2) {
    await cleanupCursorProjectMcpJson();
  }
  const resolved = await getPathForApp(appId);
  if (!resolved) return null;
  const { configPath, clientId } = resolved;
  const backupPath = `${configPath}.backup.${timestamp}.json`;
  const entry = buildEdisonEntry(clientId, url2, headers);
  if (dryRun2) {
    console.log(`[dry-run] Would write to ${configPath}:`, JSON.stringify(entry, null, 2));
    return { appId, configPath, backupPath: "" };
  }
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    await fs.promises.copyFile(configPath, backupPath);
  }
  await mergeEdisonEntry(configPath, clientId, entry);
  return {
    appId,
    configPath,
    backupPath: fs.existsSync(backupPath) ? backupPath : ""
  };
}
function stripQueryString(url2) {
  const idx = url2.indexOf("?");
  return idx >= 0 ? url2.substring(0, idx) : url2;
}
async function isEdisonWatchRegistered(appId, expectedUrl) {
  if (appId === "claude-code") {
    return true;
  }
  if (appId === "codex") {
    try {
      const content = await fs.promises.readFile(getCodexConfigPath(), "utf-8");
      const toml = smolToml.parse(content);
      const mcpServers = toml.mcp_servers;
      if (!mcpServers) return false;
      const edisonWatch = mcpServers["edison-watch"];
      if (!edisonWatch || typeof edisonWatch.url !== "string") return false;
      if (expectedUrl && stripQueryString(edisonWatch.url) !== stripQueryString(expectedUrl))
        return false;
      return true;
    } catch {
      return false;
    }
  }
  const pathInfo = await getPathForApp(appId);
  if (!pathInfo) return false;
  try {
    const config = await readConfigFile(pathInfo.configPath, pathInfo.clientId);
    const servers = getServersFromConfig(config, pathInfo.clientId);
    if (servers == null || !("edison-watch" in servers)) return false;
    if (expectedUrl) {
      const entry = servers["edison-watch"];
      const entryUrl = extractEdisonUrl(entry);
      if (!entryUrl || stripQueryString(entryUrl) !== stripQueryString(expectedUrl)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function findAppsNeedingReRegistration(configuredApps, expectedUrl) {
  const missing = [];
  for (const appId of configuredApps) {
    if (appId === "claude-code") continue;
    const registered = await isEdisonWatchRegistered(appId, expectedUrl);
    if (!registered) {
      missing.push(appId);
    }
  }
  return missing;
}
async function findAppsMissingClientTag(configuredApps) {
  const needsTag = [];
  for (const appId of configuredApps) {
    if (appId === "claude-code") {
      try {
        const raw = await fs.promises.readFile(getClaudeCodeHomeJsonPath(), "utf-8");
        const json = JSON.parse(raw);
        const servers = json.mcpServers;
        const ew = servers?.["edison-watch"];
        if (ew && typeof ew.url === "string" && !ew.url.includes("?client=")) {
          needsTag.push(appId);
        }
      } catch {
      }
      continue;
    }
    if (appId === "codex") {
      try {
        const content = await fs.promises.readFile(getCodexConfigPath(), "utf-8");
        const toml = smolToml.parse(content);
        const mcpServers = toml.mcp_servers;
        const ew = mcpServers?.["edison-watch"];
        if (ew && typeof ew.url === "string" && !ew.url.includes("?client=")) {
          needsTag.push(appId);
        }
      } catch {
      }
      continue;
    }
    const pathInfo = await getPathForApp(appId);
    if (!pathInfo) continue;
    try {
      const config = await readConfigFile(pathInfo.configPath, pathInfo.clientId);
      const servers = getServersFromConfig(config, pathInfo.clientId);
      if (servers && "edison-watch" in servers) {
        const entry = servers["edison-watch"];
        const entryUrl = extractEdisonUrl(entry);
        if (entryUrl && !entryUrl.includes("?client=")) {
          needsTag.push(appId);
        }
      }
    } catch {
    }
  }
  return needsTag;
}
async function applyAppIntegrations(args) {
  const { mcpBaseUrl, apiKey, edisonSecretKey, apps, dryRun: dryRun2 = false } = args;
  const baseUrl = mcpBaseUrl.replace(/\/$/, "");
  const url2 = `${baseUrl}/mcp/${apiKey}/`;
  const headers = edisonSecretKey ? { "X-Edison-Secret-Key": edisonSecretKey } : void 0;
  const now = /* @__PURE__ */ new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");
  const modifiedConfigs = [];
  const errors = [];
  for (const appId of apps) {
    try {
      const appUrl = `${url2}?client=${encodeURIComponent(appId)}`;
      const result = await applyToApp(appId, appUrl, headers, timestamp, dryRun2);
      if (result) modifiedConfigs.push(result);
    } catch (err) {
      errors.push(`${appId}: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[mcpConfigWriter] Failed to apply to ${appId}:`, err);
    }
  }
  return {
    success: errors.length === 0,
    modifiedConfigs,
    errors: errors.length > 0 ? errors : void 0
  };
}
async function runHookOp(client, op, operation) {
  const hooks = client.hooks;
  try {
    const changed = op === "inject" ? await hooks.inject() : await hooks.remove();
    const installed2 = op === "inject" ? changed : false;
    return { client: client.id, installed: installed2, alreadyExists: !changed };
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: client.id,
      operation,
      platform: os.platform()
    });
    return { client: client.id, installed: false, alreadyExists: false, error: String(err) };
  }
}
async function injectAllHooks() {
  const results = [];
  for (const client of CLIENT_LIST) {
    if (!client.hooks) continue;
    if (!client.isInstalled()) continue;
    results.push(await runHookOp(client, "inject", "injectAllHooks"));
  }
  try {
    const workspacePaths = await getVsCodeWorkspacePaths();
    for (const wsPath of workspacePaths) {
      await injectVsCodeWorkspaceHook(wsPath);
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: "vscode",
      operation: "injectAllHooks",
      platform: os.platform()
    });
  }
  return results;
}
async function removeAllHooks() {
  const results = [];
  for (const client of CLIENT_LIST) {
    if (!client.hooks) continue;
    if (!client.isInstalled()) continue;
    results.push(await runHookOp(client, "remove", "removeAllHooks"));
  }
  try {
    const workspacePaths = await getVsCodeWorkspacePaths();
    for (const wsPath of workspacePaths) {
      await removeVsCodeWorkspaceHook(wsPath);
    }
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      client: "vscode",
      operation: "removeAllHooks",
      platform: os.platform()
    });
  }
  return results;
}
async function checkMcpEntry(configPath, serversKey, expectedMcpUrl) {
  if (!expectedMcpUrl) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const raw = await fs.promises.readFile(configPath, "utf-8");
    const json = jsonc.parse(raw);
    const servers = json[serversKey];
    const entry = servers?.["edison-watch"];
    const entryUrl = extractEdisonUrl(entry);
    if (!entryUrl) return false;
    const strip = (u) => u.replace(/\?.*$/, "").replace(/\/+$/, "");
    return strip(entryUrl) === strip(expectedMcpUrl);
  } catch {
    return false;
  }
}
async function checkCodexMcpEntry(configPath, expectedMcpUrl) {
  if (!expectedMcpUrl) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const content = await fs.promises.readFile(configPath, "utf-8");
    const sectionMatch = content.match(/\[mcp_servers\.edison-watch\][^\n]*\n((?:(?!\n\[)[\s\S])*?)(?=\n\[|\s*$)/);
    if (!sectionMatch?.[1]) return false;
    const sectionBody = sectionMatch[1];
    const urlMatch = sectionBody.match(/url\s*=\s*"([^"]*)"/);
    if (!urlMatch?.[1]) return false;
    const unescaped = urlMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const strip = (u) => u.replace(/\?.*$/, "").replace(/\/+$/, "");
    return strip(unescaped) === strip(expectedMcpUrl);
  } catch {
    return false;
  }
}
async function checkZedMcpEntry(configPath, expectedMcpUrl) {
  if (!expectedMcpUrl) return false;
  try {
    if (!fs.existsSync(configPath)) return false;
    const raw = await fs.promises.readFile(configPath, "utf-8");
    const json = jsonc.parse(raw);
    const entry = json.assistant?.mcp_servers?.["edison-watch"];
    if (!entry?.url) return false;
    const strip = (u) => u.replace(/\?.*$/, "").replace(/\/+$/, "");
    return strip(entry.url) === strip(expectedMcpUrl);
  } catch {
    return false;
  }
}
async function probeMcpConfigured(clientId, installed2, expectedMcpUrl) {
  if (!installed2) return false;
  switch (clientId) {
    case "claude-code":
      return checkMcpEntry(getClaudeCodeHomeJsonPath(), "mcpServers", expectedMcpUrl);
    case "claude-desktop":
      return checkMcpEntry(getClaudeDesktopConfigPath(), "mcpServers", expectedMcpUrl);
    case "claude-cowork":
      return checkMcpEntry(getClaudeCoworkConfigPath(), "mcpServers", expectedMcpUrl);
    case "cursor":
      return checkMcpEntry(getCursorConfigPath(), "mcpServers", expectedMcpUrl);
    case "windsurf":
      return checkMcpEntry(getWindsurfConfigPath(), "mcpServers", expectedMcpUrl);
    case "vscode":
      return checkMcpEntry(getVscodeUserMcpPath(), "servers", expectedMcpUrl);
    case "codex":
      return checkCodexMcpEntry(getCodexConfigPath(), expectedMcpUrl);
    case "zed":
      return checkZedMcpEntry(getZedConfigPath(), expectedMcpUrl);
    case "intellij":
    case "pycharm":
    case "webstorm": {
      const entries = await getJetBrainsMcpConfigPaths();
      for (const { client, path: path2 } of entries) {
        if (client !== clientId) continue;
        if (await checkMcpEntry(path2, "mcpServers", expectedMcpUrl)) return true;
      }
      return false;
    }
  }
}
async function getHookStatus(expectedMcpUrl, mcpServerAlive = false, claudeCodeMcpStatus) {
  const results = [];
  const url2 = expectedMcpUrl ?? null;
  const installedJetBrains = await getInstalledJetBrainsIdes();
  for (const client of CLIENT_LIST) {
    const hooksApplicable = client.hooks !== void 0;
    let base;
    if (client.hooks) {
      base = await client.hooks.getStatus();
    } else if (client.id === "intellij" || client.id === "pycharm" || client.id === "webstorm") {
      const installed2 = installedJetBrains.has(client.id) && client.isInstalled();
      base = { installed: installed2, hasHook: false, hookCount: 0, totalHooks: 0 };
    } else {
      base = { installed: client.isInstalled(), hasHook: false, hookCount: 0, totalHooks: 0 };
    }
    const mcpConfigured = await probeMcpConfigured(client.id, base.installed, url2);
    let mcpConnected = mcpConfigured && mcpServerAlive;
    let mcpRuntimeStatus;
    if (client.id === "claude-code") {
      mcpRuntimeStatus = claudeCodeMcpStatus;
      if (claudeCodeMcpStatus && claudeCodeMcpStatus !== "unknown") {
        mcpConnected = claudeCodeMcpStatus === "connected";
      }
    }
    results.push({
      client: client.id,
      installed: base.installed,
      hasHook: base.hasHook,
      hookCount: base.hookCount,
      totalHooks: base.totalHooks,
      mcpConnected,
      mcpConfigured,
      mcpApplicable: true,
      hooksApplicable,
      ...mcpRuntimeStatus !== void 0 ? { mcpRuntimeStatus } : {}
    });
  }
  return results;
}
const __vite_import_meta_env__ = {};
const DEMO_CONFIG = {
  SUPABASE_URL: "https://bdabdocijxbncjmldwxa.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ldnSefSaPmWEYGdbi7yURQ_XmMmkLEP",
  FUNCTIONS_URL: "https://bdabdocijxbncjmldwxa.supabase.co",
  SENTRY_DSN: "https://521930844e674e4fe234bf7e2f2a8942@o4509236804190208.ingest.de.sentry.io/4509722815234128",
  POSTHOG_API_KEY: "phc_KNuu0bmHlZwps48BcFYfax4aqVJJJWBF00mP43490CQ",
  POSTHOG_FEEDBACK_SURVEY_ID: "019c5262-bd68-0000-2209-0e41b3563834",
  DEPLOY_ENV: "demo",
  API_BASE_URL: "https://demo-dashboard.edison.watch",
  MCP_BASE_URL: "https://edison-watch-demo.up.railway.app",
  RELEASES_BASE_URL: "https://demo-releases.edison.watch"
};
const RELEASE_CONFIG = {
  SUPABASE_URL: "https://aghapravwywtjhudszur.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_tn5PeagDqytqWP8G9a4QkA_88PxOaFZ",
  FUNCTIONS_URL: "https://aghapravwywtjhudszur.supabase.co",
  SENTRY_DSN: "https://521930844e674e4fe234bf7e2f2a8942@o4509236804190208.ingest.de.sentry.io/4509722815234128",
  POSTHOG_API_KEY: "phc_KNuu0bmHlZwps48BcFYfax4aqVJJJWBF00mP43490CQ",
  POSTHOG_FEEDBACK_SURVEY_ID: "019c5262-bd68-0000-2209-0e41b3563834",
  DEPLOY_ENV: "release",
  API_BASE_URL: "https://dashboard.edison.watch",
  MCP_BASE_URL: "https://mcp.edison.watch",
  RELEASES_BASE_URL: "https://releases.edison.watch"
};
const LOCAL_CONFIG = {
  SUPABASE_URL: "http://localhost:3001",
  SUPABASE_ANON_KEY: "local-anon-key",
  FUNCTIONS_URL: "http://localhost:3001",
  SENTRY_DSN: "",
  POSTHOG_API_KEY: "",
  POSTHOG_FEEDBACK_SURVEY_ID: "",
  DEPLOY_ENV: "local",
  API_BASE_URL: "http://localhost:3001",
  MCP_BASE_URL: "http://localhost:3000",
  RELEASES_BASE_URL: ""
};
const CONFIGS = {
  demo: DEMO_CONFIG,
  release: RELEASE_CONFIG,
  local: LOCAL_CONFIG
};
const LOCAL_MCP_PORT = __vite_import_meta_env__?.VITE_MCP_PORT ?? "3000";
function resolveLocalConfig() {
  if (typeof window === "undefined" || !window.location) return LOCAL_CONFIG;
  const { origin, protocol, hostname } = window.location;
  return {
    ...LOCAL_CONFIG,
    SUPABASE_URL: origin,
    FUNCTIONS_URL: origin,
    API_BASE_URL: origin,
    MCP_BASE_URL: `${protocol}//${hostname}:${LOCAL_MCP_PORT}`
  };
}
function getEnvByName(name) {
  if (name === "local") return resolveLocalConfig();
  return CONFIGS[name];
}
const execFileAsync$1 = util.promisify(child_process.execFile);
const DRY_RUN = process.env.EDISON_DRY_RUN === "1";
if (DRY_RUN) console.log("[dry-run] Dry-run mode enabled - config files will not be modified");
const DEBUG_ENV_NAMES = ["demo", "release", "dev"];
function getBuildDefaultEnv() {
  const is2 = { get dev() {
    return !electron.app.isPackaged;
  } };
  if (is2.dev) return "dev";
  return null;
}
const DEV_MCP_BASE_URL = "http://localhost:3000";
const DEV_API_BASE_URL = "http://localhost:3001";
const ENV_API_URL = "";
const ENV_MCP_URL = "";
const ENV_DOCS_URL = "https://docs.edison.watch";
function getEnvUrls(env) {
  const cfg = getEnvByName(env);
  return cfg ? { api: cfg.API_BASE_URL, mcp: cfg.MCP_BASE_URL } : null;
}
function getDebugEnvOverridePath() {
  return path.join(electron.app.getPath("userData"), "edison_debug_env.json");
}
function getDebugEnvOverride() {
  try {
    const p = getDebugEnvOverridePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (data.env === "demo" || data.env === "release" || data.env === "dev") return data.env;
    return null;
  } catch {
    return null;
  }
}
function setDebugEnvOverride(env) {
  try {
    const p = getDebugEnvOverridePath();
    if (env === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    fs.writeFileSync(p, JSON.stringify({ env }), "utf-8");
  } catch {
  }
}
const ALL_SUPPORTED_APPS = [
  "vscode",
  "cursor",
  "claude-desktop",
  "claude-code",
  "claude-cowork",
  "windsurf",
  "zed",
  "codex",
  "intellij",
  "pycharm",
  "webstorm"
];
let setupCompleted = null;
function getSetupFlagPath() {
  return path.join(electron.app.getPath("userData"), "setup.json");
}
function getSetupData() {
  try {
    const raw = fs.readFileSync(getSetupFlagPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { completed: false };
  }
}
function isSetupComplete() {
  if (setupCompleted !== null) return setupCompleted;
  const data = getSetupData();
  setupCompleted = data.completed === true;
  return setupCompleted;
}
function markSetupComplete(data) {
  const existing = getSetupData();
  const merged = { ...existing, ...data, completed: true };
  const env = getActiveEnv();
  if (merged.apiKey) {
    const envCreds = merged.envCredentials ?? {};
    const existingEnvEntry = envCreds[env];
    const resolvedSecret = data?.edisonSecretKey ?? existingEnvEntry?.edisonSecretKey ?? merged.edisonSecretKey;
    envCreds[env] = {
      apiKey: data?.apiKey ?? existingEnvEntry?.apiKey ?? merged.apiKey,
      ...resolvedSecret && { edisonSecretKey: resolvedSecret }
    };
    merged.envCredentials = envCreds;
  }
  fs.writeFileSync(getSetupFlagPath(), JSON.stringify(merged, null, 2), "utf-8");
  setupCompleted = true;
  electron.app.setLoginItemSettings({ openAtLogin: true });
  try {
    saveAccount(merged);
  } catch {
  }
}
function markSetupIncomplete() {
  fs.writeFileSync(getSetupFlagPath(), JSON.stringify({ completed: false }), "utf-8");
  setupCompleted = false;
  electron.app.setLoginItemSettings({ openAtLogin: false });
}
function getAccountsPath() {
  return path.join(electron.app.getPath("userData"), "accounts.json");
}
function getSavedAccounts() {
  try {
    const raw = fs.readFileSync(getAccountsPath(), "utf-8");
    const data = JSON.parse(raw);
    return data.accounts ?? [];
  } catch {
    return [];
  }
}
function writeAccounts(accounts) {
  fs.writeFileSync(getAccountsPath(), JSON.stringify({ accounts }, null, 2), "utf-8");
}
function saveAccount(data) {
  if (!data.userId) return;
  const accounts = getSavedAccounts();
  const entry = {
    userId: data.userId,
    userEmail: data.userEmail ?? "",
    serverAddress: data.serverAddress,
    mcpBaseUrl: data.mcpBaseUrl,
    apiBaseUrl: data.apiBaseUrl,
    apiKey: data.apiKey,
    edisonSecretKey: data.edisonSecretKey,
    configuredApps: data.configuredApps,
    envCredentials: data.envCredentials,
    savedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const idx = accounts.findIndex((a) => a.userId === data.userId);
  if (idx >= 0) {
    accounts[idx] = entry;
  } else {
    accounts.push(entry);
  }
  writeAccounts(accounts);
}
function removeAccount(userId) {
  const accounts = getSavedAccounts().filter((a) => a.userId !== userId);
  writeAccounts(accounts);
}
function switchToAccount(userId) {
  try {
    const current = getSetupData();
    if (current.userId) saveAccount(current);
  } catch {
  }
  const accounts = getSavedAccounts();
  const account = accounts.find((a) => a.userId === userId);
  if (!account) return null;
  const data = {
    completed: true,
    userEmail: account.userEmail,
    userId: account.userId,
    serverAddress: account.serverAddress,
    mcpBaseUrl: account.mcpBaseUrl,
    apiBaseUrl: account.apiBaseUrl,
    apiKey: account.apiKey,
    edisonSecretKey: account.edisonSecretKey,
    configuredApps: account.configuredApps,
    envCredentials: account.envCredentials
  };
  fs.writeFileSync(getSetupFlagPath(), JSON.stringify(data, null, 2), "utf-8");
  setupCompleted = true;
  return data;
}
function getCredentialsForEnv(env) {
  const setupData = getSetupData();
  const targetEnv = env ?? getActiveEnv();
  const perEnv = setupData.envCredentials?.[targetEnv];
  if (perEnv) return perEnv;
  if (!setupData.envCredentials && setupData.apiKey) {
    return { apiKey: setupData.apiKey, edisonSecretKey: setupData.edisonSecretKey };
  }
  return null;
}
function getActiveEnv() {
  return getDebugEnvOverride() ?? getBuildDefaultEnv() ?? "demo";
}
function getApiBaseUrl() {
  const activeEnv = getActiveEnv();
  const debugOverride = getDebugEnvOverride();
  const overrideUrls = debugOverride ? getEnvUrls(debugOverride) : null;
  if (overrideUrls) return overrideUrls.api;
  const is2 = { get dev() {
    return !electron.app.isPackaged;
  } };
  if (activeEnv === "dev" || is2.dev) return DEV_API_BASE_URL;
  const setupData = getSetupData();
  if (setupData.apiBaseUrl) return setupData.apiBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  const url2 = getEnvUrls(activeEnv)?.api || ENV_API_URL || null;
  if (!url2) console.warn(`[getApiBaseUrl] No API URL for env "${activeEnv}".`);
  return url2;
}
function getMcpBaseUrl() {
  const activeEnv = getActiveEnv();
  const debugOverride = getDebugEnvOverride();
  const overrideUrls = debugOverride ? getEnvUrls(debugOverride) : null;
  if (overrideUrls) return overrideUrls.mcp;
  const is2 = { get dev() {
    return !electron.app.isPackaged;
  } };
  if (activeEnv === "dev" || is2.dev) return DEV_MCP_BASE_URL;
  const setupData = getSetupData();
  if (setupData.mcpBaseUrl) return setupData.mcpBaseUrl;
  if (setupData.serverAddress) return `https://${setupData.serverAddress}`;
  const url2 = getEnvUrls(activeEnv)?.mcp || ENV_MCP_URL || null;
  if (!url2) console.warn(`[getMcpBaseUrl] No MCP URL for env "${activeEnv}".`);
  return url2;
}
function getReleasesBaseUrl() {
  const env = getDebugEnvOverride() ?? getActiveEnv();
  return getEnvByName(env)?.RELEASES_BASE_URL ?? null;
}
function getEventsUrl(apiKey) {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/events?api_key=${encodeURIComponent(apiKey)}&source=desktop`;
}
function getApprovalUrl() {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/v1/approvals/action`;
}
function getMcpUrl() {
  const mcpBaseUrl = getMcpBaseUrl();
  const creds = getCredentialsForEnv();
  if (mcpBaseUrl && creds?.apiKey) {
    return `${mcpBaseUrl.replace(/\/$/, "")}/mcp/${creds.apiKey}`;
  }
  return null;
}
function getMcpConfig() {
  const url2 = getMcpUrl();
  if (!url2) return null;
  const creds = getCredentialsForEnv();
  const args = ["-y", "mcp-remote", url2, "--transport", "http-first"];
  if (creds?.edisonSecretKey) {
    args.push("--header", `X-Edison-Secret-Key:${creds.edisonSecretKey}`);
  }
  const config = {
    servers: {
      edisonwatch: {
        type: "stdio",
        command: "npx",
        args
      }
    }
  };
  return JSON.stringify(config, null, 2);
}
let isServerOnline = false;
let serverStatusCheckInterval = null;
function getIsServerOnline() {
  return isServerOnline;
}
async function checkServerStatus() {
  try {
    const mcpUrl = getMcpBaseUrl();
    if (!mcpUrl) return false;
    const healthUrl = `${mcpUrl.replace(/\/$/, "")}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3e3);
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" }
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
function startServerStatusChecks(onStatusChange) {
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
  }, 3e4);
}
function stopServerStatusChecks() {
  if (serverStatusCheckInterval) {
    clearInterval(serverStatusCheckInterval);
    serverStatusCheckInterval = null;
  }
}
async function checkClaudeCodeMcpConnection() {
  const getArgs = ["mcp", "get", "edison-watch"];
  logClaudeCmd(getArgs);
  try {
    const { stdout } = await execFileAsync$1("claude", getArgs, {
      timeout: 5e3
    });
    if (stdout.includes("✓ Connected")) return "connected";
    if (stdout.includes("✗ Failed")) return "failed";
    if (stdout.includes("Needs authentication")) return "needs-auth";
    return "unknown";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("EBADF")) return "unknown";
    if (err && typeof err === "object" && "killed" in err && err.killed) return "unknown";
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    if (stderr.includes("No MCP server found")) {
      return "not-found";
    }
    return "unknown";
  }
}
const CHECK_INTERVAL_MS$1 = 5 * 60 * 1e3;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
let statusCheckTimer = null;
let errorsWatcher = null;
let pendingWatcher = null;
let lastKnownStatus = [];
let onHooksMissing = null;
let monitorActive = false;
function getHookStatusLabel() {
  const s = lastKnownStatus;
  if (s.length === 0) return "Hooks: -";
  const installed2 = s.filter((e) => e.installed);
  if (installed2.length === 0) return "0 MCP clients have Edison installed";
  const withEdison = installed2.filter(
    (e) => e.hooksApplicable ? e.hasHook : e.mcpConfigured
  ).length;
  const total = installed2.length;
  if (withEdison === total) return "All MCP clients have Edison installed";
  if (withEdison === 0) return "0 MCP clients have Edison installed";
  return `${withEdison}/${total} MCP clients have Edison installed`;
}
async function processSessionEndFile(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.event === "session_end" && parsed.conversation_id) {
      console.log(
        "[HookHealthMonitor] Session ended: %s (reason: %s)",
        parsed.conversation_id,
        parsed.reason ?? "unknown"
      );
    } else {
      console.warn(
        "[HookHealthMonitor] session-end file has unexpected shape, discarding:",
        filePath,
        parsed
      );
    }
  } catch {
    console.warn("[HookHealthMonitor] Could not parse session-end file, discarding:", filePath);
  } finally {
    try {
      await fs.promises.unlink(filePath);
    } catch {
    }
  }
}
async function discardPendingFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch {
  }
}
async function sweepStalePendingFiles() {
  const pendingDir = getPendingRegistrationsDir();
  if (!fs.existsSync(pendingDir)) return;
  let swept = 0;
  const now = Date.now();
  const entries = await fs.promises.readdir(pendingDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const filePath = path.join(pendingDir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > PENDING_MAX_AGE_MS) {
        await fs.promises.unlink(filePath);
        swept++;
      }
    } catch {
    }
  }
  if (swept > 0) {
    console.log("[HookHealthMonitor] Swept %d stale pending file(s)", swept);
  }
}
async function sweepOrphanedActiveSessionFiles() {
  const edisonDir = getEdisonWatchDir();
  if (!fs.existsSync(edisonDir)) return;
  let swept = 0;
  const entries = await fs.promises.readdir(edisonDir);
  for (const entry of entries) {
    const match = /^active_session_(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") {
        await fs.promises.unlink(path.join(edisonDir, entry)).catch(() => {
        });
        swept++;
      }
    }
  }
  if (swept > 0) {
    console.log("[HookHealthMonitor] Swept %d orphaned active-session file(s)", swept);
  }
}
function startPendingDirWatcher() {
  const pendingDir = getPendingRegistrationsDir();
  if (pendingWatcher) return;
  if (!fs.existsSync(pendingDir)) {
    fs.promises.mkdir(pendingDir, { recursive: true }).catch(() => {
    });
  }
  pendingWatcher = chokidar.watch(pendingDir, {
    persistent: true,
    ignoreInitial: false,
    depth: 0
  });
  pendingWatcher.on("add", (path$12) => {
    const name = path.basename(path$12);
    if (!name.endsWith(".json") || name.startsWith(".")) return;
    if (name.endsWith("-session-end.json")) {
      processSessionEndFile(path$12).catch(() => {
      });
    } else {
      discardPendingFile(path$12).catch(() => {
      });
    }
  });
  pendingWatcher.on("error", (err) => {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      context: "hookHealthMonitor_pendingWatcher"
    });
  });
  console.log("[HookHealthMonitor] Pending dir watcher started:", pendingDir);
}
async function processErrorFile(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    captureError(new Error(parsed.error ?? "Hook script reported failure"), {
      source: "hook_script_error_file",
      client: parsed.client,
      timestamp: parsed.timestamp,
      filePath
    });
  } catch {
    captureError(new Error("Hook script reported failure (unparseable error file)"), {
      source: "hook_script_error_file",
      filePath
    });
  } finally {
    try {
      await fs.promises.unlink(filePath);
    } catch {
    }
  }
}
function startErrorsDirWatcher() {
  const errorsDir = getPendingErrorsDir();
  if (errorsWatcher) return;
  if (!fs.existsSync(errorsDir)) {
    fs.promises.mkdir(errorsDir, { recursive: true }).catch(() => {
    });
  }
  errorsWatcher = chokidar.watch(errorsDir, {
    persistent: true,
    ignoreInitial: false,
    depth: 0
  });
  errorsWatcher.on("add", (path2) => {
    if (!path2.endsWith(".json")) return;
    processErrorFile(path2).catch(() => {
    });
  });
  errorsWatcher.on("error", (err) => {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      context: "hookHealthMonitor_errorsWatcher"
    });
  });
  console.log("[HookHealthMonitor] Errors dir watcher started:", errorsDir);
}
async function runStatusCheck() {
  const current = await getHookStatus(getMcpUrl(), getIsServerOnline());
  const prevMap = new Map(current.map((e) => [e.client, e]));
  const missing = [];
  for (const last of lastKnownStatus) {
    if (!last.hooksApplicable) continue;
    if (!last.installed || !last.hasHook) continue;
    const cur = prevMap.get(last.client);
    if (cur?.installed && !cur.hasHook) {
      missing.push(cur);
    }
  }
  lastKnownStatus = current;
  if (missing.length > 0) {
    captureError(
      new Error(`Edison Watch hooks were removed from: ${missing.map((m) => m.client).join(", ")}`),
      { missingClients: missing.map((m) => m.client) }
    );
    onHooksMissing?.(missing);
  }
}
function startHookHealthMonitor() {
  getHookStatus(getMcpUrl(), getIsServerOnline()).then((s) => {
    lastKnownStatus = s;
  });
  if (statusCheckTimer) return;
  statusCheckTimer = setInterval(() => {
    runStatusCheck().catch((err) => {
      captureError(err instanceof Error ? err : new Error(String(err)), {
        context: "hookHealthMonitor_runStatusCheck"
      });
    });
  }, CHECK_INTERVAL_MS$1);
  monitorActive = true;
  const sweepError = (context) => (err) => {
    captureError(err instanceof Error ? err : new Error(String(err)), { context });
  };
  sweepStalePendingFiles().catch(sweepError("hookHealthMonitor_sweepStalePendingFiles")).finally(() => {
    if (!monitorActive) return;
    startErrorsDirWatcher();
    startPendingDirWatcher();
  });
  sweepOrphanedActiveSessionFiles().catch(
    sweepError("hookHealthMonitor_sweepOrphanedActiveSessionFiles")
  );
  console.log("[HookHealthMonitor] Started (interval %d ms)", CHECK_INTERVAL_MS$1);
}
async function stopHookHealthMonitor() {
  monitorActive = false;
  if (statusCheckTimer) {
    clearInterval(statusCheckTimer);
    statusCheckTimer = null;
  }
  if (errorsWatcher) {
    await errorsWatcher.close();
    errorsWatcher = null;
  }
  if (pendingWatcher) {
    await pendingWatcher.close();
    pendingWatcher = null;
  }
  onHooksMissing = null;
  console.log("[HookHealthMonitor] Stopped");
}
function settingsPath() {
  return path.join(electron.app.getPath("userData"), "update-settings.json");
}
function channelDefaults() {
  return {
    autoDownload: getActiveEnv() === "release",
    autoInstallOnQuit: true
  };
}
function readStored() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}
function getUpdateSettings() {
  const stored = readStored();
  const defaults = channelDefaults();
  return {
    autoDownload: stored.autoDownload ?? defaults.autoDownload,
    autoInstallOnQuit: stored.autoInstallOnQuit ?? defaults.autoInstallOnQuit
  };
}
function setUpdateSettings(patch) {
  const next = { ...readStored(), ...patch };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    console.error("[update] failed to persist settings:", err);
  }
  return getUpdateSettings();
}
const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1e3;
const INITIAL_DELAY_MS = 8e3;
let internal = {
  status: "idle",
  version: null,
  percent: null,
  error: null
};
let onStateChange = null;
let getMainWindow = null;
let configured = false;
let polling = false;
let startupTimer = null;
let intervalTimer = null;
function isEnabled() {
  return electron.app.isPackaged || Boolean(process.env.EW_UPDATE_TEST);
}
function getUpdateState() {
  const s = getUpdateSettings();
  return { ...internal, autoDownload: s.autoDownload, autoInstallOnQuit: s.autoInstallOnQuit };
}
function emit() {
  onStateChange?.();
  const win = getMainWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send("update:status", getUpdateState());
  }
}
function applyFeed() {
  const testFeed = process.env.EW_UPDATE_FEED;
  if (process.env.EW_UPDATE_TEST && testFeed) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: testFeed, channel: "latest" });
    console.log(`[update] using local test feed: ${testFeed}`);
    return;
  }
  const base = getReleasesBaseUrl();
  if (!base) {
    console.log("[update] no release feed for active env; auto-update disabled");
    return;
  }
  const url2 = `${base.replace(/\/$/, "")}/client/latest`;
  autoUpdater.setFeedURL({ provider: "generic", url: url2, channel: "latest" });
  console.log(`[update] feed: ${url2}`);
}
function registerEventHandlers() {
  autoUpdater.on("checking-for-update", () => {
    internal = { ...internal, status: "checking", error: null };
    emit();
  });
  autoUpdater.on("update-available", (info) => {
    internal = { ...internal, status: "available", version: info.version, error: null };
    emit();
  });
  autoUpdater.on("update-not-available", () => {
    internal = { status: "idle", version: null, percent: null, error: null };
    emit();
  });
  autoUpdater.on("download-progress", (p) => {
    internal = { ...internal, status: "downloading", percent: Math.round(p.percent) };
    emit();
  });
  autoUpdater.on("update-downloaded", (info) => {
    internal = { status: "downloaded", version: info.version, percent: 100, error: null };
    emit();
  });
  autoUpdater.on("error", (err) => {
    const msg = err?.message ?? "Update error";
    console.error("[update] error:", msg);
    if (internal.status === "downloading") {
      internal = { ...internal, status: "available", percent: null, error: msg };
      emit();
    } else if (internal.status === "checking") {
      internal = { ...internal, status: "idle", error: msg };
      emit();
    }
  });
}
function initUpdateManager(opts) {
  onStateChange = opts.onStateChange;
  getMainWindow = opts.getMainWindow;
  if (!configured) {
    configured = true;
    const s = getUpdateSettings();
    autoUpdater.autoDownload = s.autoDownload;
    autoUpdater.autoInstallOnAppQuit = s.autoInstallOnQuit;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = true;
    autoUpdater.logger = {
      info: (m) => console.log("[update]", m),
      warn: (m) => console.warn("[update]", m),
      error: (m) => console.error("[update]", m),
      debug: () => {
      }
    };
    registerEventHandlers();
  }
  applyFeed();
  startPolling();
}
function startPolling() {
  if (!isEnabled() || polling) return;
  polling = true;
  startupTimer = setTimeout(() => {
    checkForUpdates().catch((err) => console.error("[update] initial check failed:", err));
  }, INITIAL_DELAY_MS);
  intervalTimer = setInterval(() => {
    checkForUpdates().catch((err) => console.error("[update] periodic check failed:", err));
  }, CHECK_INTERVAL_MS);
}
async function checkForUpdates() {
  if (!isEnabled()) return getUpdateState();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error("[update] checkForUpdates failed:", err);
    internal = {
      ...internal,
      status: "error",
      error: err instanceof Error ? err.message : String(err)
    };
    emit();
  }
  return getUpdateState();
}
async function downloadUpdate() {
  if (!isEnabled()) return;
  internal = { ...internal, error: null };
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[update] downloadUpdate failed:", msg);
    internal = { ...internal, error: msg };
    emit();
  }
}
function quitAndInstall() {
  if (internal.status !== "downloaded") return;
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    console.error("[update] quitAndInstall failed:", err);
  }
}
function getSettings() {
  return getUpdateSettings();
}
function updateSettings(patch) {
  const s = setUpdateSettings(patch);
  autoUpdater.autoDownload = s.autoDownload;
  autoUpdater.autoInstallOnAppQuit = s.autoInstallOnQuit;
  emit();
  return s;
}
function isUpdateDownloaded() {
  return internal.status === "downloaded";
}
function getPendingUpdateVersion() {
  return internal.status === "available" || internal.status === "downloaded" ? internal.version : null;
}
function stopUpdateManager() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  polling = false;
}
function mlog(msg) {
  console.log(msg);
}
const DEFAULT_RESCAN_INTERVAL_MS = 2e4;
class McpConfigMonitor extends events.EventEmitter {
  watcher = null;
  workspaceStorageWatcher = null;
  pluginCacheWatcher = null;
  lastKnownServers = /* @__PURE__ */ new Map();
  debounceTimer = null;
  rescanTimer = null;
  debounceMs;
  rescanIntervalMs;
  isRunning = false;
  isCheckingForChanges = false;
  pendingRescan = false;
  configFiles = /* @__PURE__ */ new Set();
  /** Lookup map from path → entry metadata (for triggersDynamicRescan etc.) */
  configEntryByPath = /* @__PURE__ */ new Map();
  constructor(_seenStore, debounceMs = 500, rescanIntervalMs = DEFAULT_RESCAN_INTERVAL_MS) {
    super();
    this.debounceMs = debounceMs;
    this.rescanIntervalMs = rescanIntervalMs;
  }
  /**
   * Start monitoring MCP config files for changes.
   */
  async start() {
    mlog("[Monitor] start() called");
    if (this.isRunning) {
      mlog("[Monitor] Already running, skipping");
      return;
    }
    await this.quarantineExistingServers();
    const entries = await getAllConfigEntries();
    this.configEntryByPath = buildEntryMap(entries);
    this.configFiles = new Set(getWatchablePaths(entries));
    const existingPaths = [];
    const parentDirs = /* @__PURE__ */ new Set();
    for (const p of this.configFiles) {
      try {
        await fs.promises.access(p);
        existingPaths.push(p);
      } catch {
        const parentDir = path.dirname(p);
        if (parentDir) {
          parentDirs.add(parentDir);
        }
      }
    }
    for (const parentDir of parentDirs) {
      try {
        await fs.promises.access(parentDir);
        existingPaths.push(parentDir);
      } catch {
      }
    }
    this.watcher = chokidar.watch(existingPaths, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      // Don't recurse into subdirectories
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });
    this.watcher.on("change", (path2) => this.handleFileChange(path2));
    this.watcher.on("add", (path2) => this.handleFileChange(path2));
    this.watcher.on("unlink", (path2) => this.handleFileChange(path2));
    this.watcher.on("error", (error) => this.emit("error", error));
    await this.startWorkspaceStorageWatcher();
    await this.startPluginCacheWatcher();
    this.isRunning = true;
    this.startRescanTimer();
    mlog(
      `[Monitor] Started - watching ${existingPaths.length} paths, ${this.configFiles.size} config files, ${this.lastKnownServers.size} known servers`
    );
  }
  /**
   * Stop monitoring.
   */
  async stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.workspaceStorageWatcher) {
      await this.workspaceStorageWatcher.close();
      this.workspaceStorageWatcher = null;
    }
    if (this.pluginCacheWatcher) {
      await this.pluginCacheWatcher.close();
      this.pluginCacheWatcher = null;
    }
    this.isRunning = false;
    console.log("[McpConfigMonitor] Stopped");
  }
  /**
   * Force a rescan of all config files and emit changes.
   * Note: if a scan is already in progress this returns [] immediately;
   * changes are still propagated via the 'serversQuarantined'/'serversChanged' events.
   */
  async forceRescan() {
    return this.checkForChanges("forceRescan");
  }
  /**
   * Manually trigger the quarantine workflow on all currently discovered non-Edison servers.
   * This is the same logic as `quarantineExistingServers()` but callable from outside,
   * intended for debug/testing without enabling the tenant-level auto-quarantine setting.
   */
  async runQuarantineWorkflow() {
    return this.quarantineExistingServers();
  }
  /**
   * Get the current state of all discovered servers.
   */
  getCurrentServers() {
    return Array.from(this.lastKnownServers.values());
  }
  /**
   * Add new config file paths to the watch list dynamically.
   * This is used when a new project is registered.
   * @param paths Array of absolute file paths to watch
   * @returns Array of paths that were actually added (new to the watch list)
   */
  async addConfigPaths(paths) {
    if (!this.isRunning || !this.watcher) {
      console.warn("[McpConfigMonitor] Cannot add paths - monitor not running");
      return [];
    }
    const addedPaths = [];
    const pathsToWatch = [];
    const parentDirsToWatch = /* @__PURE__ */ new Set();
    for (const p of paths) {
      if (this.configFiles.has(p)) {
        continue;
      }
      this.configFiles.add(p);
      addedPaths.push(p);
      try {
        await fs.promises.access(p);
        pathsToWatch.push(p);
      } catch {
        const parentDir = path.dirname(p);
        if (parentDir) {
          parentDirsToWatch.add(parentDir);
        }
      }
    }
    for (const parentDir of parentDirsToWatch) {
      try {
        await fs.promises.access(parentDir);
        pathsToWatch.push(parentDir);
      } catch {
      }
    }
    if (pathsToWatch.length > 0) {
      this.watcher.add(pathsToWatch);
      console.log("[McpConfigMonitor] Added paths to watch:", pathsToWatch);
    }
    if (addedPaths.length > 0) {
      await this.checkForChanges("addConfigPaths");
    }
    return addedPaths;
  }
  /**
   * Remove config file paths from the watch list.
   * @param paths Array of absolute file paths to stop watching
   */
  async removeConfigPaths(paths) {
    if (!this.watcher) return;
    for (const p of paths) {
      this.configFiles.delete(p);
    }
    console.log("[McpConfigMonitor] Removed paths from config set:", paths);
  }
  /**
   * Get the set of currently monitored config file paths.
   */
  getMonitoredPaths() {
    return Array.from(this.configFiles);
  }
  /**
   * Start a periodic rescan timer as a safety net to catch MCP registrations
   * that bypass config file writes (e.g., Cursor Extension API, deeplinks).
   */
  startRescanTimer() {
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
    }
    this.rescanTimer = setInterval(async () => {
      if (!this.isRunning) return;
      try {
        await this.checkForChanges("periodicRescan");
      } catch (err) {
        console.error("[McpConfigMonitor] Periodic rescan error:", err);
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }, this.rescanIntervalMs);
    this.rescanTimer.unref();
    console.log(
      `[McpConfigMonitor] Periodic rescan started (every ${this.rescanIntervalMs / 1e3}s)`
    );
  }
  /**
   * Watch Cursor's workspaceStorage directory (depth: 1) so newly-opened projects
   * are detected. When a workspace.json appears or is updated, we rescan project paths
   * and add any newly-discovered .cursor/mcp.json files to the watch list.
   */
  async startWorkspaceStorageWatcher() {
    const storageDir = getCursorWorkspaceStoragePath();
    try {
      await fs.promises.access(storageDir);
    } catch {
      return;
    }
    this.workspaceStorageWatcher = chokidar.watch(storageDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      // Watch workspace.json files inside each subdirectory
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });
    const handleWorkspaceJsonEvent = async (changedPath) => {
      if (!changedPath.endsWith("workspace.json")) return;
      try {
        const latestProjectPaths = await getCursorProjectMcpPaths();
        const newPaths = latestProjectPaths.filter((p) => !this.configFiles.has(p));
        if (newPaths.length > 0) {
          console.log("[McpConfigMonitor] New Cursor projects detected, adding paths:", newPaths);
          await this.addConfigPaths(newPaths);
        }
      } catch (err) {
        console.error("[McpConfigMonitor] Error rescanning Cursor project paths:", err);
      }
    };
    this.workspaceStorageWatcher.on("add", handleWorkspaceJsonEvent);
    this.workspaceStorageWatcher.on("change", handleWorkspaceJsonEvent);
    this.workspaceStorageWatcher.on("error", (error) => this.emit("error", error));
    console.log("[McpConfigMonitor] Watching Cursor workspaceStorage:", storageDir);
  }
  /**
   * Watch Cursor's plugin cache directory so newly-installed plugins are detected.
   * Layout: cache/<marketplace>/<plugin_name>/<sha>/mcp.json
   */
  async startPluginCacheWatcher() {
    const cacheDir = getCursorPluginCachePath();
    try {
      await fs.promises.access(cacheDir);
    } catch {
      return;
    }
    this.pluginCacheWatcher = chokidar.watch(cacheDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 3,
      // marketplace/plugin_name/sha/mcp.json
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });
    const handlePluginCacheEvent = async (changedPath) => {
      if (!changedPath.endsWith("mcp.json")) return;
      await this.handleCursorPluginsInstalledChange();
    };
    this.pluginCacheWatcher.on("add", handlePluginCacheEvent);
    this.pluginCacheWatcher.on("change", handlePluginCacheEvent);
    this.pluginCacheWatcher.on("error", (error) => this.emit("error", error));
    console.log("[McpConfigMonitor] Watching Cursor plugin cache:", cacheDir);
  }
  /**
   * When a Cursor plugin registry or cache file changes, rescan plugin MCP paths
   * and register any new ones with the watcher.
   */
  async handleCursorPluginsInstalledChange() {
    try {
      const latestPluginPaths = await getCursorPluginMcpPaths();
      const newPaths = latestPluginPaths.filter((p) => !this.configFiles.has(p));
      if (newPaths.length > 0) {
        console.log("[McpConfigMonitor] New Cursor plugin MCP paths detected, adding:", newPaths);
        await this.addConfigPaths(newPaths);
      }
    } catch (err) {
      console.error("[McpConfigMonitor] Error rescanning Cursor plugin paths:", err);
    }
  }
  /**
   * When ~/.claude.json changes, rescan Claude Code project paths and register any
   * newly-added project .mcp.json files with the watcher so future edits are caught.
   */
  async handleClaudeHomeJsonChange() {
    try {
      const latestProjectPaths = await getClaudeCodeProjectMcpPaths();
      const newPaths = latestProjectPaths.filter((p) => !this.configFiles.has(p));
      if (newPaths.length > 0) {
        console.log("[McpConfigMonitor] New Claude Code projects detected, adding paths:", newPaths);
        await this.addConfigPaths(newPaths);
      }
    } catch (err) {
      console.error("[McpConfigMonitor] Error rescanning Claude Code project paths:", err);
    }
  }
  handleFileChange(path2) {
    if (!this.configFiles.has(path2)) {
      mlog(`[Monitor] handleFileChange IGNORED (not in configFiles): ${path2}`);
      return;
    }
    mlog(`[Monitor] handleFileChange MATCHED: ${path2}`);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(async () => {
      try {
        const entry = this.configEntryByPath.get(path2);
        if (entry?.triggersDynamicRescan === "claude-code-projects") {
          await this.handleClaudeHomeJsonChange();
        }
        if (entry?.triggersDynamicRescan === "cursor-plugins") {
          await this.handleCursorPluginsInstalledChange();
        }
        await this.checkForChanges(`fileChange:${path2}`);
      } catch (err) {
        console.error("[McpConfigMonitor] Error checking for changes:", err);
        this.emit("error", err);
      }
    }, this.debounceMs);
  }
  /**
   * Quarantine any existing servers on startup.
   * This ensures all non-Edison servers are secured even if they existed before the app started.
   */
  async quarantineExistingServers() {
    mlog("[Monitor] quarantineExistingServers() starting...");
    const { raw: servers } = await discoverMcpServers({ includeRaw: true });
    mlog(
      `[Monitor] quarantineExistingServers: discovered ${servers.length} servers: ${servers.map((s) => `${s.name}@${s.client}`).join(", ")}`
    );
    const pendingEvents = [];
    for (const server of servers) {
      const fingerprint = getServerFingerprint(server);
      this.lastKnownServers.set(fingerprint, server);
      if (isEdisonWatchServer(server)) {
        console.log(`[McpConfigMonitor] Skipping Edison Watch server on startup: ${server.name}`);
        continue;
      }
      console.log(`[McpConfigMonitor] Server pending quarantine on startup: ${server.name}`);
      pendingEvents.push({ server, fingerprint });
    }
    if (pendingEvents.length > 0) {
      console.log(
        "[McpConfigMonitor] Servers pending quarantine on startup:",
        pendingEvents.map((e) => e.server.name)
      );
      for (const { fingerprint } of pendingEvents) {
        this.lastKnownServers.delete(fingerprint);
      }
      this.emit("serversPendingQuarantine", pendingEvents);
    }
  }
  async checkForChanges(source = "unknown") {
    if (this.isCheckingForChanges) {
      mlog(`[Monitor] checkForChanges(${source}) - already in progress, marking pendingRescan`);
      this.pendingRescan = true;
      return [];
    }
    this.isCheckingForChanges = true;
    try {
      let result;
      do {
        this.pendingRescan = false;
        result = await this._checkForChangesImpl(source);
      } while (this.pendingRescan);
      return result;
    } finally {
      this.isCheckingForChanges = false;
    }
  }
  async _checkForChangesImpl(source = "unknown") {
    const { raw: currentServers } = await discoverMcpServers({ includeRaw: true });
    const currentMap = /* @__PURE__ */ new Map();
    for (const server of currentServers) {
      const fingerprint = getServerFingerprint(server);
      currentMap.set(fingerprint, server);
    }
    mlog(
      `[Monitor] _checkForChangesImpl(${source}): discovered ${currentServers.length} servers, lastKnown=${this.lastKnownServers.size}`
    );
    mlog(`[Monitor]   current: ${currentServers.map((s) => `${s.name}@${s.client}`).join(", ")}`);
    mlog(`[Monitor]   lastKnown fingerprints: ${[...this.lastKnownServers.keys()].join(", ")}`);
    mlog(`[Monitor]   current fingerprints: ${[...currentMap.keys()].join(", ")}`);
    const changes = [];
    const addedServers = [];
    for (const [fingerprint, server] of currentMap) {
      const previous = this.lastKnownServers.get(fingerprint);
      if (!previous) {
        mlog(`[Monitor]   NEW server: ${server.name} (${fingerprint}) from ${server.path}`);
        addedServers.push({ server, fingerprint });
      } else if (this.hasServerConfigChanged(previous, server)) {
        changes.push({
          type: "modified",
          server,
          fingerprint
        });
      }
    }
    for (const [fingerprint, server] of this.lastKnownServers) {
      if (!currentMap.has(fingerprint)) {
        changes.push({
          type: "removed",
          server,
          fingerprint
        });
      }
    }
    mlog(`[Monitor] addedServers: ${addedServers.length}, changes: ${changes.length}`);
    const pendingEvents = [];
    for (const { server, fingerprint } of addedServers) {
      if (isEdisonWatchServer(server)) {
        mlog(`[Monitor] Skipping Edison Watch server: ${server.name}`);
        continue;
      }
      if (isOpaqueConfig(server.config)) {
        console.log(`[McpConfigMonitor] Skipping opaque server (IDE-managed): ${server.name}`);
        continue;
      }
      mlog(`[Monitor] Server pending quarantine: ${server.name} from ${server.path}`);
      pendingEvents.push({ server, fingerprint });
    }
    mlog(`[Monitor] ${pendingEvents.length} servers pending quarantine`);
    this.lastKnownServers = currentMap;
    if (pendingEvents.length > 0) {
      console.log(
        "[McpConfigMonitor] Servers pending quarantine:",
        pendingEvents.map((e) => e.server.name)
      );
      for (const { fingerprint } of pendingEvents) {
        this.lastKnownServers.delete(fingerprint);
      }
      this.emit("serversPendingQuarantine", pendingEvents);
    }
    if (changes.length > 0) {
      console.log("[McpConfigMonitor] Other changes:", changes);
      this.emit("serversChanged", changes);
    }
    return changes;
  }
  hasServerConfigChanged(previous, current) {
    return JSON.stringify(previous.config) !== JSON.stringify(current.config);
  }
}
function isEdisonWatchServer(server) {
  if (server.name.includes("edison-watch")) return true;
  const config = server.config;
  if ("command" in config && config.command) {
    const args = config.args?.join(" ") ?? "";
    const argsList = config.args ?? [];
    if (argsList.some((arg) => String(arg).includes("edison-watch"))) return true;
    return config.command === "npx" && args.includes("mcp-remote") && (args.includes("edison.watch") || args.includes("localhost:") && argsList.some((arg) => /\/mcp(?:\/|$)/.test(String(arg))));
  }
  if ("url" in config && config.url) {
    if (config.url.includes("edison-watch")) return true;
    return config.url.includes("edison.watch") || config.url.includes("localhost") && /\/mcp(?:\/|$)/.test(config.url);
  }
  return false;
}
function filterOutEdisonWatchServers(servers) {
  return servers.filter((s) => !isEdisonWatchServer(s));
}
function getClientDisplayName(client) {
  switch (client) {
    case "vscode":
      return "VS Code";
    case "cursor":
      return "Cursor";
    case "claude-code":
      return "Claude Code";
    case "windsurf":
      return "Windsurf";
    case "zed":
      return "Zed";
    case "codex":
      return "Codex";
    case "intellij":
      return "IntelliJ IDEA";
    case "pycharm":
      return "PyCharm";
    case "webstorm":
      return "WebStorm";
    default:
      return client;
  }
}
const AGENT_REGISTRY = {
  claude: {
    displayName: "Claude",
    brandColor: "#D97757",
    svgPath: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
  },
  "claude-code": {
    displayName: "Claude Code",
    brandColor: "#1A1A1A",
    crispEdges: true,
    customViewBox: "0 -20 90 90",
    customSvg: [
      '<g fill="#da7756">',
      '<rect x="15" y="0" width="60" height="10"/>',
      '<rect x="15" y="10" width="10" height="10"/>',
      '<rect x="30" y="10" width="30" height="10"/>',
      '<rect x="65" y="10" width="10" height="10"/>',
      '<rect x="5" y="20" width="80" height="10"/>',
      '<rect x="15" y="30" width="60" height="10"/>',
      '<rect x="20" y="40" width="5" height="10"/>',
      '<rect x="30" y="40" width="5" height="10"/>',
      '<rect x="55" y="40" width="5" height="10"/>',
      '<rect x="65" y="40" width="5" height="10"/>',
      "</g>",
      '<g fill="#1a1a1a">',
      '<rect x="25" y="10" width="5" height="10"/>',
      '<rect x="60" y="10" width="5" height="10"/>',
      "</g>"
    ].join("")
  },
  "claude-desktop": {
    displayName: "Claude Desktop",
    brandColor: "#D97757",
    svgPath: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
  },
  "claude-cowork": {
    displayName: "Claude Cowork",
    brandColor: "#D97857",
    customViewBox: "0 0 512 512",
    customSvg: [
      '<rect x="0" y="0" width="512" height="512" rx="56" ry="56" fill="#D97857"/>',
      '<path d="M431.9 78Q432.3 76.1 425.6 78.4 418.9 80.8 413.8 84.3 408.7 87.8 407.9 87.4 407.1 87 398.4 92.1 389.7 97.2 385.8 98.4 381.8 99.6 379.9 101.5 377.9 103.5 358.5 112.1 339.2 120.7 335.6 123.5 332.1 126.2 320.3 132.1 308.5 138 307.7 139.2 306.9 140.3 305.3 140.3 303.7 140.3 302.9 141.5 302.2 142.7 289.5 149.3 276.9 156 274.1 156.4 271.4 156.8 265.5 160.8 259.6 164.7 256.4 165.4 253.2 166.2 250.1 168.6 246.9 170.9 239.4 174.1 231.9 177.2 229.6 179.6 227.2 181.9 225.6 181.9 224 181.9 223.2 183.1 222.5 184.3 209.1 190.2 195.6 196 194.8 197.2 194.1 198.4 186.6 201.9 179.1 205.4 175.6 208.6 172 211.7 166.4 213.6 160.9 215.6 152.2 220.7 143.6 225.8 146.3 230.9 149.1 236 168.8 259.6 188.5 283.1 192.4 289.4 196.4 295.6 190.5 302.6 184.6 309.7 183.4 312.4 182.2 315.2 165.6 332 149.1 348.9 136.5 367.4 123.9 385.8 115.2 394 106.5 402.2 96.2 415.9 86 429.7 82.5 432.8 78.9 435.9 78.9 437.1 78.9 438.3 81.2 438.3 83.6 438.3 87.5 436 91.5 433.6 95 433.2 98.6 432.8 120.7 423 142.8 413.2 151.1 411.2 159.4 409.3 173.9 402.2 188.5 395.2 195.2 394 202 392.8 211.8 388.1 221.7 383.4 226.8 382.6 231.9 381.8 248.1 373.6 264.3 365.4 268.6 364.2 273 363 278.5 359.9 284 356.8 284.8 357.1 285.6 357.5 293.9 352.8 302.2 348.1 302.9 348.5 303.7 348.9 310.4 345.4 317.1 341.9 320.3 341.5 323.5 341.1 337.3 334.1 351.1 327 359.8 323.9 368.4 320.7 368.8 319.5 369.2 318.3 366 314 362.9 309.7 354.2 301.4 345.5 293.2 341.2 286.5 336.9 279.9 334.9 278.8 332.9 277.6 328.2 271.3 323.5 265 323.5 263.9 323.5 262.7 321.1 261.1 318.7 259.5 314 253.7 309.3 247.8 318 234.1 326.6 220.3 331.4 214.8 336.1 209.3 338.5 204.2 340.8 199.2 349.1 189.8 357.4 180.3 358.5 177.2 359.7 174.1 361.3 172.9 362.9 171.7 366.9 165.1 370.8 158.4 384.6 141.9 398.4 125.5 400.8 121.2 403.1 116.8 407.5 112.5 411.8 108.2 421.6 94.1 431.5 80 431.9 78Z" fill="#FAF9F5"/>',
      '<path d="M335.7 158.8Q332.9 154.5 329.8 154.1 326.6 153.7 324.2 154.5 321.9 155.2 319.9 157.6 317.9 160 316.4 164.7 314.8 169.4 304.1 174.8 293.5 180.3 282.4 188.6 271.4 196.8 259.9 202.7 248.5 208.6 240.2 214.4 231.9 220.3 230.4 220.7 228.8 221.1 226 219.5 223.3 218 219.3 218 215.4 218 211.8 219.9 208.3 221.9 206.7 225.4 205.1 228.9 206.3 234.4 207.5 239.9 210.6 242.3 213.8 244.6 221.3 245.8 228.8 247 234.3 253.3 239.8 259.5 260.7 278 281.6 296.4 281.2 301.5 280.9 306.6 269 311.7 257.2 316.8 226.8 333.2 196.4 349.7 194.1 350.1 191.7 350.5 189.3 349.3 187 348.1 184.2 348.9 181.4 349.7 178.7 353.6 175.9 357.5 175.9 359.9 175.9 362.2 177.5 364.6 179.1 366.9 182.2 368.1 185.4 369.3 188.9 368.9 192.5 368.5 194.9 365 197.2 361.5 197.2 358.7 197.2 356 200.4 355.2 203.5 354.4 220.1 345.8 236.7 337.2 241.4 336 246.1 334.8 256.4 328.5 266.7 322.3 269.8 321.9 273 321.5 278.5 318.3 284 315.2 287.2 316.4 290.3 317.5 294.7 317.2 299 316.8 303.7 313.6 308.5 310.5 309.3 306.6 310 302.7 308.1 298.7 306.1 294.8 301.8 291.7 297.4 288.5 292.3 289.3 287.2 290.1 277.7 280.7 268.2 271.3 262.7 267.8 257.2 264.2 245.7 252.5 234.3 240.7 234.3 235.2 234.3 229.7 254.8 215.6 275.3 201.5 284 196.4 292.7 191.3 298.6 189 304.5 186.6 312.8 180.3 321.1 174.1 323.8 175.2 326.6 176.4 330.6 175.6 334.5 174.8 336.1 172.9 337.7 170.9 338 167 338.4 163.1 335.7 158.8Z" fill="#0A0A0A"/>'
    ].join("")
  },
  cursor: {
    displayName: "Cursor",
    brandColor: "#1A1A1A",
    svgPath: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
  },
  windsurf: {
    displayName: "Windsurf",
    brandColor: "#09B6A2",
    svgPath: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z"
  },
  zed: {
    displayName: "Zed",
    brandColor: "#084CCF",
    svgPath: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z"
  },
  vscode: {
    displayName: "VS Code",
    brandColor: "#007ACC",
    svgPath: "M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"
  },
  codex: {
    displayName: "Codex",
    brandColor: "#FFFFFF",
    customSvg: [
      '<path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"/>',
      '<path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#codex-gradient)"/>',
      "<defs>",
      '<linearGradient gradientUnits="userSpaceOnUse" id="codex-gradient" x1="12" x2="12" y1="3" y2="21">',
      '<stop stop-color="#B1A7FF"/>',
      '<stop offset=".5" stop-color="#7A9DFF"/>',
      '<stop offset="1" stop-color="#3941FF"/>',
      "</linearGradient>",
      "</defs>"
    ].join("")
  },
  intellij: {
    displayName: "IntelliJ IDEA",
    brandColor: "#000000",
    svgPath: "M0 0v24h24V0zm3.723 3.111h5v1.834h-1.39v6.277h1.39v1.834h-5v-1.834h1.444V4.945H3.723zm11.055 0H17v6.5c0 .612-.055 1.111-.222 1.556-.167.444-.39.777-.723 1.11-.277.279-.666.557-1.11.668a3.933 3.933 0 0 1-1.445.278c-.778 0-1.444-.167-1.944-.445a4.81 4.81 0 0 1-1.279-1.056l1.39-1.555c.277.334.555.555.833.722.277.167.611.278.945.278.389 0 .721-.111 1-.389.221-.278.333-.667.333-1.278zM2.222 19.5h9V21h-9z"
  },
  pycharm: {
    displayName: "PyCharm",
    brandColor: "#000000",
    svgPath: "M7.833 6.666v-.055c0-1-.667-1.5-1.778-1.5H4.389v3.055h1.723c1.111 0 1.721-.666 1.721-1.5zM0 0v24h24V0H0zm2.223 3.167h4c2.389 0 3.833 1.389 3.833 3.445v.055c0 2.278-1.778 3.5-4.001 3.5H4.389v2.945H2.223V3.167zM11.277 21h-9v-1.5h9V21zm4.779-7.777c-2.944.055-5.111-2.223-5.111-5.057C10.944 5.333 13.056 3 16.111 3c1.889 0 3 .611 3.944 1.556l-1.389 1.61c-.778-.722-1.556-1.111-2.556-1.111-1.658 0-2.873 1.375-2.887 3.084.014 1.709 1.174 3.083 2.887 3.083 1.111 0 1.833-.445 2.61-1.167l1.39 1.389c-.999 1.112-2.166 1.779-4.054 1.779z"
  },
  webstorm: {
    displayName: "WebStorm",
    brandColor: "#000000",
    svgPath: "M0 0v24h24V0H0zm17.889 2.889c1.444 0 2.667.444 3.667 1.278l-1.111 1.667c-.889-.611-1.722-1-2.556-1s-1.278.389-1.278.889v.056c0 .667.444.889 2.111 1.333 2 .556 3.111 1.278 3.111 3v.056c0 2-1.5 3.111-3.611 3.111-1.5-.056-3-.611-4.167-1.667l1.278-1.556c.889.722 1.833 1.222 2.944 1.222.889 0 1.389-.333 1.389-.944v-.056c0-.556-.333-.833-2-1.278-2-.5-3.222-1.056-3.222-3.056v-.056c0-1.833 1.444-3 3.444-3zm-16.111.222h2.278l1.5 5.778 1.722-5.778h1.667l1.667 5.778 1.5-5.778h2.333l-2.833 9.944H9.723L8.112 7.277l-1.667 5.778H4.612L1.779 3.111zm.5 16.389h9V21h-9v-1.5z"
  },
  copilot: {
    displayName: "GitHub Copilot",
    brandColor: "#000000",
    svgPath: "M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z"
  },
  devin: {
    displayName: "Devin",
    brandColor: "#FFFFFF",
    customViewBox: "-4 -4 32 32",
    customSvg: [
      '<rect x="-4" y="-4" width="32" height="32" rx="6" fill="#FFFFFF"/>',
      '<path fill="#3969CA" d="M2.033 9.867l2.554 1.483a.589.589 0 00.592 0l2.554-1.483.01-.008a.608.608 0 00.11-.084l.013-.015a.631.631 0 00.076-.1c.003-.005.008-.01.01-.016a.558.558 0 00.052-.125l.007-.028a.611.611 0 00.019-.14V7.868c0-.572.307-1.105.8-1.392a1.595 1.595 0 011.598 0l1.277.742a.54.54 0 00.129.053l.028.01c.044.01.088.015.133.016h.006l.013-.002a.587.587 0 00.27-.074l.011-.004 2.554-1.483a.596.596 0 00.297-.516V2.253a.595.595 0 00-.297-.516L12.293.257a.587.587 0 00-.591 0L9.148 1.737l-.01.01a.609.609 0 00-.109.083l-.014.015a.632.632 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.028a.612.612 0 00-.018.14v1.483c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.603.603 0 00-.13-.053l-.028-.008a.658.658 0 00-.133-.018h-.02a.57.57 0 00-.269.074c-.003.002-.008.002-.012.005L2.033 5.872a.596.596 0 00-.297.515v2.966c0 .213.113.41.297.515z"/>',
      '<path fill="#21C19A" d="M15.943 10.607a1.596 1.596 0 011.599 0l1.276.74c.041.025.085.04.13.055l.028.008c.043.01.088.016.133.018h.005c.005 0 .01-.002.014-.003a.474.474 0 00.122-.016l.021-.005a.616.616 0 00.126-.052c.004-.002.009-.002.013-.005l2.554-1.482a.597.597 0 00.297-.516V6.383a.596.596 0 00-.297-.515l-2.552-1.483a.587.587 0 00-.592 0l-2.553 1.482-.011.008a.61.61 0 00-.108.084l-.014.016a.637.637 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.029a.612.612 0 00-.018.14v1.482c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.584.584 0 00-.13-.053l-.028-.008a.62.62 0 00-.133-.018h-.02a.587.587 0 00-.269.074l-.012.004L9.15 10a.596.596 0 00-.296.516v2.966c0 .212.112.409.296.515l2.554 1.483s.008.002.012.005c.04.022.082.04.126.052l.02.004a.57.57 0 00.123.017l.014.002h.006c.054 0 .108-.01.16-.025a.587.587 0 00.13-.054l1.277-.741a1.597 1.597 0 012.398 1.392v1.482c0 .049.007.095.019.14l.007.028a.619.619 0 00.051.125c.004.006.008.01.01.016a.6.6 0 00.076.1l.014.015c.033.032.069.06.108.084.004.002.006.006.011.008l2.554 1.483a.59.59 0 00.593 0l2.554-1.483a.597.597 0 00.296-.516v-2.965a.595.595 0 00-.296-.516l-2.554-1.483s-.008-.002-.012-.005a.54.54 0 00-.126-.051c-.007-.003-.013-.003-.02-.005a.635.635 0 00-.125-.017h-.018a.557.557 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.595 1.595 0 01-1.598 0 1.615 1.615 0 010-2.785l-.005-.001z"/>',
      '<path fill="#0294DE" d="M14.848 18.265l-2.554-1.482-.012-.005a.526.526 0 00-.126-.052c-.007-.002-.014-.002-.02-.005a.64.64 0 00-.124-.017h-.02a.56.56 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.594 1.594 0 01-1.598 0c-.493-.286-.8-.82-.8-1.393V14.65a.563.563 0 00-.018-.14l-.008-.028a.604.604 0 00-.051-.124l-.01-.017a.603.603 0 00-.076-.1l-.014-.015a.596.596 0 00-.109-.084c-.003-.002-.005-.006-.01-.008L5.178 12.65a.587.587 0 00-.591 0l-2.554 1.483a.596.596 0 00-.297.516v2.965c0 .213.113.41.297.516l2.554 1.483.012.004a.618.618 0 00.267.074l.016.002h.007a.55.55 0 00.16-.026.584.584 0 00.129-.053l1.277-.742a1.597 1.597 0 012.398 1.393v1.482c0 .05.007.095.019.14l.007.028c.013.044.03.085.051.125l.01.016c.022.036.047.07.076.1l.014.015c.032.032.069.06.109.084l.01.008 2.554 1.483a.587.587 0 00.593 0l2.554-1.483a.596.596 0 00.296-.515v-2.966a.596.596 0 00-.296-.516h-.002z"/>'
    ].join("")
  },
  aider: {
    displayName: "Aider",
    brandColor: "#E11D48"
  },
  "m365-copilot": {
    displayName: "Microsoft Copilot",
    brandColor: "#FFFFFF",
    customViewBox: "2 4 43.998 40",
    customSvg: [
      '<path fill="url(#mc__a)" d="M34.142 7.325A4.63 4.63 0 0 0 29.7 4h-1.35a4.63 4.63 0 0 0-4.554 3.794L21.48 20.407l.575-1.965a4.63 4.63 0 0 1 4.444-3.33h7.853l3.294 1.282 3.175-1.283h-.926a4.63 4.63 0 0 1-4.443-3.325l-1.31-4.461z"/>',
      '<path fill="url(#mc__b)" d="M14.33 40.656A4.63 4.63 0 0 0 18.779 44h2.87a4.63 4.63 0 0 0 4.629-4.51l.312-12.163-.654 2.233a4.63 4.63 0 0 1-4.443 3.329h-7.919l-2.823-1.532-3.057 1.532h.912a4.63 4.63 0 0 1 4.447 3.344l1.279 4.423z"/>',
      '<path fill="url(#mc__c)" d="M29.5 4H13.46c-4.583 0-7.332 6.057-9.165 12.113C2.123 23.29-.72 32.885 7.503 32.885h6.925a4.63 4.63 0 0 0 4.456-3.358 2078.617 2078.617 0 0 1 4.971-17.156c.843-2.843 1.544-5.284 2.621-6.805C27.08 4.714 28.086 4 29.5 4z"/>',
      '<path fill="url(#mc__d)" d="M29.5 4H13.46c-4.583 0-7.332 6.057-9.165 12.113C2.123 23.29-.72 32.885 7.503 32.885h6.925a4.63 4.63 0 0 0 4.456-3.358 2078.617 2078.617 0 0 1 4.971-17.156c.843-2.843 1.544-5.284 2.621-6.805C27.08 4.714 28.086 4 29.5 4z"/>',
      '<path fill="url(#mc__e)" d="M18.498 44h16.04c4.582 0 7.332-6.058 9.165-12.115 2.171-7.177 5.013-16.775-3.208-16.775h-6.926a4.63 4.63 0 0 0-4.455 3.358 2084.036 2084.036 0 0 1-4.972 17.16c-.842 2.843-1.544 5.285-2.62 6.806-.604.852-1.61 1.566-3.024 1.566z"/>',
      '<path fill="url(#mc__f)" d="M18.498 44h16.04c4.582 0 7.332-6.058 9.165-12.115 2.171-7.177 5.013-16.775-3.208-16.775h-6.926a4.63 4.63 0 0 0-4.455 3.358 2084.036 2084.036 0 0 1-4.972 17.16c-.842 2.843-1.544 5.285-2.62 6.806-.604.852-1.61 1.566-3.024 1.566z"/>',
      "<defs>",
      '<radialGradient id="mc__a" cx="0" cy="0" r="1" gradientTransform="matrix(-10.961 -13.39 12.59 -10.306 38.005 20.514)" gradientUnits="userSpaceOnUse"><stop offset=".096" stop-color="#00AEFF"/><stop offset=".773" stop-color="#2253CE"/><stop offset="1" stop-color="#0736C4"/></radialGradient>',
      '<radialGradient id="mc__b" cx="0" cy="0" r="1" gradientTransform="rotate(51.84 -28.201 27.85) scale(15.991 15.512)" gradientUnits="userSpaceOnUse"><stop stop-color="#FFB657"/><stop offset=".634" stop-color="#FF5F3D"/><stop offset=".923" stop-color="#C02B3C"/></radialGradient>',
      '<radialGradient id="mc__e" cx="0" cy="0" r="1" gradientTransform="rotate(109.274 16.301 20.802) scale(38.387 45.987)" gradientUnits="userSpaceOnUse"><stop offset=".066" stop-color="#8C48FF"/><stop offset=".5" stop-color="#F2598A"/><stop offset=".896" stop-color="#FFB152"/></radialGradient>',
      '<linearGradient id="mc__c" x1="12.5" x2="14.788" y1="7.5" y2="33.975" gradientUnits="userSpaceOnUse"><stop offset=".156" stop-color="#0D91E1"/><stop offset=".487" stop-color="#52B471"/><stop offset=".652" stop-color="#98BD42"/><stop offset=".937" stop-color="#FFC800"/></linearGradient>',
      '<linearGradient id="mc__d" x1="14.5" x2="15.75" y1="4" y2="32.885" gradientUnits="userSpaceOnUse"><stop stop-color="#3DCBFF"/><stop offset=".247" stop-color="#0588F7" stop-opacity="0"/></linearGradient>',
      '<linearGradient id="mc__f" x1="42.586" x2="42.569" y1="13.346" y2="21.215" gradientUnits="userSpaceOnUse"><stop offset=".058" stop-color="#F8ADFA"/><stop offset=".708" stop-color="#A86EDD" stop-opacity="0"/></linearGradient>',
      "</defs>"
    ].join("")
  },
  chatgpt: {
    displayName: "ChatGPT",
    brandColor: "#000000",
    svgPath: "M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.124 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.41-.676zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.681 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.361l2.602-1.502 2.603 1.502v3.003l-2.603 1.502-2.602-1.502z"
  },
  "oai-workspace-agents": {
    displayName: "OpenAI Workspace Agents",
    brandColor: "#19223D",
    customViewBox: "0 0 480 480",
    customSvg: [
      "<defs>",
      '<radialGradient id="oaiwa-head" cx="38%" cy="28%" r="85%">',
      '<stop offset="0%" stop-color="#FFFFFF"/>',
      '<stop offset="58%" stop-color="#F7F9FB"/>',
      '<stop offset="100%" stop-color="#D9DEE4"/>',
      "</radialGradient>",
      '<radialGradient id="oaiwa-ball" cx="34%" cy="30%" r="80%">',
      '<stop offset="0%" stop-color="#E2F5FF"/>',
      '<stop offset="38%" stop-color="#5BB8F4"/>',
      '<stop offset="100%" stop-color="#2389DA"/>',
      "</radialGradient>",
      '<linearGradient id="oaiwa-ear" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0%" stop-color="#EDF0F3"/>',
      '<stop offset="100%" stop-color="#CFD5DB"/>',
      "</linearGradient>",
      '<linearGradient id="oaiwa-eye" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0%" stop-color="#2A3458"/>',
      '<stop offset="100%" stop-color="#19223D"/>',
      "</linearGradient>",
      "</defs>",
      '<rect x="0" y="0" width="480" height="480" rx="96" ry="96" fill="#19223D"/>',
      '<line x1="240" y1="170" x2="240" y2="116" stroke="#AEB6BF" stroke-width="6" stroke-linecap="round"/>',
      '<circle cx="240" cy="92" r="23" fill="url(#oaiwa-ball)"/>',
      '<ellipse cx="232" cy="83" rx="7" ry="5" fill="#FFFFFF" opacity="0.7"/>',
      '<ellipse cx="120" cy="276" rx="23" ry="31" fill="url(#oaiwa-ear)"/>',
      '<ellipse cx="360" cy="276" rx="23" ry="31" fill="url(#oaiwa-ear)"/>',
      '<rect x="120" y="165" width="240" height="210" rx="92" ry="88" fill="url(#oaiwa-head)"/>',
      '<rect x="194" y="252" width="36" height="66" rx="18" fill="url(#oaiwa-eye)"/>',
      '<rect x="250" y="252" width="36" height="66" rx="18" fill="url(#oaiwa-eye)"/>',
      '<ellipse cx="205" cy="271" rx="5.5" ry="11" fill="#FFFFFF" opacity="0.85"/>',
      '<ellipse cx="261" cy="271" rx="5.5" ry="11" fill="#FFFFFF" opacity="0.85"/>',
      '<circle cx="221" cy="304" r="3" fill="#FFFFFF" opacity="0.45"/>',
      '<circle cx="277" cy="304" r="3" fill="#FFFFFF" opacity="0.45"/>'
    ].join("")
  }
};
const AGENT_KEYS = Object.keys(AGENT_REGISTRY);
function resolveAgentId(name) {
  if (name.length < 2) return null;
  const lower = name.toLowerCase();
  if (lower in AGENT_REGISTRY) return lower;
  const normalized = lower.replace(/\s+/g, "-");
  if (normalized in AGENT_REGISTRY) return normalized;
  const stripped = lower.replace(/\s+/g, "");
  if (stripped in AGENT_REGISTRY) return stripped;
  for (const key of AGENT_KEYS) if (AGENT_REGISTRY[key].displayName.toLowerCase() === lower) return key;
  for (const key of AGENT_KEYS) {
    if (lower.startsWith(key) || lower.includes(key) || key.startsWith(lower)) return key;
    const spacedKey = key.replace(/-/g, " ");
    if (lower.startsWith(spacedKey) || lower.includes(spacedKey) || spacedKey.startsWith(lower)) return key;
  }
  return null;
}
function escapeHtml$1(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
const FALLBACK_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>`;
function getClientIcon(client, _iconIdSuffix) {
  const entry = AGENT_REGISTRY[client];
  if (!entry) return FALLBACK_ICON;
  if (entry.svgPath) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${entry.svgPath}"/></svg>`;
  }
  if (entry.customSvg) {
    const vb = entry.customViewBox ?? "0 0 24 24";
    return `<svg width="16" height="16" viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${entry.customSvg}</svg>`;
  }
  return FALLBACK_ICON;
}
const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg-base: #0B0E14;
    --bg-raised: #141820;
    --bg-overlay: #1A1F2B;
    --bg-input: #0F1219;
    --accent: #7DFFF6;
    --accent-muted: #5CC8C0;
    --accent-dim: #2A4A48;
    --text-primary: #E8ECF2;
    --text-secondary: #8B95A8;
    --text-muted: #5A6478;
    --border: #1E2432;
    --border-active: #7DFFF6;
    --success: #34D399;
    --warning: #FBBF24;
    --danger: #F87171;
  }

  body {
    font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-base);
    color: var(--text-primary);
    padding: 20px;
  }
`;
const HEADER_CSS = `
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h1 .count {
    color: var(--danger);
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .description {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
    line-height: 1.5;
  }

  .description strong {
    color: var(--danger);
  }

  .summary {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
  }

  .summary .count {
    color: var(--accent);
    font-weight: 500;
  }
`;
const SERVER_CARD_CSS = `
  #servers {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .server-item {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .server-item:hover {
    border-color: var(--text-muted);
  }

  .server-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .server-name {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .server-name strong {
    font-size: 15px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .transport-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 2px 8px;
    border-radius: 3px;
    letter-spacing: 0.5px;
  }

  .server-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
    background: var(--bg-overlay);
    padding: 4px 10px;
    border-radius: 4px;
  }

  .client-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
  }

  .client-name {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .server-info {
    font-size: 12px;
    color: var(--text-secondary);
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    margin-bottom: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-meta {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .meta-label {
    font-weight: 500;
    color: var(--text-muted);
  }

  .meta-value {
    color: var(--text-secondary);
  }

  .meta-value.path {
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }

  .meta-separator {
    color: var(--border);
  }

  .empty-state {
    text-align: center;
    padding: 48px 20px;
    color: var(--text-muted);
  }

  .empty-state p {
    margin-top: 12px;
    font-size: 14px;
  }
`;
const BUTTON_CSS = `
  .server-actions {
    display: flex;
    gap: 8px;
  }

  .button {
    border: 1px solid var(--border);
    background: var(--bg-overlay);
    color: var(--text-primary);
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    flex: 1;
  }

  .button:hover {
    filter: brightness(1.15);
    transform: translateY(-1px);
  }

  .button:active {
    transform: translateY(0);
  }

  .button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .button-dismiss {
    background: transparent !important;
    color: var(--text-muted) !important;
    border-color: var(--border) !important;
  }

  .button-bulk {
    font-size: 11px;
    padding: 5px 10px;
    flex: none;
  }

  .button-dismiss-all {
    background: transparent !important;
    color: var(--text-muted) !important;
    border-color: var(--border) !important;
  }

  .done-message {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
  }

  .done-message .checkmark {
    font-size: 32px;
    margin-bottom: 12px;
  }

  .already-pending-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 8px 16px;
    border-radius: 6px;
    width: 100%;
    font-style: italic;
  }
`;
const QUARANTINE_CSS = `
  .quarantine-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 4px 10px;
    border-radius: 4px;
    margin-bottom: 12px;
  }

  .quarantine-badge svg {
    color: var(--accent);
  }

  h1 .count {
    color: var(--accent);
  }

  .description strong {
    color: var(--accent);
  }

  .button-request {
    background: var(--accent-muted) !important;
    color: var(--bg-base) !important;
    border-color: var(--accent-muted) !important;
    font-weight: 600 !important;
  }

  .button-request-all {
    background: var(--accent-muted) !important;
    color: var(--bg-base) !important;
    border-color: var(--accent-muted) !important;
    font-weight: 600 !important;
  }

  .done-message .checkmark {
    color: var(--accent);
  }
`;
const REGISTRATION_CSS = QUARANTINE_CSS;
const CREDENTIAL_REVIEW_CSS = `
  .credential-review {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }

  .cr-description {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 8px;
    line-height: 1.4;
  }

  .cr-hint {
    font-size: 10px;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 8px;
  }

  .cr-entries {
    background: var(--bg-input);
    border-radius: 6px;
    padding: 10px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    font-size: 12px;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cr-entry {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .cr-label {
    color: var(--text-muted);
    flex-shrink: 0;
    min-width: 70px;
    user-select: none;
  }

  .cr-value {
    flex: 1;
    word-break: break-all;
    color: var(--text-secondary);
    user-select: text;
    -webkit-user-select: text;
  }

  .cr-value[data-context="command"] {
    user-select: none;
    -webkit-user-select: none;
  }

  .cr-secret-btn {
    display: inline;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid rgba(249, 115, 22, 0.3);
    background: rgba(249, 115, 22, 0.2);
    color: #fdba74;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    transition: background 0.15s ease;
  }

  .cr-secret-btn:hover {
    background: rgba(249, 115, 22, 0.3);
  }

  .cr-secret-btn.disabled {
    background: var(--bg-base);
    color: var(--text-muted);
    border-color: var(--border);
  }

  .cr-var-label {
    font-size: 10px;
    color: rgba(251, 146, 60, 0.7);
    margin-left: 4px;
  }

  .cr-popup {
    position: fixed;
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-overlay);
    border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    transform: translateX(-50%);
  }

  .cr-popup-mark {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: rgba(249, 115, 22, 0.2);
    color: #fdba74;
    border: 1px solid rgba(249, 115, 22, 0.3);
    cursor: pointer;
    font-family: 'Archivo', sans-serif;
    white-space: nowrap;
    transition: background 0.15s ease;
  }

  .cr-popup-mark:hover {
    background: rgba(249, 115, 22, 0.3);
  }

  .cr-popup-close {
    font-size: 11px;
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    line-height: 1;
  }

  .cr-popup-close:hover {
    color: var(--text-primary);
  }

  .cr-actions {
    display: flex;
    gap: 8px;
  }

  .cr-empty {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 4px 0;
  }

  .cr-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 8px 0;
  }

  .cr-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
const DEBUG_CSS = `
  .refresh-btn {
    border: 1px solid var(--border);
    background: var(--bg-overlay);
    color: var(--text-primary);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .refresh-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .refresh-btn:active {
    transform: translateY(1px);
  }

  .refresh-btn.loading {
    opacity: 0.6;
    pointer-events: none;
  }

  .refresh-btn svg {
    transition: transform 0.3s ease;
  }

  .refresh-btn.loading svg {
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .debug-actions {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 16px;
    background: var(--bg-raised);
  }

  .debug-actions h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }

  .debug-actions .actions-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-btn {
    border: 1px solid var(--border);
    background: var(--bg-overlay);
    color: var(--text-primary);
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'Archivo', sans-serif;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .action-btn:active {
    transform: translateY(1px);
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }

  .action-btn .status {
    font-size: 11px;
    opacity: 0.7;
  }

  .path-group {
    margin-bottom: 10px;
  }

  .path-group:last-child {
    margin-bottom: 0;
  }

  .path-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .path-group-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .path-group-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-dim);
    padding: 1px 6px;
    border-radius: 3px;
  }

  .path-item {
    font-size: 11px;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    color: var(--text-secondary);
    padding: 3px 8px;
    margin-left: 4px;
    border-left: 2px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-empty {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 3px 8px;
    margin-left: 4px;
  }
`;
let debugWindow = null;
async function gatherProjectPaths() {
  const [cursor, cursorPlugins, vscode, claudeCode] = await Promise.all([
    getCursorProjectMcpPaths(),
    getCursorPluginMcpPaths(),
    getVsCodeWorkspacePaths(),
    getClaudeCodeProjectMcpPaths()
  ]);
  return [
    { label: "Claude Code Projects", paths: claudeCode },
    { label: "Cursor Project MCP Configs", paths: cursor },
    { label: "Cursor Plugin MCP Configs", paths: cursorPlugins },
    { label: "VS Code Workspaces", paths: vscode }
  ];
}
function buildProjectPathsHtml(groups) {
  const totalPaths = groups.reduce((sum, g) => sum + g.paths.length, 0);
  const groupsHtml = groups.map((group) => {
    const pathsHtml = group.paths.length === 0 ? '<div class="path-empty">None found</div>' : group.paths.map((p) => `<div class="path-item">${escapeHtml$1(p)}</div>`).join("");
    return `
        <div class="path-group">
          <div class="path-group-header">
            <span class="path-group-label">${escapeHtml$1(group.label)}</span>
            <span class="path-group-count">${group.paths.length}</span>
          </div>
          ${pathsHtml}
        </div>
      `;
  }).join("");
  return `
    <div class="debug-actions" id="project-paths-section">
      <h2>Project Directories <span class="path-group-count" style="margin-left:6px">${totalPaths}</span></h2>
      ${groupsHtml}
    </div>
  `;
}
function getServerInfoHtml(server) {
  const config = server.config;
  if ("command" in config && config.command) {
    const parts = [config.command, ...config.args ?? []].join(" ");
    return escapeHtml$1(parts);
  }
  if ("url" in config && config.url) {
    return escapeHtml$1(config.url);
  }
  return '<span style="opacity:0.5">No config details</span>';
}
function getTransportLabel(server) {
  const config = server.config;
  if ("type" in config && config.type) {
    return config.type.toUpperCase();
  }
  if ("command" in config && config.command) {
    return "STDIO";
  }
  return "UNKNOWN";
}
function buildDebugHtml(servers, projectPathsHtml) {
  const uniqueClients = new Set(servers.map((s) => s.client));
  const serversHtml = servers.map((server) => {
    const safeName = escapeHtml$1(server.name);
    const clientName = getClientDisplayName(server.client);
    const clientIcon = getClientIcon(server.client, `${server.client}-${server.name}-${server.path}`);
    const serverInfo = getServerInfoHtml(server);
    const transport = getTransportLabel(server);
    const safePath = escapeHtml$1(server.path);
    const safeSource = escapeHtml$1(server.source);
    return `
        <div class="server-item">
          <div class="server-header">
            <div class="server-name">
              <strong>${safeName}</strong>
              <span class="transport-badge">${transport}</span>
            </div>
            <div class="server-source">
              <span class="client-icon">${clientIcon}</span>
              <span class="client-name">${clientName}</span>
            </div>
          </div>
          <div class="server-info">${serverInfo}</div>
          <div class="server-meta">
            <span class="meta-label">Source:</span> <span class="meta-value">${safeSource}</span>
            <span class="meta-separator">|</span>
            <span class="meta-label">Config:</span> <span class="meta-value path">${safePath}</span>
          </div>
        </div>
      `;
  }).join("");
  const emptyState = servers.length === 0 ? `<div class="empty-state">
           <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>
           <p>No MCP servers found on this machine.</p>
         </div>` : "";
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Debug: Discovered MCP Servers</title>
      <style>
        ${BASE_CSS}
        ${HEADER_CSS}
        ${SERVER_CARD_CSS}
        ${DEBUG_CSS}
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Discovered MCP Servers</h1>
        <button class="refresh-btn" id="refresh-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>
      <div class="summary">
        Found <span class="count">${servers.length}</span> server${servers.length !== 1 ? "s" : ""}
        across <span class="count">${uniqueClients.size}</span> client${uniqueClients.size !== 1 ? "s" : ""}
      </div>
      <div class="debug-actions">
        <h2>Debug Actions</h2>
        <div class="actions-row">
          <button class="action-btn" id="run-quarantine">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg>
            Run Quarantine Workflow
          </button>
          <button class="action-btn" id="reset-quarantine">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Reset Quarantine
          </button>
        </div>
      </div>
      ${projectPathsHtml}
      <div id="servers">${serversHtml}${emptyState}</div>
      <script>
        const { ipcRenderer } = require('electron')

        document.getElementById('run-quarantine').addEventListener('click', async function () {
          if (this.disabled) return
          this.disabled = true
          const originalHtml = this.innerHTML
          this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Running... <span class="status">(quarantine dialog will appear)</span>'
          try {
            const result = await ipcRenderer.invoke('debug:runQuarantine')
            if (!result.success) {
              this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Failed: ' + (result.error || 'unknown error')
              setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
              return
            }
            this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg> Done'
            setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 2000)
          } catch (err) {
            console.error('Quarantine failed:', err)
            this.innerHTML = originalHtml
            this.disabled = false
          }
        })

        document.getElementById('reset-quarantine').addEventListener('click', async function () {
          if (this.disabled) return
          this.disabled = true
          const resetIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
          const originalHtml = this.innerHTML
          this.innerHTML = resetIcon + ' Restoring...'
          try {
            const result = await ipcRenderer.invoke('debug:resetQuarantine')
            if (!result.success) {
              this.innerHTML = resetIcon + ' Failed: ' + (result.error || 'unknown error')
              setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
              return
            }
            const msg = result.restored > 0
              ? ' Restored ' + result.restored + ' server' + (result.restored !== 1 ? 's' : '')
              : ' No quarantined servers found'
            this.innerHTML = resetIcon + msg
            // Also refresh the server list since configs changed
            try {
              const html = await ipcRenderer.invoke('debug:refreshServers')
              document.getElementById('servers').innerHTML = html.serversHtml
              document.querySelector('.summary').innerHTML = html.summaryHtml
              const pathsSection = document.getElementById('project-paths-section')
              if (pathsSection && html.projectPathsHtml) {
                pathsSection.outerHTML = html.projectPathsHtml
              }
            } catch (e) { console.error('Refresh after reset failed:', e) }
            setTimeout(() => { this.innerHTML = originalHtml; this.disabled = false }, 3000)
          } catch (err) {
            console.error('Reset failed:', err)
            this.innerHTML = originalHtml
            this.disabled = false
          }
        })

        document.getElementById('refresh-btn').addEventListener('click', async function () {
          this.classList.add('loading')
          this.textContent = ''
          this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refreshing...'
          try {
            const html = await ipcRenderer.invoke('debug:refreshServers')
            document.getElementById('servers').innerHTML = html.serversHtml
            document.querySelector('.summary').innerHTML = html.summaryHtml
            const pathsSection = document.getElementById('project-paths-section')
            if (pathsSection && html.projectPathsHtml) {
              pathsSection.outerHTML = html.projectPathsHtml
            }
          } catch (err) {
            console.error('Refresh failed:', err)
          } finally {
            this.classList.remove('loading')
            this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Refresh'
          }
        })
      <\/script>
    </body>
    </html>
  `;
}
function buildRefreshData(servers) {
  const uniqueClients = new Set(servers.map((s) => s.client));
  const serversHtml = servers.length === 0 ? `<div class="empty-state">
           <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="opacity:0.3"><path d="M4 3h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm0 8h16a2 2 0 012 2v4a2 2 0 01-2 2H4a2 2 0 01-2-2v-4a2 2 0 012-2zm2-6v2h2V5H6zm0 8v2h2v-2H6z"/></svg>
           <p>No MCP servers found on this machine.</p>
         </div>` : servers.map((server) => {
    const safeName = escapeHtml$1(server.name);
    const clientName = getClientDisplayName(server.client);
    const clientIcon = getClientIcon(server.client, `${server.client}-${server.name}-${server.path}`);
    const serverInfo = getServerInfoHtml(server);
    const transport = getTransportLabel(server);
    const safePath = escapeHtml$1(server.path);
    const safeSource = escapeHtml$1(server.source);
    return `
              <div class="server-item">
                <div class="server-header">
                  <div class="server-name">
                    <strong>${safeName}</strong>
                    <span class="transport-badge">${transport}</span>
                  </div>
                  <div class="server-source">
                    <span class="client-icon">${clientIcon}</span>
                    <span class="client-name">${clientName}</span>
                  </div>
                </div>
                <div class="server-info">${serverInfo}</div>
                <div class="server-meta">
                  <span class="meta-label">Source:</span> <span class="meta-value">${safeSource}</span>
                  <span class="meta-separator">|</span>
                  <span class="meta-label">Config:</span> <span class="meta-value path">${safePath}</span>
                </div>
              </div>
            `;
  }).join("");
  const summaryHtml = `Found <span class="count">${servers.length}</span> server${servers.length !== 1 ? "s" : ""} across <span class="count">${uniqueClients.size}</span> client${uniqueClients.size !== 1 ? "s" : ""}`;
  return { serversHtml, summaryHtml };
}
async function showDebugWindow(parentWindow) {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus();
    return;
  }
  const [servers, projectGroups] = await Promise.all([
    discoverMcpServers(),
    gatherProjectPaths()
  ]);
  debugWindow = new electron.BrowserWindow({
    width: 560,
    height: Math.min(700, 180 + servers.length * 100),
    minWidth: 400,
    minHeight: 300,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: "Debug: Discovered MCP Servers",
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : void 0,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const refreshHandler = async () => {
    const [freshServers, freshGroups] = await Promise.all([
      discoverMcpServers(),
      gatherProjectPaths()
    ]);
    return {
      ...buildRefreshData(freshServers),
      projectPathsHtml: buildProjectPathsHtml(freshGroups)
    };
  };
  try {
    electron.ipcMain.handle("debug:refreshServers", refreshHandler);
  } catch {
    electron.ipcMain.removeHandler("debug:refreshServers");
    electron.ipcMain.handle("debug:refreshServers", refreshHandler);
  }
  debugWindow.on("closed", () => {
    electron.ipcMain.removeHandler("debug:refreshServers");
    debugWindow = null;
  });
  const html = buildDebugHtml(servers, buildProjectPathsHtml(projectGroups));
  debugWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  debugWindow.once("ready-to-show", () => {
    debugWindow?.show();
  });
}
let feedbackWindow = null;
function buildFeedbackHtml() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Send Feedback</title>
      <style>
        ${BASE_CSS}

        h1 {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 6px;
        }

        .subtitle {
          font-size: 13px;
          color: var(--muted);
          margin-bottom: 20px;
          line-height: 1.5;
        }

        label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        textarea {
          width: 100%;
          height: 120px;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          padding: 10px 12px;
          resize: vertical;
          outline: none;
          transition: border-color 0.15s ease;
        }

        textarea:focus {
          border-color: var(--accent);
        }

        .actions {
          display: flex;
          gap: 8px;
          margin-top: 16px;
          justify-content: flex-end;
        }

        button {
          border: 1px solid var(--border);
          background: var(--graphene-grey-800);
          color: var(--text);
          padding: 8px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          font-family: 'Archivo', sans-serif;
          transition: all 0.15s ease;
        }

        button:hover { filter: brightness(1.15); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        #submit-btn {
          background: var(--core-cyan-600);
          color: var(--baseline-black);
          border-color: var(--core-cyan-600);
          font-weight: 600;
        }

        #submit-btn:hover { filter: brightness(1.1); }

        .success {
          text-align: center;
          padding: 32px 20px;
          display: none;
        }

        .success .check {
          font-size: 32px;
          color: var(--circuit-green-500);
          margin-bottom: 12px;
        }

        .success p {
          font-size: 14px;
          color: var(--muted);
        }
      </style>
    </head>
    <body>
      <div id="form-view">
        <h1>Send Feedback</h1>
        <p class="subtitle">Tell us what's on your mind - bugs, suggestions, or anything else.</p>
        <label for="message">Message</label>
        <textarea id="message" placeholder="Describe the issue or share your thoughts..."></textarea>
        <div class="actions">
          <button id="cancel-btn">Cancel</button>
          <button id="submit-btn">Send Feedback</button>
        </div>
      </div>
      <div class="success" id="success-view">
        <div class="check">✓</div>
        <p>Thanks! Your feedback has been sent.</p>
      </div>
      <script>
        const { ipcRenderer } = require('electron')

        document.getElementById('cancel-btn').addEventListener('click', () => {
          window.close()
        })

        document.getElementById('submit-btn').addEventListener('click', async function () {
          const message = document.getElementById('message').value.trim()
          if (!message) {
            document.getElementById('message').focus()
            return
          }
          this.disabled = true
          document.getElementById('cancel-btn').disabled = true
          this.textContent = 'Sending...'
          try {
            await ipcRenderer.invoke('feedback:submit', { message })
            document.getElementById('form-view').style.display = 'none'
            document.getElementById('success-view').style.display = 'block'
            setTimeout(() => window.close(), 1500)
          } catch (err) {
            console.error('Feedback submit failed:', err)
            this.disabled = false
            document.getElementById('cancel-btn').disabled = false
            this.textContent = 'Send Feedback'
          }
        })
      <\/script>
    </body>
    </html>
  `;
}
function showFeedbackWindow() {
  if (feedbackWindow && !feedbackWindow.isDestroyed()) {
    feedbackWindow.focus();
    return;
  }
  feedbackWindow = new electron.BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    title: "Send Feedback",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const submitHandler = async (_event, { message }) => {
    submitUserFeedback(message);
    return { ok: true };
  };
  try {
    electron.ipcMain.handle("feedback:submit", submitHandler);
  } catch {
    electron.ipcMain.removeHandler("feedback:submit");
    electron.ipcMain.handle("feedback:submit", submitHandler);
  }
  feedbackWindow.on("closed", () => {
    electron.ipcMain.removeHandler("feedback:submit");
    feedbackWindow = null;
  });
  const html = buildFeedbackHtml();
  feedbackWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  feedbackWindow.once("ready-to-show", () => feedbackWindow?.show());
}
const CREDENTIAL_REVIEW_JS = `
          // ── Credential review helpers ──────────────────────────────

          function getConfigEntries(config) {
            const entries = []
            if (config.command) {
              entries.push({ context: 'command', key: 'command', rawValue: String(config.command), entryId: 'command:command' })
            }
            if (Array.isArray(config.args)) {
              config.args.forEach((arg, i) => {
                entries.push({ context: 'args', key: 'arg[' + i + ']', rawValue: String(arg), entryId: 'args:arg[' + i + ']' })
              })
            }
            if (config.env && typeof config.env === 'object') {
              Object.entries(config.env).forEach(([k, v]) => {
                entries.push({ context: 'env', key: k, rawValue: String(v), entryId: 'env:' + k })
              })
            }
            if (config.url) {
              entries.push({ context: 'url', key: 'url', rawValue: String(config.url), entryId: 'url:url' })
            }
            if (config.headers && typeof config.headers === 'object') {
              Object.entries(config.headers).forEach(([k, v]) => {
                entries.push({ context: 'headers', key: k, rawValue: String(v), entryId: 'headers:' + k })
              })
            }
            return entries
          }

          function findSecretInValue(raw, secretValues, templatizedValue) {
            for (const [varName, secretVal] of Object.entries(secretValues)) {
              const placeholder = '{' + varName + '}'
              if (templatizedValue.includes(placeholder) && raw.includes(secretVal)) {
                const start = raw.indexOf(secretVal)
                return { varName, start, end: start + secretVal.length, text: secretVal }
              }
            }
            return null
          }

          function getTemplatizedValue(entry, templatizedConfig) {
            if (entry.context === 'args') {
              const idx = parseInt((entry.key.match(/\\\\d+/) || ['0'])[0], 10)
              const tArgs = templatizedConfig.args
              return (tArgs && tArgs[idx]) ? String(tArgs[idx]) : entry.rawValue
            }
            if (entry.context === 'env') {
              const tEnv = templatizedConfig.env
              return (tEnv && tEnv[entry.key]) ? String(tEnv[entry.key]) : entry.rawValue
            }
            if (entry.context === 'url') {
              return templatizedConfig.url ? String(templatizedConfig.url) : entry.rawValue
            }
            if (entry.context === 'headers') {
              const tHeaders = templatizedConfig.headers
              return (tHeaders && tHeaders[entry.key]) ? String(tHeaders[entry.key]) : entry.rawValue
            }
            return entry.rawValue
          }

          function generateTokenName(markings) {
            const used = new Set()
            for (const m of Object.values(markings)) {
              const match = m.varName.match(/^TOKEN_(\\\\d+)$/)
              if (match) used.add(Number(match[1]))
            }
            let n = 1
            while (used.has(n)) n++
            return 'TOKEN_' + n
          }

          function dismissPopup() {
            if (activePopup) { activePopup.remove(); activePopup = null }
            window.getSelection()?.removeAllRanges()
          }

          document.addEventListener('mousedown', (e) => {
            if (activePopup && !activePopup.contains(e.target)) dismissPopup()
          })

          function renderValueSpan(entry, marking) {
            const span = document.createElement('span')
            span.className = 'cr-value'
            span.dataset.entryId = entry.entryId
            span.dataset.context = entry.context
            if (entry.context !== 'command') {
              span.setAttribute('data-value-container', '')
            }
            updateValueSpan(span, entry, marking)
            return span
          }

          function updateValueSpan(span, entry, marking) {
            span.innerHTML = ''
            if (!marking) {
              span.textContent = entry.rawValue
              return
            }
            if (marking.start > 0) {
              const pre = document.createElement('span')
              pre.textContent = entry.rawValue.slice(0, marking.start)
              span.appendChild(pre)
            }
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'cr-secret-btn' + (marking.enabled ? '' : ' disabled')
            btn.textContent = marking.selectedText
            btn.title = marking.enabled ? 'Click to disable (keep value as-is)' : 'Click to re-enable as secret'
            span.appendChild(btn)
            if (marking.end < entry.rawValue.length) {
              const suf = document.createElement('span')
              suf.textContent = entry.rawValue.slice(marking.end)
              span.appendChild(suf)
            }
            if (marking.enabled) {
              const lbl = document.createElement('span')
              lbl.className = 'cr-var-label'
              lbl.textContent = '{' + marking.varName + '}'
              span.appendChild(lbl)
            }
          }

          function buildCredentialReviewPanel(fingerprint, serverName, sourceApp, action, analysis, callbacks) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) return

            const config = analysis.config
            const templatizedConfig = analysis.templatizedConfig
            const secretValues = analysis.secretValues || {}
            const entries = getConfigEntries(config)

            const markings = {}
            for (const entry of entries) {
              const tv = getTemplatizedValue(entry, templatizedConfig)
              const found = findSecretInValue(entry.rawValue, secretValues, tv)
              if (found) {
                markings[entry.entryId] = {
                  varName: found.varName,
                  selectedText: found.text,
                  start: found.start,
                  end: found.end,
                  enabled: true
                }
              }
            }

            const actionsEl = item.querySelector('.server-actions')
            const badgeEl = item.querySelector('.quarantine-badge')
            if (actionsEl) actionsEl.style.display = 'none'
            if (badgeEl) badgeEl.style.display = 'none'

            const panel = document.createElement('div')
            panel.className = 'credential-review'

            const enabledCount = Object.values(markings).filter(m => m.enabled).length
            const desc = document.createElement('div')
            desc.className = 'cr-description'
            desc.textContent = enabledCount > 0
              ? enabledCount + ' credential' + (enabledCount === 1 ? '' : 's') + ' detected. Review and adjust before submitting. These credentials will be encrypted.'
              : 'No credentials auto-detected. Select text in any value to mark it as a secret.'
            panel.appendChild(desc)

            if (entries.length > 0) {
              const hint = document.createElement('div')
              hint.className = 'cr-hint'
              hint.textContent = 'Select any part of a value to mark it as a credential. Only one credential per line.'
              panel.appendChild(hint)
            }

            const entriesDiv = document.createElement('div')
            entriesDiv.className = 'cr-entries'

            if (entries.length === 0) {
              const empty = document.createElement('div')
              empty.className = 'cr-empty'
              empty.textContent = 'No configurable values found for this server.'
              entriesDiv.appendChild(empty)
            } else {
              for (const entry of entries) {
                const row = document.createElement('div')
                row.className = 'cr-entry'

                const label = document.createElement('span')
                label.className = 'cr-label'
                label.textContent = entry.context === 'command' ? '$' : entry.key + (entry.context !== 'args' ? '=' : '')
                row.appendChild(label)

                const valueSpan = renderValueSpan(entry, markings[entry.entryId])
                row.appendChild(valueSpan)

                valueSpan.addEventListener('click', (e) => {
                  const secretBtn = e.target.closest('.cr-secret-btn')
                  if (!secretBtn) return
                  const m = markings[entry.entryId]
                  if (!m) return
                  m.enabled = !m.enabled
                  updateValueSpan(valueSpan, entry, m)
                  updateDescription()
                })

                if (entry.context !== 'command') {
                  valueSpan.addEventListener('mouseup', (e) => {
                    setTimeout(() => {
                      const sel = window.getSelection()
                      if (!sel || sel.isCollapsed || !sel.rangeCount) return
                      const text = sel.toString().trim()
                      if (!text || !entry.rawValue.includes(text)) return

                      const range = sel.getRangeAt(0)
                      const container = range.startContainer.parentElement?.closest('[data-value-container]')
                      if (!container) return
                      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
                      let charCount = 0, startOffset = -1, node
                      while ((node = walker.nextNode())) {
                        if (node === range.startContainer) { startOffset = charCount + range.startOffset; break }
                        charCount += (node.textContent || '').length
                      }
                      if (startOffset < 0) return
                      const endOffset = startOffset + text.length

                      dismissPopup()
                      const popup = document.createElement('div')
                      popup.className = 'cr-popup'
                      popup.style.left = e.clientX + 'px'
                      popup.style.top = (e.clientY + 8) + 'px'

                      const markBtn = document.createElement('button')
                      markBtn.type = 'button'
                      markBtn.className = 'cr-popup-mark'
                      markBtn.textContent = 'Mark as secret'
                      markBtn.addEventListener('click', () => {
                        const varName = generateTokenName(markings)
                        markings[entry.entryId] = { varName, selectedText: text, start: startOffset, end: endOffset, enabled: true }
                        updateValueSpan(valueSpan, entry, markings[entry.entryId])
                        updateDescription()
                        dismissPopup()
                      })
                      popup.appendChild(markBtn)

                      const closeBtn = document.createElement('button')
                      closeBtn.type = 'button'
                      closeBtn.className = 'cr-popup-close'
                      closeBtn.innerHTML = '<svg viewBox="0 0 10 10" width="12" height="12"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
                      closeBtn.addEventListener('click', () => dismissPopup())
                      popup.appendChild(closeBtn)

                      document.body.appendChild(popup)
                      activePopup = popup
                    }, 0)
                  })
                }

                entriesDiv.appendChild(row)
              }
            }
            panel.appendChild(entriesDiv)

            function updateDescription() {
              const count = Object.values(markings).filter(m => m.enabled).length
              desc.textContent = count > 0
                ? count + ' credential' + (count === 1 ? '' : 's') + ' detected. Review and adjust before submitting. These credentials will be encrypted.'
                : 'No credentials marked. Select text in any value to mark it as a secret.'
            }

            const actionsRow = document.createElement('div')
            actionsRow.className = 'cr-actions'

            const backBtn = document.createElement('button')
            backBtn.type = 'button'
            backBtn.className = 'button button-dismiss'
            backBtn.textContent = 'Back'
            backBtn.addEventListener('click', () => {
              dismissPopup()
              panel.remove()
              if (actionsEl) actionsEl.style.display = ''
              if (badgeEl) badgeEl.style.display = ''
              reenableButtons()
            })
            actionsRow.appendChild(backBtn)

            const confirmBtn = document.createElement('button')
            confirmBtn.type = 'button'
            confirmBtn.className = 'button button-request'
            confirmBtn.textContent = 'Confirm & Submit'
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true
              confirmBtn.style.opacity = '0.5'
              backBtn.disabled = true
              backBtn.style.opacity = '0.5'
              dismissPopup()

              const overrides = []
              for (const [entryId, m] of Object.entries(markings)) {
                if (m.enabled) {
                  overrides.push({ entryId, varName: m.varName, selectedText: m.selectedText, start: m.start, end: m.end })
                }
              }

              callbacks.onConfirm(fingerprint, serverName, sourceApp, action, overrides)
            })
            actionsRow.appendChild(confirmBtn)

            panel.appendChild(actionsRow)
            item.appendChild(panel)
          }
`;
let serverRegistrationWindow = null;
async function showServerRegistrationDialog(parentWindow, isAdminOrOwner = false) {
  if (serverRegistrationWindow && !serverRegistrationWindow.isDestroyed()) {
    serverRegistrationWindow.focus();
    return [];
  }
  const allServers = await discoverMcpServers();
  const servers = filterOutEdisonWatchServers(allServers);
  if (servers.length === 0) {
    const msgOpts = {
      type: "info",
      title: "Register MCP Servers",
      message: "No new MCP servers found. All discovered servers are either already managed by Edison Watch or no MCP servers were detected on this machine."
    };
    if (parentWindow && !parentWindow.isDestroyed()) {
      await electron.dialog.showMessageBox(parentWindow, msgOpts);
    } else {
      await electron.dialog.showMessageBox(msgOpts);
    }
    return [];
  }
  return new Promise((resolve) => {
    const results = [];
    const configMap = {};
    const serverEntries = servers.map((server) => {
      const fingerprint = getServerFingerprint(server);
      configMap[fingerprint] = { config: server.config, path: server.path };
      return { server, fingerprint };
    });
    const serversHtml = serverEntries.map(({ server, fingerprint }) => {
      const config = server.config;
      const clientName = getClientDisplayName(server.client);
      const clientIcon = getClientIcon(server.client);
      let serverInfo = "";
      if ("command" in config && config.command) {
        const args = config.args?.slice(0, 3).join(" ") ?? "";
        serverInfo = escapeHtml$1(
          `${config.command} ${args}${config.args && config.args.length > 3 ? "..." : ""}`
        );
      } else if ("url" in config && config.url) {
        serverInfo = escapeHtml$1(config.url);
      }
      const safeName = escapeHtml$1(server.name);
      const safeFingerprint = escapeHtml$1(fingerprint);
      const safeClient = escapeHtml$1(server.client);
      return `
          <div class="server-item" data-fingerprint="${safeFingerprint}" data-name="${safeName}" data-source="${safeClient}">
            <div class="server-header">
              <div class="server-name">
                <strong>${safeName}</strong>
              </div>
              <div class="server-source">
                <span class="client-icon">${clientIcon}</span>
                <span class="client-name">${clientName}</span>
              </div>
            </div>
            <div class="server-info">${serverInfo}</div>
            <div class="server-actions">
              <button class="button button-request" data-action="${isAdminOrOwner ? "registered" : "requested"}" title="${isAdminOrOwner ? "Add this server to Edison directly" : "Submit request for IT admin approval"}">${isAdminOrOwner ? "Add to Edison" : "Request Approval"}</button>
              <button class="button button-dismiss" data-action="skipped" title="Skip this server for now">Skip</button>
            </div>
          </div>
        `;
    }).join("");
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Register MCP Servers</title>
        <style>
          ${BASE_CSS}
          ${HEADER_CSS}
          ${SERVER_CARD_CSS}
          ${BUTTON_CSS}
          ${REGISTRATION_CSS}
          ${CREDENTIAL_REVIEW_CSS}
        </style>
      </head>
      <body data-configs="${escapeHtml$1(JSON.stringify(configMap))}">
        <div class="header">
          <h1>${isAdminOrOwner ? "Register" : "Request"} MCP Servers <span class="count">(${servers.length})</span></h1>
          <div class="header-actions">
            <button class="button button-bulk button-request-all" id="request-all">${isAdminOrOwner ? "Add All" : "Request All"}</button>
            <button class="button button-bulk button-dismiss-all" id="dismiss-all">Skip All</button>
          </div>
        </div>
        <div class="description">
          ${isAdminOrOwner ? "These MCP servers are installed on your machine. Add them to Edison to enable secure proxying." : "These MCP servers are installed on your machine. Request approval so your IT team can add them to Edison."}
        </div>
        <div id="servers">${serversHtml}</div>
        <script>
          const { ipcRenderer } = require('electron')
          const results = []
          const serverConfigs = JSON.parse(document.body.dataset.configs || '{}')
          let bulkOperationInProgress = false
          let activePopup = null

          function findItemByFingerprint(fingerprint) {
            const items = document.querySelectorAll('.server-item')
            for (const item of items) {
              if (item.dataset.fingerprint === fingerprint) return item
            }
            return null
          }

          function reenableButtons() {
            document.querySelectorAll('.server-item button').forEach(btn => {
              btn.disabled = false
              btn.style.opacity = '1'
            })
            const requestAll = document.getElementById('request-all')
            const dismissAll = document.getElementById('dismiss-all')
            if (requestAll) { requestAll.disabled = false; requestAll.style.opacity = '1' }
            if (dismissAll) { dismissAll.disabled = false; dismissAll.style.opacity = '1' }
          }

          function updateHeaderCount() {
            const remaining = document.querySelectorAll('.server-item').length
            const countSpan = document.querySelector('h1 .count')
            if (countSpan) {
              countSpan.textContent = '(' + remaining + ')'
            }
          }

          window.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); document.getElementById('request-all')?.click() } })

          function removeServerItem(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }

            item.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
            item.style.transform = 'translateX(-100%)'
            item.style.opacity = '0'
            item.style.maxHeight = item.offsetHeight + 'px'

            setTimeout(() => {
              item.style.maxHeight = '0'
              item.style.marginBottom = '0'
              item.style.paddingTop = '0'
              item.style.paddingBottom = '0'
              item.style.borderWidth = '0'
            }, 100)

            setTimeout(() => {
              try {
                item.remove()
                updateHeaderCount()
                const remaining = document.querySelectorAll('.server-item').length
                if (remaining === 0) {
                  ipcRenderer.invoke('mcp:registrationComplete', results)
                  window.close()
                } else if (!bulkOperationInProgress) {
                  reenableButtons()
                }
              } catch (err) {
                console.error('Error removing server item:', err)
                if (!bulkOperationInProgress) reenableButtons()
              }
            }, 400)
          }

          function showAlreadyPendingBadge(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            const actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (actionsEl) {
              actionsEl.style.display = ''
              actionsEl.innerHTML = '<div class="already-pending-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>Request already pending with IT admin</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/

          function showConflictRename(fingerprint, serverName, sourceApp, action, errorMessage) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) { if (!bulkOperationInProgress) reenableButtons(); return }
            // Remove credential review panel if present
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            let actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (!actionsEl) { actionsEl = document.createElement('div'); actionsEl.className = 'server-actions'; item.appendChild(actionsEl) }
            actionsEl.style.display = ''
            actionsEl.innerHTML = \`
              <div style="display:flex;flex-direction:column;gap:6px;width:100%">
                <div style="color:var(--danger, #e53e3e);font-size:11px;display:flex;align-items:center;gap:4px">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                  Conflict: \${errorMessage || 'A server with this name already exists'}
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <input type="text" class="rename-input" maxlength="32" placeholder="New name (a-z, 0-9, _)" style="flex:1;min-width:0;padding:4px 8px;border-radius:4px;border:1px solid var(--border, #333);background:var(--bg-input, #1a1a1a);color:var(--text-primary, #eee);font-size:11px;outline:none" />
                  <button class="button button-request rename-btn" disabled style="white-space:nowrap;padding:4px 10px;font-size:11px;opacity:0.4">Resubmit</button>
                </div>
                <div class="rename-error" style="font-size:10px;color:var(--danger, #e53e3e);display:none">Max 32 characters, letters, numbers and underscore only</div>
              </div>
            \`
            const input = actionsEl.querySelector('.rename-input')
            const btn = actionsEl.querySelector('.rename-btn')
            const errEl = actionsEl.querySelector('.rename-error')
            input.addEventListener('input', () => {
              input.value = input.value.replace(/[^a-zA-Z0-9_]/g, '')
              const valid = NAME_RE.test(input.value.trim())
              btn.disabled = !valid
              btn.style.opacity = valid ? '1' : '0.4'
              errEl.style.display = (input.value.length > 0 && !valid) ? 'block' : 'none'
            })
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && !btn.disabled) btn.click()
            })
            btn.addEventListener('click', async (e) => {
              e.stopPropagation()
              const newName = input.value.trim()
              if (!NAME_RE.test(newName)) return
              btn.disabled = true
              btn.textContent = 'Submitting...'
              try {
                const serverData = serverConfigs[fingerprint] || {}
                const result = await ipcRenderer.invoke('mcp:resubmitServer', {
                  originalName: serverName,
                  newName: newName,
                  config: serverData.config,
                  client: sourceApp,
                  configPath: serverData.path
                })
                if (result && result.success) {
                  results.push({ fingerprint, serverName: newName, sourceApp, action })
                  removeServerItem(fingerprint)
                } else {
                  showConflictRename(fingerprint, serverName, sourceApp, action, (result && result.error) || 'Failed')
                }
              } catch (err) {
                const msg = (err && err.message) ? err.message : 'Resubmit failed'
                showConflictRename(fingerprint, serverName, sourceApp, action, msg)
              }
            })
            if (!bulkOperationInProgress) reenableButtons()
          }

          ${CREDENTIAL_REVIEW_JS}

          function showCredentialReview(fingerprint, serverName, sourceApp, action, analysis) {
            buildCredentialReviewPanel(fingerprint, serverName, sourceApp, action, analysis, {
              onConfirm: async (fp, sn, sa, act, overrides) => {
                const serverData = serverConfigs[fp] || {}
                let result
                try {
                  result = await ipcRenderer.invoke('mcp:handleServerAction', {
                    fingerprint: fp, serverName: sn, sourceApp: sa, action: act,
                    config: serverData.config, configPath: serverData.path,
                    templateOverrides: overrides
                  })
                } catch (err) {
                  if (!bulkOperationInProgress) reenableButtons()
                  return
                }
                if (result && result.alreadyPending) { showConflictRename(fp, sn, sa, act, 'A server with this name already has a pending approval request'); return }
                if (result && result.alreadyExists) { showConflictRename(fp, sn, sa, act, result.errorMessage); return }
                results.push({ fingerprint: fp, serverName: sn, sourceApp: sa, action: act })
                removeServerItem(fp)
              }
            })
          }

          // ── Main action handler ────────────────────────────────────

          async function handleAction(fingerprint, serverName, sourceApp, action, skipReview) {
            const serverData = serverConfigs[fingerprint] || {}

            if ((action === 'registered' || action === 'requested') && !skipReview) {
              try {
                const analysis = await ipcRenderer.invoke('mcp:analyzeServerSecrets', {
                  serverName, sourceApp,
                  config: serverData.config,
                  configPath: serverData.path
                })
                showCredentialReview(fingerprint, serverName, sourceApp, action, analysis)
                return
              } catch (err) {
                console.error('Secret analysis failed, submitting directly:', err)
              }
            }

            if (action === 'requested' || action === 'registered') {
              let result
              try {
                result = await ipcRenderer.invoke('mcp:handleServerAction', {
                  fingerprint, serverName, sourceApp, action,
                  config: serverData.config, configPath: serverData.path
                })
              } catch (err) {
                if (!bulkOperationInProgress) reenableButtons()
                return
              }
              if (result && result.alreadyPending) {
                showConflictRename(fingerprint, serverName, sourceApp, action, 'A server with this name already has a pending approval request')
                return
              }
              if (result && result.alreadyExists) {
                showConflictRename(fingerprint, serverName, sourceApp, action, result.errorMessage)
                return
              }
            }
            results.push({ fingerprint, serverName, sourceApp, action })
            removeServerItem(fingerprint)
          }

          document.addEventListener('click', (e) => {
            const button = e.target.closest('button')
            if (!button || button.disabled) return
            if (button.closest('.credential-review') || button.closest('.cr-popup')) return

            document.querySelectorAll('button').forEach(btn => {
              btn.disabled = true
              btn.style.opacity = '0.5'
            })

            const action = button.dataset.action
            const item = button.closest('.server-item')
            if (!item || !action) {
              document.querySelectorAll('button').forEach(btn => {
                btn.disabled = false
                btn.style.opacity = '1'
              })
              return
            }
            const fingerprint = item.dataset.fingerprint
            const serverName = item.dataset.name
            const sourceApp = item.dataset.source
            handleAction(fingerprint, serverName, sourceApp, action, false)
          })

          document.getElementById('request-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('dismiss-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, '${isAdminOrOwner ? "registered" : "requested"}', true)
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          document.getElementById('dismiss-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('request-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, 'skipped', true)
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          window.addEventListener('beforeunload', () => {
            ipcRenderer.invoke('mcp:registrationComplete', results)
          })
        <\/script>
      </body>
      </html>
    `;
    serverRegistrationWindow = new electron.BrowserWindow({
      width: 500,
      height: Math.min(600, 200 + servers.length * 100),
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : void 0,
      modal: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    const completeHandler = (_event, actionResults) => {
      results.push(...actionResults);
    };
    try {
      electron.ipcMain.handle("mcp:registrationComplete", completeHandler);
    } catch {
      electron.ipcMain.removeHandler("mcp:registrationComplete");
      electron.ipcMain.handle("mcp:registrationComplete", completeHandler);
    }
    serverRegistrationWindow.on("closed", () => {
      electron.ipcMain.removeHandler("mcp:registrationComplete");
      serverRegistrationWindow = null;
      resolve(results);
    });
    serverRegistrationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    serverRegistrationWindow.once("ready-to-show", () => {
      serverRegistrationWindow?.show();
    });
  });
}
let serverActionWindow = null;
function showQuarantinedServersDialog(events2, parentWindow, isAdminOrOwner = false) {
  return new Promise((resolve) => {
    const results = [];
    if (events2.length === 0) {
      resolve([]);
      return;
    }
    if (serverActionWindow && !serverActionWindow.isDestroyed()) {
      serverActionWindow.focus();
      resolve([]);
      return;
    }
    serverActionWindow = new electron.BrowserWindow({
      width: 520,
      height: Math.min(700, 240 + events2.length * 130),
      show: false,
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : void 0,
      modal: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: false,
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    const configMap = {};
    events2.forEach((event) => {
      configMap[event.fingerprint] = {
        config: event.server.config,
        path: event.server.path,
        source: event.server.source
      };
    });
    const serversHtml = events2.map((event) => {
      const server = event.server;
      const config = server.config;
      const clientName = getClientDisplayName(server.client);
      const clientIcon = getClientIcon(server.client, event.fingerprint);
      let serverInfo = "";
      if ("command" in config && config.command) {
        const args = config.args?.slice(0, 3).join(" ") ?? "";
        serverInfo = escapeHtml$1(
          `${config.command} ${args}${config.args && config.args.length > 3 ? "..." : ""}`
        );
      } else if ("url" in config && config.url) {
        serverInfo = escapeHtml$1(config.url);
      }
      const safeName = escapeHtml$1(server.name);
      const safeFingerprint = escapeHtml$1(event.fingerprint);
      const safeClient = escapeHtml$1(server.client);
      return `
          <div class="server-item" data-fingerprint="${safeFingerprint}" data-name="${safeName}" data-source="${safeClient}">
            <div class="server-header">
              <div class="server-name">
                <strong>${safeName}</strong>
              </div>
              <div class="server-source">
                <span class="client-icon">${clientIcon}</span>
                <span class="client-name">${clientName}</span>
              </div>
            </div>
            <div class="server-info">${serverInfo}</div>
            <div class="quarantine-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 6h2v6h-2V8zm0 8h2v2h-2v-2z"/></svg>
              Needs Approval
            </div>
            <div class="server-actions">
              <button class="button button-request" data-action="${isAdminOrOwner ? "registered" : "requested"}" title="${isAdminOrOwner ? "Add this server to Edison directly" : "Submit request for IT admin approval"}">${isAdminOrOwner ? "Add to Edison" : "Request Approval"}</button>
              <button class="button button-dismiss" data-action="dismissed" title="Skip for now without requesting">Skip for Now</button>
            </div>
          </div>
        `;
    }).join("");
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>New AI Extensions Detected</title>
        <style>
          ${BASE_CSS}
          ${HEADER_CSS}
          ${SERVER_CARD_CSS}
          ${BUTTON_CSS}
          ${QUARANTINE_CSS}
          ${CREDENTIAL_REVIEW_CSS}
        </style>
      </head>
      <body data-configs="${escapeHtml$1(JSON.stringify(configMap))}">
        <div class="header">
          <h1>New AI Extensions Detected <span class="count">(${events2.length})</span></h1>
          <div class="header-actions">
            <button class="button button-bulk button-request-all" id="request-all">${isAdminOrOwner ? "Add All" : "Request All"}</button>
            <button class="button button-bulk button-dismiss-all" id="dismiss-all">Skip All</button>
          </div>
        </div>
        <div class="description">
          ${isAdminOrOwner ? `We noticed you've added new extensions to your AI tools. As an admin, you can add them to Edison directly. <span style="color: var(--danger)">If you choose <strong>Skip for Now</strong> or <strong>Skip All</strong>, these extensions will be removed from your AI tool, since auto-quarantine is enabled.</span>` : `We noticed you've added new extensions to your AI tools. Your IT team needs to approve them before they can be used through Edison Watch. <span style="color: var(--danger)">If you choose <strong>Skip for Now</strong> or <strong>Skip All</strong>, these extensions will be removed from your AI tool, since your admin has enabled auto-quarantine.</span> Would you like to request approval?`}
        </div>
        <div id="servers">${serversHtml}</div>
        <script>
          const { ipcRenderer } = require('electron')
          const results = []
          const serverConfigs = JSON.parse(document.body.dataset.configs || '{}')
          let bulkOperationInProgress = false
          let activePopup = null // track the floating "Mark as secret" popup

          function findItemByFingerprint(fingerprint) {
            const items = document.querySelectorAll('.server-item')
            for (const item of items) {
              if (item.dataset.fingerprint === fingerprint) return item
            }
            return null
          }

          function reenableButtons() {
            document.querySelectorAll('.server-item button').forEach(btn => {
              btn.disabled = false
              btn.style.opacity = '1'
            })
            const requestAll = document.getElementById('request-all')
            const dismissAll = document.getElementById('dismiss-all')
            if (requestAll) { requestAll.disabled = false; requestAll.style.opacity = '1' }
            if (dismissAll) { dismissAll.disabled = false; dismissAll.style.opacity = '1' }
          }

          function updateHeaderCount() {
            const remaining = document.querySelectorAll('.server-item').length
            const countSpan = document.querySelector('h1 .count')
            if (countSpan) {
              countSpan.textContent = '(' + remaining + ')'
            }
          }

          window.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); document.getElementById('request-all')?.click() } })

          function removeServerItem(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }

            item.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)'
            item.style.transform = 'translateX(-100%)'
            item.style.opacity = '0'
            item.style.maxHeight = item.offsetHeight + 'px'

            setTimeout(() => {
              item.style.maxHeight = '0'
              item.style.marginBottom = '0'
              item.style.paddingTop = '0'
              item.style.paddingBottom = '0'
              item.style.borderWidth = '0'
            }, 100)

            setTimeout(() => {
              try {
                item.remove()
                updateHeaderCount()
                const remaining = document.querySelectorAll('.server-item').length
                if (remaining === 0) {
                  ipcRenderer.invoke('mcp:serverActionComplete', results)
                  window.close()
                } else if (!bulkOperationInProgress) {
                  reenableButtons()
                }
              } catch (err) {
                console.error('Error removing server item:', err)
                if (!bulkOperationInProgress) reenableButtons()
              }
            }, 400)
          }

          function showAlreadyPendingBadge(fingerprint) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            const actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (actionsEl) {
              actionsEl.style.display = ''
              actionsEl.innerHTML = '<div class="already-pending-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>Request already pending with IT admin</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/

          function showConflictRename(fingerprint, serverName, sourceApp, action, errorMessage) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) { if (!bulkOperationInProgress) reenableButtons(); return }
            // Remove credential review panel if present
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            // Find or create the actions container, ensure it's visible
            let actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (!actionsEl) {
              actionsEl = document.createElement('div')
              actionsEl.className = 'server-actions'
              item.appendChild(actionsEl)
            }
            actionsEl.style.display = ''
            actionsEl.innerHTML = \`
              <div style="display:flex;flex-direction:column;gap:6px;width:100%">
                <div style="color:var(--danger, #e53e3e);font-size:11px;display:flex;align-items:center;gap:4px">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                  Conflict: \${errorMessage || 'A server with this name already exists'}
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                  <input type="text" class="rename-input" maxlength="32" placeholder="New name (a-z, 0-9, _)" style="flex:1;min-width:0;padding:4px 8px;border-radius:4px;border:1px solid var(--border, #333);background:var(--bg-input, #1a1a1a);color:var(--text-primary, #eee);font-size:11px;outline:none" />
                  <button class="button button-request rename-btn" disabled style="white-space:nowrap;padding:4px 10px;font-size:11px;opacity:0.4">Resubmit</button>
                </div>
                <div class="rename-error" style="font-size:10px;color:var(--danger, #e53e3e);display:none">Max 32 characters, letters, numbers and underscore only</div>
              </div>
            \`
            const input = actionsEl.querySelector('.rename-input')
            const btn = actionsEl.querySelector('.rename-btn')
            const errEl = actionsEl.querySelector('.rename-error')
            input.addEventListener('input', () => {
              input.value = input.value.replace(/[^a-zA-Z0-9_]/g, '')
              const valid = NAME_RE.test(input.value.trim())
              btn.disabled = !valid
              btn.style.opacity = valid ? '1' : '0.4'
              errEl.style.display = (input.value.length > 0 && !valid) ? 'block' : 'none'
            })
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && !btn.disabled) btn.click()
            })
            btn.addEventListener('click', async (e) => {
              e.stopPropagation() // prevent global click handler from interfering
              const newName = input.value.trim()
              if (!NAME_RE.test(newName)) return
              btn.disabled = true
              btn.textContent = 'Submitting...'
              try {
                const serverData = serverConfigs[fingerprint] || {}
                console.log('[Quarantine] Resubmitting', serverName, 'as', newName)
                const result = await ipcRenderer.invoke('mcp:resubmitServer', {
                  originalName: serverName,
                  newName: newName,
                  config: serverData.config,
                  client: sourceApp,
                  configPath: serverData.path,
                  source: serverData.source
                })
                console.log('[Quarantine] Resubmit result:', JSON.stringify(result))
                if (result && result.success) {
                  results.push({ fingerprint, serverName: newName, sourceApp, action })
                  removeServerItem(fingerprint)
                } else {
                  showConflictRename(fingerprint, serverName, sourceApp, action, (result && result.error) || 'Failed')
                }
              } catch (err) {
                console.error('[Quarantine] Resubmit error:', err)
                const msg = (err && err.message) ? err.message : 'Resubmit failed'
                showConflictRename(fingerprint, serverName, sourceApp, action, msg)
              }
            })
            if (!bulkOperationInProgress) reenableButtons()
          }

          function showStatusBadge(fingerprint, message, isError) {
            const item = findItemByFingerprint(fingerprint)
            if (!item) {
              if (!bulkOperationInProgress) reenableButtons()
              return
            }
            // Remove credential review panel if present
            const crPanel = item.querySelector('.credential-review')
            if (crPanel) crPanel.remove()
            let actionsEl = item.querySelector('.server-actions') || item.querySelector('.cr-actions')
            if (!actionsEl) { actionsEl = document.createElement('div'); actionsEl.className = 'server-actions'; item.appendChild(actionsEl) }
            actionsEl.style.display = ''
            if (actionsEl) {
              const color = isError ? 'var(--danger, #e53e3e)' : 'var(--text-muted, #888)'
              const icon = isError
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>'
              actionsEl.innerHTML = '<div class="already-pending-badge" style="color:' + color + '">' + icon + message + '</div>'
            }
            if (!bulkOperationInProgress) reenableButtons()
            setTimeout(() => removeServerItem(fingerprint), 2500)
          }

          ${CREDENTIAL_REVIEW_JS}

          function showCredentialReview(fingerprint, serverName, sourceApp, action, analysis) {
            buildCredentialReviewPanel(fingerprint, serverName, sourceApp, action, analysis, {
              onConfirm: async (fp, sn, sa, act, overrides) => {
                const serverData = serverConfigs[fp] || {}
                let result
                try {
                  result = await ipcRenderer.invoke('mcp:handleServerAction', {
                    fingerprint: fp, serverName: sn, sourceApp: sa, action: act,
                    config: serverData.config,
                    configPath: serverData.path,
                    source: serverData.source,
                    templateOverrides: overrides
                  })
                } catch (err) {
                  const msg = (err && err.message) ? err.message : 'Something went wrong'
                  showStatusBadge(fp, msg, true)
                  return
                }
                if (result && result.alreadyPending) { showConflictRename(fp, sn, sa, act, 'A server with this name already has a pending approval request'); return }
                if (result && result.alreadyExists) { showConflictRename(fp, sn, sa, act, result.errorMessage); return }
                results.push({ fingerprint: fp, serverName: sn, sourceApp: sa, action: act })
                if (result && result.approveError) { showStatusBadge(fp, 'Request submitted - auto-approval failed', true); return }
                removeServerItem(fp)
              }
            })
          }

          // ── Main action handler ────────────────────────────────────

          async function handleAction(fingerprint, serverName, sourceApp, action, skipReview) {
            const serverData = serverConfigs[fingerprint] || {}

            // For register/request actions, show credential review first (unless bulk)
            if ((action === 'registered' || action === 'requested') && !skipReview) {
              try {
                const analysis = await ipcRenderer.invoke('mcp:analyzeServerSecrets', {
                  serverName,
                  sourceApp,
                  config: serverData.config,
                  configPath: serverData.path
                })
                showCredentialReview(fingerprint, serverName, sourceApp, action, analysis)
                return // wait for user to confirm from the review panel
              } catch (err) {
                console.error('Secret analysis failed, submitting directly:', err)
                // Fall through to direct submit
              }
            }

            let result
            try {
              result = await ipcRenderer.invoke('mcp:handleServerAction', {
                fingerprint, serverName, sourceApp, action,
                config: serverData.config,
                configPath: serverData.path,
                source: serverData.source
              })
            } catch (err) {
              const msg = (err && err.message) ? err.message : 'Something went wrong'
              showStatusBadge(fingerprint, msg, true)
              return
            }
            if (result && result.alreadyPending) { showConflictRename(fingerprint, serverName, sourceApp, action, 'A server with this name already has a pending approval request'); return }
            if (result && result.alreadyExists) { showConflictRename(fingerprint, serverName, sourceApp, action, result.errorMessage); return }
            results.push({ fingerprint, serverName, sourceApp, action })
            if (result && result.approveError) { showStatusBadge(fingerprint, 'Request submitted - auto-approval failed', true); return }
            removeServerItem(fingerprint)
          }

          document.addEventListener('click', (e) => {
            const button = e.target.closest('button')
            if (!button || button.disabled) return
            // Ignore clicks on credential review internal buttons
            if (button.closest('.credential-review') || button.closest('.cr-popup')) return

            document.querySelectorAll('button').forEach(btn => {
              btn.disabled = true
              btn.style.opacity = '0.5'
            })

            const action = button.dataset.action
            const item = button.closest('.server-item')
            if (!item || !action) {
              document.querySelectorAll('button').forEach(btn => {
                btn.disabled = false
                btn.style.opacity = '1'
              })
              return
            }
            const fingerprint = item.dataset.fingerprint
            const serverName = item.dataset.name
            const sourceApp = item.dataset.source
            handleAction(fingerprint, serverName, sourceApp, action, false)
          })

          document.getElementById('request-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('dismiss-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, '${isAdminOrOwner ? "registered" : "requested"}', true)
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          document.getElementById('dismiss-all').addEventListener('click', async function () {
            if (this.disabled) return
            this.disabled = true
            document.getElementById('request-all').disabled = true
            bulkOperationInProgress = true
            try {
              const items = Array.from(document.querySelectorAll('.server-item'))
              for (let i = 0; i < items.length; i += 3) {
                const batch = items.slice(i, i + 3)
                await Promise.all(batch.map(item => {
                  const fingerprint = item.dataset.fingerprint
                  const serverName = item.dataset.name
                  const sourceApp = item.dataset.source
                  return handleAction(fingerprint, serverName, sourceApp, 'dismissed', true)
                }))
                if (i + 3 < items.length) await new Promise(r => setTimeout(r, 300))
              }
            } finally {
              bulkOperationInProgress = false
              if (document.querySelectorAll('.server-item').length > 0) reenableButtons()
            }
          })

          // Handle window close
          window.addEventListener('beforeunload', () => {
            ipcRenderer.invoke('mcp:serverActionComplete', results)
          })
        <\/script>
      </body>
      </html>
    `;
    const completeHandler = (_event, actionResults) => {
      results.push(...actionResults);
    };
    electron.ipcMain.handle("mcp:serverActionComplete", completeHandler);
    serverActionWindow.on("closed", () => {
      electron.ipcMain.removeHandler("mcp:serverActionComplete");
      serverActionWindow = null;
      resolve(results);
    });
    serverActionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    serverActionWindow.once("ready-to-show", () => {
      serverActionWindow?.show();
    });
  });
}
let updateKeysWindow = null;
function buildUpdateKeysHtml(currentSecretKey, canRoll) {
  const hasPersonalKey = currentSecretKey.includes("user:");
  const hasOrgKey = currentSecretKey.includes(".admin:");
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Update Keys</title>
      <style>
        ${BASE_CSS}

        h1 {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 6px;
        }

        .subtitle {
          font-size: 13px;
          color: var(--muted);
          margin-bottom: 20px;
          line-height: 1.5;
        }

        .field {
          margin-bottom: 14px;
        }

        label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .label-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 6px;
        }

        .label-row label { margin-bottom: 0; }

        .generate-link {
          font-size: 11px;
          color: var(--accent);
          cursor: pointer;
          background: none;
          border: none;
          padding: 0;
          font-family: inherit;
          text-decoration: underline;
        }

        .generate-link:hover { opacity: 0.8; }

        input[type="password"], input[type="text"] {
          width: 100%;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--text);
          font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
          font-size: 12px;
          padding: 9px 12px;
          outline: none;
          transition: border-color 0.15s ease;
        }

        input:focus { border-color: var(--accent); }

        .hint {
          font-size: 11px;
          color: var(--muted);
          margin-top: 4px;
          opacity: 0.7;
        }

        .actions {
          display: flex;
          gap: 8px;
          margin-top: 20px;
          justify-content: flex-end;
        }

        button {
          border: 1px solid var(--border);
          background: var(--graphene-grey-800);
          color: var(--text);
          padding: 8px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          font-family: 'Archivo', sans-serif;
          transition: all 0.15s ease;
        }

        button:hover { filter: brightness(1.15); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        #save-btn {
          background: var(--core-cyan-600);
          color: var(--baseline-black);
          border-color: var(--core-cyan-600);
          font-weight: 600;
          transition: all 0.15s ease, box-shadow 0.2s ease;
        }

        #save-btn:hover { filter: brightness(1.1); }

        #save-btn.has-changes {
          box-shadow: 0 0 0 3px rgba(0, 220, 200, 0.35);
          animation: pulse-glow 1.8s ease-in-out infinite;
        }

        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 0 3px rgba(0, 220, 200, 0.35); }
          50%       { box-shadow: 0 0 0 6px rgba(0, 220, 200, 0.10); }
        }

        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.3px;
          padding: 2px 7px;
          border-radius: 99px;
        }

        .status-badge.stored {
          background: rgba(0, 220, 130, 0.12);
          color: var(--circuit-green-500, #00dc82);
          border: 1px solid rgba(0, 220, 130, 0.25);
        }

        .status-badge.not-stored {
          background: rgba(255, 160, 60, 0.10);
          color: var(--graphene-grey-300, #aaa);
          border: 1px solid rgba(180, 180, 180, 0.18);
        }

        .copy-composite-btn {
          width: 100%;
          background: var(--graphene-grey-800);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 8px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
          font-family: 'Archivo', sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s ease;
          margin-bottom: 14px;
        }

        .copy-composite-btn:hover { filter: brightness(1.15); }

        .error {
          font-size: 12px;
          color: var(--infra-red-400);
          margin-top: 12px;
          display: none;
        }

        .success {
          text-align: center;
          padding: 32px 20px;
          display: none;
        }

        .success .check {
          font-size: 32px;
          color: var(--circuit-green-500);
          margin-bottom: 12px;
        }

        .success p {
          font-size: 14px;
          color: var(--muted);
        }
      </style>
    </head>
    <body>
      <div id="form-view">
        <h1>Update Encryption Keys</h1>
        <p class="subtitle">Update your personal or organisation key. MCP configs will be refreshed automatically.</p>

        ${currentSecretKey ? `
        <button class="copy-composite-btn" id="copy-current-btn" type="button">
          <span>⎘</span> Copy Composite Key
        </button>
        ` : ""}

        <div class="field">
          <div class="label-row">
            <label for="personal-key">Personal Key</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="status-badge ${hasPersonalKey ? "stored" : "not-stored"}">${hasPersonalKey ? "● Stored" : "○ Not stored"}</span>
              <button class="generate-link" id="generate-btn" type="button">Generate new</button>
            </div>
          </div>
          <input type="password" id="personal-key" placeholder="Your personal encryption key" autocomplete="off" />
          <div class="hint">Leave blank to keep your existing personal key.</div>
        </div>

        <div class="field">
          <div class="label-row">
            <label for="org-key">Organisation Key ${hasOrgKey ? "" : "(optional)"}</label>
            <span class="status-badge ${hasOrgKey ? "stored" : "not-stored"}">${hasOrgKey ? "● Stored" : "○ Not stored"}</span>
          </div>
          <input type="password" id="org-key" placeholder="${hasOrgKey ? "Replace existing organisation key" : "Organisation key (provided by admin)"}" autocomplete="off" />
          <div class="hint">Leave blank to keep your existing organisation key.</div>
        </div>

        <div class="error" id="error-msg"></div>

        <div id="overwrite-warning" style="display:none;margin-top:12px;padding:10px 12px;border-radius:6px;background:rgba(255,160,60,0.10);border:1px solid rgba(255,160,60,0.30);font-size:12px;color:#e8a030;line-height:1.5;">
          <strong>Re-encrypt stored credentials?</strong><br>
          Your existing encrypted credentials will be re-encrypted with the new key. This is safe as long as you save the new key now.
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="overwrite-cancel-btn" style="flex:1;">Go back</button>
            <button id="overwrite-confirm-btn" style="flex:1;background:#e8a030;color:#1a1a1a;border-color:#e8a030;font-weight:600;">Yes, re-encrypt</button>
          </div>
        </div>

        <div id="fresh-key-warning" style="display:none;margin-top:12px;padding:10px 12px;border-radius:6px;background:rgba(255,160,60,0.10);border:1px solid rgba(255,160,60,0.30);font-size:12px;color:#e8a030;line-height:1.5;">
          <strong>Delete &amp; overwrite existing encrypted data?</strong><br>
          Any previously encrypted credentials stored on the server will be deleted. This cannot be undone.
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="fresh-cancel-btn" style="flex:1;">Go back</button>
            <button id="fresh-confirm-btn" style="flex:1;background:#e8a030;color:#1a1a1a;border-color:#e8a030;font-weight:600;">Yes, delete &amp; overwrite</button>
          </div>
        </div>

        <div class="actions" id="actions-row">
          <button id="cancel-btn">Cancel</button>
          <button id="save-btn">Save &amp; Apply</button>
        </div>
      </div>

      <div class="success" id="success-view">
        <div class="check">✓</div>
        <p>Keys updated and MCP configs refreshed.</p>
      </div>

      <script>
        const { ipcRenderer } = require('electron')

        const CURRENT_SECRET_KEY = ${JSON.stringify(currentSecretKey)}
        const CAN_ROLL = ${canRoll}

        function parseCompositeKey(key) {
          let userPart = null
          let domainPart = null
          if (!key) return { userPart: null, domainPart: null }
          for (const segment of key.split('.')) {
            if (segment.startsWith('user:')) userPart = segment.slice(5)
            else if (segment.startsWith('admin:')) domainPart = segment.slice(6)
          }
          return { userPart, domainPart }
        }

        function buildCompositeKey(userPart, domainPart) {
          const parts = ['user:' + userPart]
          if (domainPart) parts.push('admin:' + domainPart)
          return parts.join('.')
        }

        function generateKey() {
          const bytes = new Uint8Array(32)
          crypto.getRandomValues(bytes)
          return btoa(String.fromCharCode(...bytes))
        }

        const copyCurrentBtn = document.getElementById('copy-current-btn')
        if (copyCurrentBtn) {
          copyCurrentBtn.addEventListener('click', () => {
            require('electron').clipboard.writeText(CURRENT_SECRET_KEY)
            const orig = copyCurrentBtn.innerHTML
            copyCurrentBtn.innerHTML = '<span>✓</span> Copied!'
            setTimeout(() => { copyCurrentBtn.innerHTML = orig }, 2000)
          })
        }

        function updateSaveBtnState() {
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const orgKeyInput = document.getElementById('org-key').value.trim()
          const hasChanges = !!(personalKeyInput || orgKeyInput)
          document.getElementById('save-btn').classList.toggle('has-changes', hasChanges)
        }

        document.getElementById('personal-key').addEventListener('input', updateSaveBtnState)
        document.getElementById('org-key').addEventListener('input', updateSaveBtnState)

        document.getElementById('generate-btn').addEventListener('click', () => {
          const input = document.getElementById('personal-key')
          input.type = 'text'
          input.value = generateKey()
          setTimeout(() => { input.type = 'password' }, 3000)
          updateSaveBtnState()
        })

        document.getElementById('cancel-btn').addEventListener('click', () => window.close())

        const overwriteWarning = document.getElementById('overwrite-warning')
        const freshKeyWarning = document.getElementById('fresh-key-warning')
        const actionsRow = document.getElementById('actions-row')
        const errorEl = document.getElementById('error-msg')

        function hideWarnings() {
          overwriteWarning.style.display = 'none'
          freshKeyWarning.style.display = 'none'
          actionsRow.style.display = 'flex'
        }

        document.getElementById('overwrite-cancel-btn').addEventListener('click', hideWarnings)
        document.getElementById('fresh-cancel-btn').addEventListener('click', hideWarnings)

        async function doSave() {
          const saveBtn = document.getElementById('save-btn')
          const cancelBtn = document.getElementById('cancel-btn')
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const orgKeyInput = document.getElementById('org-key').value.trim()

          overwriteWarning.style.display = 'none'
          actionsRow.style.display = 'flex'
          errorEl.style.display = 'none'

          saveBtn.disabled = true
          cancelBtn.disabled = true
          saveBtn.textContent = 'Saving...'

          const existing = parseCompositeKey(CURRENT_SECRET_KEY)

          try {
            const newUserPart = personalKeyInput || null
            const newDomainPart = orgKeyInput || null

            const finalUserPart = newUserPart ?? existing.userPart
            const finalDomainPart = newDomainPart ?? existing.domainPart

            const compositeKey = buildCompositeKey(finalUserPart, finalDomainPart)
            const isOverwrite = !!(newUserPart && existing.userPart)

            await ipcRenderer.invoke('update-keys:save', {
              compositeKey,
              isOverwrite,
              newUserPart: isOverwrite ? newUserPart : undefined,
            })

            document.getElementById('form-view').style.display = 'none'
            document.getElementById('success-view').style.display = 'block'
            setTimeout(() => window.close(), 1500)
          } catch (err) {
            errorEl.textContent = err.message || 'Failed to update keys.'
            errorEl.style.display = 'block'
            saveBtn.disabled = false
            cancelBtn.disabled = false
            saveBtn.textContent = 'Save & Apply'
          }
        }

        document.getElementById('overwrite-confirm-btn').addEventListener('click', doSave)
        document.getElementById('fresh-confirm-btn').addEventListener('click', doSave)

        document.getElementById('save-btn').addEventListener('click', function () {
          const personalKeyInput = document.getElementById('personal-key').value.trim()
          const existing = parseCompositeKey(CURRENT_SECRET_KEY)
          errorEl.style.display = 'none'

          // Must have at least one of: new personal key, or an existing one
          if (!personalKeyInput && !existing.userPart) {
            errorEl.textContent = 'Please enter your personal key.'
            errorEl.style.display = 'block'
            return
          }

          // Overwriting an existing personal key
          if (personalKeyInput && existing.userPart) {
            actionsRow.style.display = 'none'
            if (CAN_ROLL) {
              overwriteWarning.style.display = 'block'
            } else {
              freshKeyWarning.style.display = 'block'
            }
            return
          }

          // Setting a personal key for the first time - warn that server data may be cleared
          if (personalKeyInput && !existing.userPart) {
            actionsRow.style.display = 'none'
            freshKeyWarning.style.display = 'block'
            return
          }

          doSave()
        })
      <\/script>
    </body>
    </html>
  `;
}
function showUpdateKeysWindow(getSetupData2, saveEdisonSecretKey, runApplyAppIntegrations) {
  if (updateKeysWindow && !updateKeysWindow.isDestroyed()) {
    updateKeysWindow.focus();
    return;
  }
  const setupData = getSetupData2();
  const currentSecretKey = setupData.edisonSecretKey ?? "";
  const canRoll = !!(currentSecretKey && setupData.apiBaseUrl && setupData.apiKey);
  updateKeysWindow = new electron.BrowserWindow({
    width: 420,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    title: "Update Keys",
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const saveHandler = async (_event, { compositeKey, isOverwrite, newUserPart }) => {
    const setup = getSetupData2();
    const oldCompositeKey = setup.edisonSecretKey;
    saveEdisonSecretKey(compositeKey);
    await runApplyAppIntegrations(compositeKey);
    if (isOverwrite && newUserPart && oldCompositeKey && setup.apiBaseUrl && setup.apiKey) {
      const newUserPartHash = crypto.createHash("sha256").update(newUserPart).digest("hex");
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${setup.apiKey}`
      };
      try {
        const rollRes = await fetch(`${setup.apiBaseUrl}/api/v1/user/secret-key/roll`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            old_key: oldCompositeKey,
            new_user_part: newUserPart,
            new_user_part_hash: newUserPartHash
          })
        });
        if (!rollRes.ok) {
          await fetch(`${setup.apiBaseUrl}/api/v1/user/secret-key/reset`, {
            method: "POST",
            headers,
            body: JSON.stringify({ new_key_hash: newUserPartHash, confirm: true })
          }).catch(() => {
          });
        }
      } catch {
      }
    }
  };
  try {
    electron.ipcMain.handle("update-keys:save", saveHandler);
  } catch {
    electron.ipcMain.removeHandler("update-keys:save");
    electron.ipcMain.handle("update-keys:save", saveHandler);
  }
  updateKeysWindow.on("closed", () => {
    electron.ipcMain.removeHandler("update-keys:save");
    updateKeysWindow = null;
  });
  const html = buildUpdateKeysHtml(currentSecretKey, canRoll);
  updateKeysWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  updateKeysWindow.once("ready-to-show", () => updateKeysWindow?.show());
}
const EMPTY_INDEX = {
  byFingerprint: /* @__PURE__ */ new Map(),
  byName: /* @__PURE__ */ new Map()
};
async function fetchBackendFingerprints(apiBaseUrl, apiKey) {
  const url2 = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/servers/fingerprints`;
  try {
    const response = await fetch(url2, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      console.warn(`[preflight] GET ${url2} → ${response.status}; preflight disabled (will fall through to 409 path)`);
      return EMPTY_INDEX;
    }
    const data = await response.json();
    const list = data.fingerprints ?? [];
    const byFingerprint = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    for (const entry of list) {
      byFingerprint.set(entry.fingerprint, entry);
      byName.set(entry.name, entry);
    }
    console.log(`[preflight] backend has ${list.length} fingerprint(s):`);
    for (const entry of list) {
      console.log(`[preflight]   ${entry.name} → ${entry.fingerprint} (${entry.status})`);
    }
    return { byFingerprint, byName };
  } catch (err) {
    console.warn(`[preflight] GET ${url2} failed:`, err);
    return EMPTY_INDEX;
  }
}
function findBackendFingerprintMatch(server, index) {
  if (index.byFingerprint.size === 0) return null;
  const fp = getServerFingerprint(server);
  const match = index.byFingerprint.get(fp) ?? null;
  if (match) {
    console.log(`[preflight]   ✓ ${server.name} fp=${fp} matches backend "${match.name}" (${match.status})`);
  } else {
    const sameName = index.byName.get(server.name);
    if (sameName) {
      console.log(`[preflight]   ✗ ${server.name} fp=${fp} differs from backend "${sameName.name}" fp=${sameName.fingerprint} (same name, different config → 409 will drive rename)`);
    } else {
      console.log(`[preflight]   - ${server.name} fp=${fp} not on backend; will submit fresh`);
    }
  }
  return match;
}
async function submitServerRequest(server, apiBaseUrl, apiKey, userId) {
  const serverConfig = server.config;
  const hasCommand = "command" in serverConfig && !!serverConfig.command;
  const hasUrl = "url" in serverConfig && !!serverConfig.url;
  if (!hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server config has neither 'command' (for stdio servers) nor 'url' (for HTTP/SSE servers). The config may be malformed.`
    );
  }
  const typeVal = serverConfig.type;
  if (typeVal === "stdio" && !hasCommand) {
    throw new Error(
      `Cannot request server "${server.name}": stdio server must have a 'command' field.`
    );
  }
  if (!("type" in serverConfig) && !hasCommand && !hasUrl) {
    throw new Error(
      `Cannot request server "${server.name}": server appears to be stdio type but has no 'command' field.`
    );
  }
  const { config: templatizedConfig, templateFields, secretValues } = detectSecrets(server);
  const payload = {
    name: server.name,
    source_app: server.client,
    source_path: server.path,
    justification: `Detected in ${server.client} configuration`,
    user_id: userId
  };
  if (hasCommand) {
    payload.command = templatizedConfig.command;
    payload.args = templatizedConfig.args;
    const tEnv = templatizedConfig.env;
    if (tEnv && Object.keys(tEnv).length > 0) {
      payload.env = tEnv;
    }
  } else if (hasUrl) {
    payload.url = templatizedConfig.url;
    payload.type = templatizedConfig.type;
    const tHeaders = templatizedConfig.headers;
    if (tHeaders && Object.keys(tHeaders).length > 0) {
      payload.headers = tHeaders;
    }
  }
  if (templateFields.args && Object.keys(templateFields.args).length > 0 || templateFields.env && Object.keys(templateFields.env).length > 0) {
    payload.template_fields = templateFields;
  }
  return _postServerRequest(payload, server.name, secretValues, apiBaseUrl, apiKey);
}
async function submitServerWithOverrides(server, overrides, apiBaseUrl, apiKey, userId) {
  const serverConfig = server.config;
  const hasCommand = "command" in serverConfig && !!serverConfig.command;
  const hasUrl = "url" in serverConfig && !!serverConfig.url;
  if (!hasCommand && !hasUrl) {
    throw new Error(`Cannot request server "${server.name}": no command or url.`);
  }
  const secretValues = {};
  const templateFields = {};
  const cloned = JSON.parse(JSON.stringify(serverConfig));
  for (const ov of overrides) {
    const [context, key] = ov.entryId.split(":", 2);
    if (context === void 0 || key === void 0) continue;
    secretValues[ov.varName] = ov.selectedText;
    const bucket = context === "args" ? "args" : "env";
    const bucketFields = templateFields[bucket] ??= {};
    bucketFields[ov.varName] = {
      description: `User-selected credential (${ov.varName})`,
      example: ""
    };
    const replaceInValue = (raw) => raw.slice(0, ov.start) + `{${ov.varName}}` + raw.slice(ov.end);
    if (context === "args") {
      const idx = parseInt(key.match(/\d+/)?.[0] ?? "0", 10);
      const args = cloned.args;
      const current = args?.[idx];
      if (args && current !== void 0) {
        args[idx] = replaceInValue(current);
      }
    } else if (context === "env") {
      const env = cloned.env;
      const current = env?.[key];
      if (env && current !== void 0) {
        env[key] = replaceInValue(current);
      }
    } else if (context === "url") {
      cloned.url = replaceInValue(String(cloned.url));
    } else if (context === "headers") {
      const headers = cloned.headers;
      const current = headers?.[key];
      if (headers && current !== void 0) {
        headers[key] = replaceInValue(current);
      }
    }
  }
  const payload = {
    name: server.name,
    source_app: server.client,
    source_path: server.path,
    justification: `Detected in ${server.client} configuration`,
    user_id: userId
  };
  if (hasCommand) {
    payload.command = cloned.command;
    payload.args = cloned.args;
    const env = cloned.env;
    if (env && Object.keys(env).length > 0) payload.env = env;
  } else if (hasUrl) {
    payload.url = cloned.url;
    payload.type = cloned.type;
    const headers = cloned.headers;
    if (headers && Object.keys(headers).length > 0) payload.headers = headers;
  }
  if (Object.values(templateFields).some((v) => Object.keys(v).length > 0)) {
    payload.template_fields = templateFields;
  }
  return _postServerRequest(payload, server.name, secretValues, apiBaseUrl, apiKey);
}
async function _postServerRequest(payload, serverName, secretValues, apiBaseUrl, apiKey) {
  const requestUrl = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/mcp-requests`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 409) {
      let detail = errorText;
      try {
        detail = JSON.parse(errorText)?.detail ?? errorText;
      } catch {
      }
      if (detail.includes("already have a pending request")) return { request_id: 0, alreadyPending: true };
      return { request_id: 0, alreadyExists: true, errorMessage: detail };
    }
    throw new Error(`Failed to submit server request: ${response.status} ${errorText}`);
  }
  const responseData = await response.json();
  const hasSecrets = Object.keys(secretValues).length > 0;
  const autoApproved = responseData.auto_approved === true;
  console.log(
    `[MCP Config] Submitted server request for "${serverName}" (id: ${responseData.request_id}${autoApproved ? ", auto-approved" : ""})` + (hasSecrets ? ` with ${Object.keys(secretValues).length} template_fields` : "")
  );
  return {
    request_id: responseData.request_id,
    ...hasSecrets && { secretValues },
    ...autoApproved && { autoApproved: true }
  };
}
async function approveServerRequest(requestId, apiBaseUrl, apiKey) {
  const approveUrl = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/admin/mcp-requests/${requestId}/approve`;
  const response = await fetch(approveUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ reviewer_notes: "" })
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to approve server request: ${response.status} ${errorText}`);
  }
  console.log(`[MCP Config] Auto-approved server request ${requestId}`);
}
async function fetchUserRole(apiBaseUrl, apiKey) {
  try {
    const url2 = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/profile`;
    const response = await fetch(url2, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.role ?? null;
  } catch {
    return null;
  }
}
let inMemory = null;
let cachePath = null;
let loaded = false;
function getCachePath() {
  if (!cachePath) {
    cachePath = path.join(electron.app.getPath("userData"), "org-id.json");
  }
  return cachePath;
}
async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.promises.readFile(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.org_id === "string" && parsed.org_id) {
      inMemory = parsed.org_id;
    }
  } catch {
    inMemory = null;
  }
}
function getCachedOrgId() {
  return inMemory;
}
async function initOrgIdCache() {
  await ensureLoaded();
}
async function warmOrgIdCacheOnStartup() {
  await initOrgIdCache();
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  if (apiBaseUrl && creds?.apiKey) {
    refreshOrgIdFromBackend(apiBaseUrl, creds.apiKey).catch(
      (err) => console.error("[OrgIdCache] Refresh failed:", err)
    );
  }
}
async function refreshOrgIdFromBackend(apiBaseUrl, apiKey) {
  await ensureLoaded();
  if (!apiBaseUrl || !apiKey) {
    console.log("[OrgIdCache] refresh skipped - missing apiBaseUrl or apiKey");
    return inMemory;
  }
  const url2 = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/profile`;
  let resp;
  try {
    resp = await fetch(url2, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
  } catch (err) {
    console.warn(`[OrgIdCache] refresh network error: ${err}`);
    return inMemory;
  }
  if (!resp.ok) {
    console.warn(`[OrgIdCache] refresh HTTP ${resp.status} - keeping cached value (${inMemory ?? "null"})`);
    return inMemory;
  }
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    console.warn(`[OrgIdCache] refresh: malformed JSON in /user/profile response: ${err}`);
    return inMemory;
  }
  const orgId = data.org_id && typeof data.org_id === "string" ? data.org_id : null;
  if (!orgId) {
    console.warn("[OrgIdCache] refresh: /user/profile response did not include org_id");
    return inMemory;
  }
  inMemory = orgId;
  const payload = { org_id: orgId, refreshed_at: Date.now() };
  try {
    await fs.promises.writeFile(getCachePath(), JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("[OrgIdCache] Failed to persist org_id:", err);
  }
  console.log(`[OrgIdCache] refreshed org_id=${orgId}`);
  return orgId;
}
async function syncRegisteredServersFromBackend() {
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  if (!apiBaseUrl || !creds?.apiKey) {
    console.log("[SeenServersSync] Skipping - missing apiBaseUrl or apiKey");
    return;
  }
  let cachedOrgId = getCachedOrgId();
  if (!cachedOrgId) {
    cachedOrgId = await refreshOrgIdFromBackend(apiBaseUrl, creds.apiKey);
  }
  if (!cachedOrgId) {
    console.warn("[SeenServersSync] Skipping - org_id still unknown after refresh attempt");
    return;
  }
  const url2 = `${apiBaseUrl.replace(/\/$/, "")}/api/v1/servers/fingerprints`;
  console.log(`[SeenServersSync] GET ${url2} org=${cachedOrgId}`);
  const headers = {
    Authorization: `Bearer ${creds.apiKey}`,
    Accept: "application/json"
  };
  let response;
  try {
    response = await fetch(url2, { method: "GET", headers });
  } catch (err) {
    console.warn(`[SeenServersSync] Network error fetching fingerprints: ${err}`);
    return;
  }
  if (!response.ok) {
    console.warn(`[SeenServersSync] Backend returned ${response.status} - falling back to local seen-store`);
    return;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    console.log(`[SeenServersSync] Malformed JSON in fingerprints response: ${err}`);
    return;
  }
  if (!payload || typeof payload.org_id !== "string" || !payload.org_id || !Array.isArray(payload.fingerprints)) {
    console.log("[SeenServersSync] Unexpected payload shape - skipping");
    return;
  }
  if (payload.org_id !== cachedOrgId) {
    console.warn(
      `[SeenServersSync] org_id mismatch - response=${payload.org_id} cached=${cachedOrgId}. Skipping to avoid cross-org contamination.`
    );
    return;
  }
  const registeredCount = payload.fingerprints.filter((f) => f?.status !== "requested").length;
  const requestedCount = payload.fingerprints.filter((f) => f?.status === "requested").length;
  console.log(
    `[SeenServersSync] response org_id=${payload.org_id} entries=${payload.fingerprints.length} (registered=${registeredCount}, requested=${requestedCount})`
  );
  for (const entry of payload.fingerprints) {
    if (!entry) continue;
    console.log(
      `[SeenServersSync]   ${entry.status ?? "registered"}: name=${entry.name} fp=${entry.fingerprint}`
    );
  }
  const store = getSharedSeenStore();
  const syncedFingerprints = /* @__PURE__ */ new Set();
  for (const entry of payload.fingerprints) {
    if (!entry || typeof entry.fingerprint !== "string" || typeof entry.name !== "string") {
      continue;
    }
    const action = entry.status === "requested" ? "requested" : "registered";
    syncedFingerprints.add(entry.fingerprint);
    try {
      await store.markFromBackend(cachedOrgId, entry.fingerprint, entry.name, action);
    } catch (err) {
      console.warn(`[SeenServersSync] Failed to upsert ${entry.name}: ${err}`);
    }
  }
  try {
    await store.pruneForOrg(cachedOrgId, syncedFingerprints);
  } catch (err) {
    console.warn(`[SeenServersSync] pruneForOrg failed: ${err}`);
  }
  console.log(
    `[SeenServersSync] done - synced ${payload.fingerprints.length} entries from backend for org ${cachedOrgId}`
  );
}
async function fetchAutoQuarantineEnabled(apiBaseUrl, apiKey) {
  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!resp.ok) return false;
    const config = await resp.json();
    return !!config.auto_quarantine_other_mcp_servers;
  } catch {
    return false;
  }
}
const LOG_FILE$1 = "/tmp/ew-startup.log";
function slog$1(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    fs.appendFileSync(LOG_FILE$1, line);
  } catch {
  }
  console.log(msg);
}
let configMonitor = null;
let autoQuarantineEnabled = false;
let isHandlingQuarantine = false;
let updateTrayMenuFn = null;
let getMainWindowFn = null;
function initQuarantineManager(updateTrayMenu2, getMainWindow2) {
  updateTrayMenuFn = updateTrayMenu2;
  getMainWindowFn = getMainWindow2;
}
function getAutoQuarantineEnabled() {
  return autoQuarantineEnabled;
}
async function startQuarantineMonitorIfEnabled() {
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  slog$1(`[Quarantine] startQuarantineMonitorIfEnabled: apiBaseUrl=${apiBaseUrl}, hasApiKey=${!!creds?.apiKey}`);
  if (!apiBaseUrl || !creds?.apiKey) {
    slog$1("[Quarantine] Skipping - missing apiBaseUrl or apiKey");
    return;
  }
  const enabled = await fetchAutoQuarantineEnabled(apiBaseUrl, creds.apiKey);
  slog$1(`[Quarantine] fetchAutoQuarantineEnabled returned: ${enabled}`);
  if (!enabled) return;
  await startQuarantineMonitor();
}
async function startQuarantineMonitor() {
  slog$1("[Quarantine] startQuarantineMonitor called");
  if (configMonitor) {
    slog$1("[Quarantine] Already running, skipping");
    return;
  }
  autoQuarantineEnabled = true;
  updateTrayMenuFn?.();
  const seenStore = getSharedSeenStore();
  configMonitor = new McpConfigMonitor(seenStore);
  configMonitor.on("serversPendingQuarantine", async (pendingEvents) => {
    slog$1(`[Quarantine] serversPendingQuarantine event: ${pendingEvents.length} servers - ${pendingEvents.map((e) => e.server.name).join(", ")}`);
    if (pendingEvents.length === 0) return;
    await syncRegisteredServersFromBackend();
    let currentOrgId = getCachedOrgId();
    if (!currentOrgId) {
      const apiBaseUrl2 = getApiBaseUrl();
      const creds2 = getCredentialsForEnv();
      if (apiBaseUrl2 && creds2?.apiKey) {
        currentOrgId = await refreshOrgIdFromBackend(apiBaseUrl2, creds2.apiKey);
      }
    }
    const newEvents = [];
    for (const event of pendingEvents) {
      const seen = currentOrgId ? await getSharedSeenStore().get(currentOrgId, event.fingerprint) : null;
      slog$1(
        `[Quarantine] decision for ${event.server.name} fp=${event.fingerprint}: orgId=${currentOrgId ?? "null"}, seen=${seen ? `{org=${seen.org_id}, action=${seen.action}}` : "null"}`
      );
      if (currentOrgId && seen && seen.org_id === currentOrgId && (seen.action === "registered" || seen.action === "requested")) {
        slog$1(`[Quarantine] → silently quarantining known server: ${event.server.name} (action=${seen.action})`);
        try {
          await quarantineServer(event.server);
        } catch (err) {
          slog$1(`[Quarantine] Failed to silently quarantine "${event.server.name}": ${err}`);
        }
      } else {
        if (!currentOrgId) {
          slog$1(`[Quarantine] → prompting (no cached org_id): "${event.server.name}"`);
        } else if (!seen) {
          slog$1(`[Quarantine] → prompting (no seen-store entry for this org+fp): "${event.server.name}"`);
        } else {
          slog$1(`[Quarantine] → prompting (seen action=${seen.action} isn't registered/requested): "${event.server.name}"`);
        }
        newEvents.push(event);
      }
    }
    if (newEvents.length === 0) {
      slog$1("[Quarantine] All servers were known - no dialog needed");
      return;
    }
    const apiBaseUrl = getApiBaseUrl();
    const creds = getCredentialsForEnv();
    let isAdminOrOwner = false;
    if (apiBaseUrl && creds?.apiKey) {
      try {
        const role = await fetchUserRole(apiBaseUrl, creds.apiKey);
        isAdminOrOwner = role === "admin" || role === "owner";
      } catch {
      }
    }
    const parentWindow = getMainWindowFn?.() ?? void 0;
    try {
      const results = await showQuarantinedServersDialog(newEvents, parentWindow ?? void 0, isAdminOrOwner);
      const submittedFingerprints = new Set(
        results.filter((r) => r.action === "registered" || r.action === "requested").map((r) => r.fingerprint)
      );
      for (const { server, fingerprint } of newEvents) {
        if (submittedFingerprints.has(fingerprint)) continue;
        try {
          await quarantineServer(server);
          slog$1(`[Quarantine] Quarantined skipped/dismissed server: ${server.name}`);
        } catch (err) {
          slog$1(`[Quarantine] Failed to quarantine "${server.name}": ${err}`);
        }
      }
    } catch (err) {
      slog$1(`[Quarantine] Failed to show quarantine dialog: ${err}`);
      console.error("[McpConfigMonitor] Failed to show quarantine dialog:", err);
      for (const { server } of newEvents) {
        try {
          await quarantineServer(server);
        } catch {
        }
      }
    }
  });
  configMonitor.on("error", (err) => {
    slog$1(`[Quarantine] Monitor error: ${err}`);
    console.error("[McpConfigMonitor] Error:", err);
  });
  slog$1("[Quarantine] Calling configMonitor.start()...");
  await configMonitor.start();
  slog$1("[Quarantine] configMonitor.start() completed");
}
async function handleQuarantineEnabled() {
  if (configMonitor || isHandlingQuarantine) return;
  isHandlingQuarantine = true;
  try {
    autoQuarantineEnabled = true;
    updateTrayMenuFn?.();
    await startQuarantineMonitor();
  } finally {
    isHandlingQuarantine = false;
  }
}
function handleQuarantineDisabled() {
  if (!configMonitor && !autoQuarantineEnabled) return;
  stopQuarantineMonitor();
  updateTrayMenuFn?.();
}
function stopQuarantineMonitor() {
  configMonitor?.stop();
  configMonitor = null;
  autoQuarantineEnabled = false;
}
const QUARANTINE_POLL_INTERVAL_MS = 5 * 6e4;
let quarantinePollTimer = null;
async function fetchQuarantineFlag() {
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  if (!apiBaseUrl || !creds?.apiKey) return null;
  try {
    const resp = await fetch(`${apiBaseUrl}/api/v1/user/domain-config`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` }
    });
    if (!resp.ok) return null;
    const config = await resp.json();
    return Boolean(config.auto_quarantine_other_mcp_servers);
  } catch {
    return null;
  }
}
async function pollQuarantineConfig() {
  const shouldBeEnabled = await fetchQuarantineFlag();
  if (shouldBeEnabled === null) return;
  if (shouldBeEnabled && !configMonitor) {
    await handleQuarantineEnabled();
  } else if (!shouldBeEnabled && (configMonitor || autoQuarantineEnabled)) {
    handleQuarantineDisabled();
  }
}
function startQuarantinePolling() {
  if (quarantinePollTimer) return;
  quarantinePollTimer = setInterval(() => {
    pollQuarantineConfig().catch(() => {
    });
  }, QUARANTINE_POLL_INTERVAL_MS);
}
function stopQuarantinePolling() {
  if (!quarantinePollTimer) return;
  clearInterval(quarantinePollTimer);
  quarantinePollTimer = null;
}
async function runDebugQuarantine() {
  try {
    async function handleQuarantineEvents(events2) {
      if (events2.length === 0) return;
      const apiBaseUrl = getApiBaseUrl();
      const creds = getCredentialsForEnv();
      let isAdminOrOwner = false;
      if (apiBaseUrl && creds?.apiKey) {
        try {
          const role = await fetchUserRole(apiBaseUrl, creds.apiKey);
          isAdminOrOwner = role === "admin" || role === "owner";
        } catch {
        }
      }
      const parentWindow = getMainWindowFn?.() ?? void 0;
      await showQuarantinedServersDialog(events2, parentWindow, isAdminOrOwner);
    }
    if (configMonitor) {
      await configMonitor.runQuarantineWorkflow();
    } else {
      const tempMonitor = new McpConfigMonitor(getSharedSeenStore());
      tempMonitor.on("error", (err) => {
        slog$1(`[Quarantine] tempMonitor error (debug run): ${err}`);
        console.error("[runDebugQuarantine] Monitor error:", err);
      });
      tempMonitor.once("serversPendingQuarantine", (events2) => {
        handleQuarantineEvents(events2).catch((err) => {
          slog$1(`[Quarantine] Failed to show quarantine dialog (debug run): ${err}`);
          console.error("[runDebugQuarantine] Failed to show quarantine dialog:", err);
        });
      });
      await tempMonitor.runQuarantineWorkflow();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
const trayIconPath = path.join(__dirname, "../../resources/icon_tray.png");
function renderAgentIconSvg(agentName) {
  if (!agentName) return "";
  const id = resolveAgentId(agentName);
  if (!id) return "";
  const entry = AGENT_REGISTRY[id];
  if (entry.svgPath) {
    return `<svg class="approval-agent-icon" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${entry.svgPath}"/></svg>`;
  }
  if (entry.customSvg) {
    const vb = entry.customViewBox ?? "0 0 24 24";
    return `<svg class="approval-agent-icon" viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${entry.customSvg}</svg>`;
  }
  return "";
}
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const APPROVAL_TIMEOUT_MS = 3e4;
const RISK_LEG_DEFS = [
  ["private", "Read private data", "#f59e0b"],
  ["untrusted", "Saw untrusted content", "#3b82f6"],
  ["external", "Can send data out", "#ef4444"]
];
const RISK_LEVEL_DEFS = {
  low: { label: "Low risk", color: "#10b981" },
  medium: { label: "Medium risk", color: "#f59e0b" },
  high: { label: "High risk", color: "#f97316" },
  critical: { label: "Critical risk", color: "#ef4444" }
};
function renderRiskBadgeHtml(level) {
  if (!level) return "";
  const def = RISK_LEVEL_DEFS[level];
  if (!def) return "";
  return `<span class="risk-badge" style="color:${def.color};background:${def.color}29"><span class="risk-badge-dot" style="background:${def.color}"></span>${escapeHtml(def.label)}</span>`;
}
function renderRiskHtml(risk) {
  if (!risk) return "";
  const legRows = [];
  if (risk.legs) {
    for (const [key, label, color] of RISK_LEG_DEFS) {
      const src = risk.legs[key];
      if (src === void 0) continue;
      const source = src ? `<span class="risk-leg-source">· ${escapeHtml(src)}</span>` : "";
      legRows.push(
        `<li class="risk-leg"><span class="risk-dot" style="background:${color}"></span><span class="risk-leg-label">${escapeHtml(label)}</span>${source}</li>`
      );
    }
  }
  const legsHtml = legRows.length ? `<ul class="risk-legs">${legRows.join("")}</ul>` : "";
  const badge = renderRiskBadgeHtml(risk.risk_level);
  const headlineHtml = risk.headline ? `<div class="risk-headline">${escapeHtml(risk.headline)}${badge}</div>` : badge ? `<div class="risk-headline">${badge}</div>` : "";
  const aiTag = risk.source === "llm" ? `<span class="risk-ai">✦ AI</span>` : "";
  const summaryHtml = risk.summary ? `<p class="risk-summary">${escapeHtml(risk.summary)}${aiTag}</p>` : "";
  return `<div class="risk-block">${headlineHtml}${legsHtml}${summaryHtml}</div>`;
}
function renderArgumentsHtml(argsPreview) {
  if (!argsPreview) return "";
  return `<details class="approval-args"><summary>View tool call details</summary><pre class="approval-args-pre">${escapeHtml(argsPreview)}</pre></details>`;
}
function renderCountdownHtml(timestamp) {
  return `<div class="approval-expiry" data-timestamp="${escapeHtml(String(timestamp))}"><div class="approval-expiry-note">Auto-denies in <span class="approval-expiry-secs"></span> if you don&#39;t respond.</div><div class="approval-expiry-bar"><div class="approval-expiry-bar-fill"></div></div></div>`;
}
function renderApprovalItem(a) {
  const toolName = a.name.replace(/^agent_/, "").replace(/_/g, " ");
  const readableName = toolName.split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const agentIconSvg = renderAgentIconSvg(a.agentName);
  const headerName = a.risk?.title ?? readableName;
  return `
        <div class="approval-item" data-approval-id="${escapeHtml(a.id)}">
          <div class="approval-header">
            <div class="approval-title">${agentIconSvg}<strong>${escapeHtml(headerName)}</strong></div>
            <span class="approval-kind">${escapeHtml(a.kind)}</span>
          </div>
          <div class="approval-risk">${renderRiskHtml(a.risk)}</div>
          ${renderArgumentsHtml(a.argumentsPreview)}
          <div class="approval-timestamp" data-timestamp="${escapeHtml(String(a.timestamp))}"></div>
          <div class="approval-actions">
            <button class="button button-deny" data-command="deny">Deny - block</button>
            <button class="button button-approve" data-command="approve">Approve once</button>
          </div>
          ${renderCountdownHtml(a.timestamp)}
        </div>`;
}
const APPROVAL_DIALOG_CSS = `
.approval-item {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
  overflow: hidden;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.approval-item:hover {
  border-color: var(--text-muted);
}

.approval-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.approval-header strong {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.approval-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-agent-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.approval-kind {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 2px 8px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.risk-block {
  margin: 4px 0 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.risk-headline {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.risk-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: nowrap;
}

.risk-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.risk-legs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.risk-leg {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary);
}

.risk-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.risk-leg-source {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.risk-summary {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  margin: 2px 0 0;
}

.risk-ai {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-dim);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
}

.approval-args {
  margin: 0 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  overflow: hidden;
}

.approval-args summary {
  cursor: pointer;
  list-style: none;
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  user-select: none;
}

.approval-args summary::-webkit-details-marker {
  display: none;
}

.approval-args summary::before {
  content: "▸ ";
  display: inline-block;
  transition: transform 0.15s;
}

.approval-args[open] summary::before {
  content: "▾ ";
}

.approval-args-pre {
  margin: 0;
  padding: 10px;
  border-top: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

.approval-timestamp {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.approval-expiry {
  margin-top: 10px;
}

.approval-expiry-note {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.approval-expiry-bar {
  height: 2px;
  width: 100%;
  background: var(--border);
  border-radius: 9999px;
  overflow: hidden;
}

.approval-expiry-bar-fill {
  height: 100%;
  width: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}

.approval-actions {
  display: flex;
  gap: 8px;
}

/* Brand colours: red = deny/block, green = approve. */
.button-deny,
.button-deny-all {
  background: var(--danger) !important;
  color: var(--bg-base) !important;
  border-color: var(--danger) !important;
  font-weight: 600 !important;
}

.button-deny:hover,
.button-deny-all:hover {
  filter: brightness(1.1) !important;
}

.button-approve,
.button-approve-all {
  background: var(--success) !important;
  color: var(--bg-base) !important;
  border-color: var(--success) !important;
  font-weight: 600 !important;
}

.button-approve:hover,
.button-approve-all:hover {
  filter: brightness(1.1) !important;
}`;
const APPROVAL_DIALOG_SCRIPT = `
const{ipcRenderer}=require('electron');
function requestResize(){try{ipcRenderer.send('approval:resize',document.documentElement.scrollHeight)}catch(e){}}
function updateHeaderCount(){const r=document.querySelectorAll('.approval-item').length;const h=document.querySelector('h1');if(h)h.innerHTML='Pending Approvals <span class="count">('+r+')</span>'}
function formatTimestamp(ts){const d=new Date(ts),now=new Date(),diff=Math.floor((now-d)/1000);const ds=d.toLocaleDateString('en-US',{month:'short',day:'numeric'});const ts2=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});let rel='';if(diff<60)rel=diff+' second'+(diff!==1?'s':'')+' ago';else if(diff<3600){const m=Math.floor(diff/60);rel=m+' minute'+(m!==1?'s':'')+' ago'}else if(diff<86400){const h=Math.floor(diff/3600);rel=h+' hour'+(h!==1?'s':'')+' ago'}else{const dy=Math.floor(diff/86400);rel=dy+' day'+(dy!==1?'s':'')+' ago'}return ds+', '+ts2+' ('+rel+')'}
function updateTimestamps(){document.querySelectorAll('.approval-timestamp').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(t)el.textContent=formatTimestamp(t)})}
setInterval(updateTimestamps,1000);updateTimestamps();
var APPROVAL_TIMEOUT_MS=${APPROVAL_TIMEOUT_MS};
function renderCountdown(ts){return '<div class="approval-expiry" data-timestamp="'+escapeHtml(ts)+'"><div class="approval-expiry-note">Auto-denies in <span class="approval-expiry-secs"></span> if you don&#39;t respond.</div><div class="approval-expiry-bar"><div class="approval-expiry-bar-fill"></div></div></div>'}
function updateCountdowns(){const now=Date.now();document.querySelectorAll('.approval-expiry').forEach(el=>{const t=parseInt(el.getAttribute('data-timestamp'));if(!t)return;const left=Math.max(0,APPROVAL_TIMEOUT_MS-(now-t));const secs=Math.ceil(left/1000);const sEl=el.querySelector('.approval-expiry-secs');if(sEl)sEl.textContent=secs+'s';const fill=el.querySelector('.approval-expiry-bar-fill');if(fill)fill.style.width=(left/APPROVAL_TIMEOUT_MS*100)+'%'})}
setInterval(updateCountdowns,200);updateCountdowns();requestResize();
function removeApprovalItem(id){const item=document.querySelector('[data-approval-id="'+CSS.escape(id)+'"]');if(!item)return;item.style.transition='all .4s cubic-bezier(.4,0,.2,1)';item.style.transform='translateX(-100%)';item.style.opacity='0';item.style.maxHeight=item.offsetHeight+'px';setTimeout(()=>{item.style.maxHeight='0';item.style.marginBottom='0';item.style.paddingTop='0';item.style.paddingBottom='0';item.style.borderWidth='0'},100);setTimeout(()=>{item.remove();updateHeaderCount();requestResize();if(document.querySelectorAll('.approval-item').length===0)setTimeout(()=>window.close(),300)},400)}
document.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn)return;const item=btn.closest('.approval-item');if(!item)return;const aId=item.dataset.approvalId,cmd=btn.dataset.command;if(aId&&cmd){item.querySelectorAll('button').forEach(b=>{b.disabled=true;b.style.opacity='0.5'});const ch='approval:'+cmd;ipcRenderer.invoke(ch,aId).catch(err=>{alert('Failed: '+(err.message||String(err)));item.querySelectorAll('button').forEach(b=>{b.disabled=false;b.style.opacity='1'})})}});
function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
var RISK_LEGS=[['private','Read private data','#f59e0b'],['untrusted','Saw untrusted content','#3b82f6'],['external','Can send data out','#ef4444']];
var RISK_LEVELS={low:['Low risk','#10b981'],medium:['Medium risk','#f59e0b'],high:['High risk','#f97316'],critical:['Critical risk','#ef4444']};
function riskBadge(l){var d=l&&RISK_LEVELS[l];if(!d)return'';return '<span class="risk-badge" style="color:'+d[1]+';background:'+d[1]+'29"><span class="risk-badge-dot" style="background:'+d[1]+'"></span>'+escapeHtml(d[0])+'</span>'}
function renderArgs(p){if(!p)return'';return '<details class="approval-args"><summary>View tool call details</summary><pre class="approval-args-pre">'+escapeHtml(p)+'</pre></details>'}
function renderRisk(risk){if(!risk)return'';var rows='';if(risk.legs){for(var i=0;i<RISK_LEGS.length;i++){var k=RISK_LEGS[i][0],lbl=RISK_LEGS[i][1],col=RISK_LEGS[i][2];var src=risk.legs[k];if(src===undefined)continue;var s=src?'<span class="risk-leg-source">· '+escapeHtml(src)+'</span>':'';rows+='<li class="risk-leg"><span class="risk-dot" style="background:'+col+'"></span><span class="risk-leg-label">'+escapeHtml(lbl)+'</span>'+s+'</li>'}}var legs=rows?'<ul class="risk-legs">'+rows+'</ul>':'';var bdg=riskBadge(risk.risk_level);var head=(risk.headline||bdg)?'<div class="risk-headline">'+(risk.headline?escapeHtml(risk.headline):'')+bdg+'</div>':'';var ai=risk.source==='llm'?'<span class="risk-ai">✦ AI</span>':'';var sum=risk.summary?'<p class="risk-summary">'+escapeHtml(risk.summary)+ai+'</p>':'';return '<div class="risk-block">'+head+legs+sum+'</div>'}
function addApprovalItem(a){const c=document.getElementById('approvals');if(!c)return;const tn=(a.name||'').replace(/^agent_/,'').replace(/_/g,' ');const rn=tn.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');const hdr=(a.risk&&a.risk.title)?a.risk.title:rn;const icon=a.agentIconSvg||'';const item=document.createElement('div');item.className='approval-item';item.setAttribute('data-approval-id',a.id);item.style.opacity='0';item.style.transform='translateY(-20px)';item.innerHTML='<div class="approval-header"><div class="approval-title">'+icon+'<strong>'+escapeHtml(hdr)+'</strong></div><span class="approval-kind">'+escapeHtml(a.kind)+'</span></div><div class="approval-risk">'+renderRisk(a.risk)+'</div>'+renderArgs(a.argumentsPreview)+'<div class="approval-timestamp" data-timestamp="'+escapeHtml(a.timestamp)+'"></div><div class="approval-actions"><button class="button button-deny" data-command="deny">Deny - block</button><button class="button button-approve" data-command="approve">Approve once</button></div>'+renderCountdown(a.timestamp)+'';c.appendChild(item);setTimeout(()=>{item.style.transition='all .3s cubic-bezier(.4,0,.2,1)';item.style.opacity='1';item.style.transform='translateY(0)'},10);const tel=item.querySelector('.approval-timestamp');if(tel)tel.textContent=formatTimestamp(a.timestamp);updateCountdowns();updateHeaderCount();requestResize()}
ipcRenderer.on('approval:removed',(_e,id)=>removeApprovalItem(id));
ipcRenderer.on('approval:added',(_e,a)=>addApprovalItem(a));
document.getElementById('approve-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-approve');if(b&&!b.disabled)b.click()})});
document.getElementById('deny-all')?.addEventListener('click',()=>{document.querySelectorAll('.approval-item').forEach(item=>{const b=item.querySelector('.button-deny');if(b&&!b.disabled)b.click()})});
`;
function buildApprovalDialogHtml(approvals) {
  const approvalsHtml = approvals.map(renderApprovalItem).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Pending Approvals</title>
<style>
${BASE_CSS}
${HEADER_CSS}
${BUTTON_CSS}
${APPROVAL_DIALOG_CSS}
</style></head>
<body>
<div class="header">
  <h1>Pending Approvals <span class="count">(${approvals.length})</span></h1>
  <div class="header-actions">
    <button class="button button-bulk button-approve-all" id="approve-all">Approve All</button>
    <button class="button button-bulk button-deny-all" id="deny-all">Deny All</button>
  </div>
</div>
<div id="approvals">${approvalsHtml}</div>
<script>${APPROVAL_DIALOG_SCRIPT}<\/script></body></html>`;
}
let eventSource = null;
const pendingApprovals = /* @__PURE__ */ new Map();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let desktopLoginRegistered = false;
const RECONNECT_DELAY_MS = 1e3;
const APPROVAL_EXPIRY_MS = 3e4;
let expiryTimer = null;
const APPROVAL_WINDOW_WIDTH = 500;
const APPROVAL_WINDOW_MIN_HEIGHT = 180;
const APPROVAL_WINDOW_MAX_HEIGHT = 680;
let sseConnected = false;
let _onSseStatusChanged = null;
function isSseConnected() {
  return sseConnected;
}
function setSseStatusCallback(cb) {
  _onSseStatusChanged = cb;
}
function updateSseStatus(connected) {
  if (sseConnected === connected) return;
  sseConnected = connected;
  _onSseStatusChanged?.();
}
let _getMainWindow = () => null;
let _getApprovalWindow = () => null;
let _setApprovalWindow = () => {
};
let _onPendingChanged = null;
function initApprovalsHandler(getMainWindow2, getApprovalWindowRef, setApprovalWindowRef, onPendingChanged) {
  _getMainWindow = getMainWindow2;
  _getApprovalWindow = getApprovalWindowRef;
  _setApprovalWindow = setApprovalWindowRef;
  _onPendingChanged = onPendingChanged;
}
function startEventSubscription$1(onQuarantineEnabled, onQuarantineDisabled, onReconnected) {
  const setupData = getSetupData();
  const apiKey = getCredentialsForEnv()?.apiKey;
  const userId = setupData.userId;
  if (!apiKey || !userId) {
    console.warn("Cannot start event subscription: missing apiKey or userId");
    return;
  }
  const eventsUrl = getEventsUrl(apiKey);
  if (!eventsUrl) {
    console.warn("Cannot start event subscription: cannot construct events URL");
    return;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  console.log(`Connecting to SSE endpoint: ${eventsUrl.replace(/api_key=[^&]+/, "api_key=***")}`);
  try {
    const { EventSource } = require("eventsource");
    eventSource = new EventSource(eventsUrl);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`[SSE] event received: type=${data.type}`);
        if (data.type === "mcp_pre_block") {
          handleTrifectaEvent(data);
        } else if (data.type === "mcp_approve_or_deny_once") {
          handleRemoteApprovalDismiss(data);
        } else if (data.type === "quarantine_enabled") {
          const userDomain = getSetupData().userEmail?.split("@")[1];
          if (!data.domain || data.domain === userDomain) {
            onQuarantineEnabled(data.domain);
          }
        } else if (data.type === "quarantine_disabled") {
          const userDomain = getSetupData().userEmail?.split("@")[1];
          if (!data.domain || data.domain === userDomain) {
            onQuarantineDisabled?.(data.domain);
          }
        }
      } catch (err) {
        console.error("Failed to parse SSE event:", err);
      }
    };
    eventSource.onerror = () => {
      updateSseStatus(false);
      handleReconnect(onQuarantineEnabled, onQuarantineDisabled, onReconnected);
    };
    eventSource.onopen = () => {
      console.log("SSE connection established");
      const wasReconnect = reconnectAttempts > 0;
      reconnectAttempts = 0;
      updateSseStatus(true);
      if (wasReconnect) {
        onReconnected?.();
      }
      if (!desktopLoginRegistered) {
        desktopLoginRegistered = true;
        const baseUrl = getApiBaseUrl();
        if (baseUrl && apiKey) {
          fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/user/register-desktop-login`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` }
          }).catch((err) => console.warn("Failed to register desktop login:", err));
        }
      }
    };
  } catch (err) {
    console.error("Failed to create EventSource:", err);
    updateSseStatus(false);
    handleReconnect(onQuarantineEnabled, onQuarantineDisabled, onReconnected);
  }
}
function stopEventSubscription() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempts = 0;
  desktopLoginRegistered = false;
  updateSseStatus(false);
}
function handleReconnect(onQuarantineEnabled, onQuarantineDisabled, onReconnected) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("Max reconnect attempts reached, stopping SSE subscription");
    return;
  }
  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(() => {
    startEventSubscription$1(onQuarantineEnabled, onQuarantineDisabled, onReconnected);
  }, delay);
}
function isAlive(w) {
  return w !== null && !w.isDestroyed();
}
function handleTrifectaEvent(data) {
  const mainWindow2 = _getMainWindow();
  const approvalWindow2 = _getApprovalWindow();
  const { session_id, kind, name, reason, risk, arguments_preview, agent_name } = data;
  const approvalId = `${session_id}::${kind}::${name}::${Date.now()}`;
  const pending = {
    id: approvalId,
    sessionId: session_id,
    kind,
    name,
    reason,
    risk,
    argumentsPreview: arguments_preview,
    timestamp: Date.now(),
    agentName: agent_name
  };
  pendingApprovals.set(approvalId, pending);
  _onPendingChanged?.();
  startExpirySweep();
  if (isAlive(approvalWindow2)) {
    approvalWindow2.webContents.send("approval:added", {
      id: approvalId,
      sessionId: session_id,
      kind,
      name,
      reason,
      risk,
      argumentsPreview: arguments_preview,
      timestamp: pending.timestamp,
      agentName: agent_name,
      agentIconSvg: renderAgentIconSvg(agent_name)
    });
  }
  try {
    const supported = electron.Notification.isSupported();
    console.log(`[SSE] Notification.isSupported()=${supported}, approvalId=${approvalId}`);
    if (!supported) throw new Error("notifications not supported");
    const toolName = name.replace(/^agent_/, "").replace(/_/g, " ");
    const readableName = toolName.split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    const notificationOptions = {
      title: risk?.title ?? "Edison Watch - Security Block",
      body: risk ? `${risk.headline} Approve only if you trust this.` : `${readableName} has been blocked.
This action requires your approval to proceed.`,
      urgency: "normal",
      ...process.platform !== "darwin" && { icon: trayIconPath }
    };
    if (process.platform === "darwin") {
      notificationOptions.actions = [
        { type: "button", text: "Deny" },
        { type: "button", text: "Approve" }
      ];
    }
    const notification = new electron.Notification(notificationOptions);
    if (process.platform === "darwin") {
      notification.on("action", (_event, index) => {
        const commands = ["deny", "approve"];
        const command = commands[index];
        if (command) {
          handleApproval(approvalId, command);
          notification.close();
        }
      });
    }
    notification.on("click", () => {
      showPendingApprovalsDialog();
    });
    console.log(`[SSE] Showing notification for: ${readableName}`);
    notification.show();
    if (!isAlive(mainWindow2) || !mainWindow2.isFocused()) electron.app.dock?.bounce("informational");
    setTimeout(() => notification.close(), 5e3);
  } catch (err) {
    console.error("Failed to show notification:", err);
  }
  showPendingApprovalsDialog();
}
function handleRemoteApprovalDismiss(data) {
  const { session_id, kind, name } = data;
  for (const [id, approval] of pendingApprovals) {
    if (approval.sessionId === session_id && approval.kind === kind && approval.name === name) {
      pendingApprovals.delete(id);
      _onPendingChanged?.();
      const approvalWindow2 = _getApprovalWindow();
      if (isAlive(approvalWindow2)) {
        approvalWindow2.webContents.send("approval:removed", id);
        if (pendingApprovals.size === 0) {
          setTimeout(() => {
            if (isAlive(approvalWindow2) && pendingApprovals.size === 0) approvalWindow2.close();
          }, 500);
        }
      }
      break;
    }
  }
}
function sweepExpiredApprovals() {
  const now = Date.now();
  const expired = [];
  for (const [id, approval] of pendingApprovals) {
    if (now - approval.timestamp >= APPROVAL_EXPIRY_MS) {
      expired.push(id);
    }
  }
  if (expired.length === 0) return;
  const approvalWindow2 = _getApprovalWindow();
  for (const id of expired) {
    pendingApprovals.delete(id);
    if (isAlive(approvalWindow2)) {
      approvalWindow2.webContents.send("approval:removed", id);
    }
  }
  _onPendingChanged?.();
  if (pendingApprovals.size === 0) {
    stopExpirySweep();
    if (isAlive(approvalWindow2)) {
      setTimeout(() => {
        if (isAlive(approvalWindow2) && pendingApprovals.size === 0) approvalWindow2.close();
      }, 500);
    }
  }
}
function startExpirySweep() {
  if (expiryTimer) return;
  expiryTimer = setInterval(sweepExpiredApprovals, 15e3);
}
function stopExpirySweep() {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}
const inFlightApprovals = /* @__PURE__ */ new Set();
async function handleApproval(approvalId, command) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    console.warn(`[approval] No pending approval found for id=${approvalId}`);
    return;
  }
  if (inFlightApprovals.has(approvalId)) {
    console.log(`[approval] Skipping ${command} for ${approvalId} - already in-flight`);
    return;
  }
  const apiKey = getCredentialsForEnv()?.apiKey;
  if (!apiKey) {
    console.warn("[approval] No API key available");
    return;
  }
  const approvalUrl = getApprovalUrl();
  if (!approvalUrl) {
    console.warn("[approval] Cannot construct approval URL");
    return;
  }
  inFlightApprovals.add(approvalId);
  console.log(
    `[approval] Sending ${command} for ${pending.kind}:${pending.name} (session=${pending.sessionId.substring(0, 8)}...)`
  );
  try {
    const response = await fetch(approvalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        session_id: pending.sessionId,
        kind: pending.kind,
        name: pending.name,
        command
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[approval] Server returned ${response.status}: ${errorText}`);
      throw new Error(`Approval failed: ${response.status} ${errorText}`);
    }
    console.log(`[approval] Server accepted ${command}`);
    try {
      if (electron.Notification.isSupported()) {
        const actionLabel = command === "approve" ? "approved" : "denied";
        const n = new electron.Notification({
          title: "Edison Watch",
          body: `Successfully ${actionLabel} ${pending.kind} '${pending.name}'`,
          ...process.platform !== "darwin" && { icon: trayIconPath }
        });
        n.show();
        setTimeout(() => n.close(), 15e3);
      }
    } catch {
    }
  } catch (err) {
    console.error(`[approval] Failed to ${command} ${pending.kind} '${pending.name}':`, err);
  } finally {
    inFlightApprovals.delete(approvalId);
    pendingApprovals.delete(approvalId);
    _onPendingChanged?.();
    const approvalWindow2 = _getApprovalWindow();
    if (isAlive(approvalWindow2)) {
      approvalWindow2.webContents.send("approval:removed", approvalId);
      if (pendingApprovals.size === 0) {
        setTimeout(() => {
          if (isAlive(approvalWindow2) && pendingApprovals.size === 0) approvalWindow2.close();
        }, 500);
      }
    }
  }
}
function resizeApprovalWindow(contentHeight) {
  const w = _getApprovalWindow();
  if (!isAlive(w) || !Number.isFinite(contentHeight)) return;
  const clamped = Math.round(
    Math.max(APPROVAL_WINDOW_MIN_HEIGHT, Math.min(APPROVAL_WINDOW_MAX_HEIGHT, contentHeight))
  );
  const [curW] = w.getContentSize();
  w.setContentSize(curW || APPROVAL_WINDOW_WIDTH, clamped, false);
}
function showPendingApprovalsDialog() {
  const approvalWindow2 = _getApprovalWindow();
  const approvals = Array.from(pendingApprovals.values());
  if (approvals.length === 0) return;
  if (isAlive(approvalWindow2)) {
    approvalWindow2.focus();
    return;
  }
  const newApprovalWindow = new electron.BrowserWindow({
    width: APPROVAL_WINDOW_WIDTH,
    // Provisional; corrected to the true content height before the window is
    // shown (see did-finish-load below) and again live via 'approval:resize'.
    height: APPROVAL_WINDOW_MIN_HEIGHT,
    minHeight: APPROVAL_WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    // Intentionally NOT parented to the main window: a child window drags its
    // parent to the front (and reveals it if hidden) when shown on macOS, so a
    // trifecta notification would pop the whole client open. Standalone keeps
    // only the approval dialog focused.
    modal: false,
    webPreferences: {
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  _setApprovalWindow(newApprovalWindow);
  const html = buildApprovalDialogHtml(approvals);
  newApprovalWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  newApprovalWindow.webContents.once("did-finish-load", async () => {
    try {
      const h = await newApprovalWindow.webContents.executeJavaScript(
        "document.documentElement.scrollHeight"
      );
      resizeApprovalWindow(typeof h === "number" ? h : APPROVAL_WINDOW_MAX_HEIGHT);
    } catch {
    }
    if (!newApprovalWindow.isDestroyed()) newApprovalWindow.show();
  });
  newApprovalWindow.on("closed", () => {
    const remaining = Array.from(pendingApprovals.values()).filter(
      (p) => !inFlightApprovals.has(p.id)
    );
    pendingApprovals.clear();
    _onPendingChanged?.();
    _setApprovalWindow(null);
    const apiKey = getCredentialsForEnv()?.apiKey;
    const approvalUrl = getApprovalUrl();
    if (!apiKey || !approvalUrl) return;
    for (const pending of remaining) {
      fetch(approvalUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          session_id: pending.sessionId,
          kind: pending.kind,
          name: pending.name,
          command: "deny"
        })
      }).then((res) => {
        if (!res.ok)
          console.error(`[approval] Close-deny for ${pending.name} returned ${res.status}`);
      }).catch((err) => console.error(`[approval] Failed to deny ${pending.name} on close:`, err));
    }
  });
}
const execFileAsync = util.promisify(child_process.execFile);
async function getOrRefreshOrgId(apiBaseUrl, apiKey) {
  const cached2 = getCachedOrgId();
  if (cached2) {
    console.log(`[mcp:submit] org_id cache hit: ${cached2}`);
    return cached2;
  }
  if (!apiBaseUrl || !apiKey) {
    console.warn(`[mcp:submit] org_id cache miss and no apiBaseUrl/apiKey available to refresh`);
    return null;
  }
  console.log(`[mcp:submit] org_id cache miss - refreshing from ${apiBaseUrl}`);
  const orgId = await refreshOrgIdFromBackend(apiBaseUrl, apiKey);
  if (!orgId) console.warn(`[mcp:submit] org_id refresh returned null - /user/profile is missing org_id`);
  return orgId;
}
async function removeOrDisableServer(server) {
  if (server.source === "plugin" && server.client === "cursor") {
    await quarantineCursorPlugin(server);
  } else if (server.client === "claude-code" && server.source === "project" && server.projectName) {
    const name = server.originalName ?? server.name;
    console.log(`[MCP Config] Removing Claude Code project-scoped server "${name}" via CLI (project=${server.projectName})`);
    const removeArgs = ["mcp", "remove", name];
    logClaudeCmd(removeArgs, { cwd: server.projectName });
    await execFileAsync("claude", removeArgs, {
      timeout: 1e4,
      cwd: server.projectName
    });
    console.log(`[MCP Config] Removed "${name}" via claude mcp remove`);
  } else {
    await removeServerFromConfig(server);
  }
}
let discoveryCache = null;
async function runDiscovery() {
  const { servers, raw, unsupported } = await discoverMcpServers({ includeRaw: true });
  const filtered = filterOutEdisonWatchServers(servers);
  const rawFiltered = filterOutEdisonWatchServers(raw);
  discoveryCache = { servers: filtered, raw: rawFiltered, unsupported };
  return discoveryCache;
}
function getCachedDiscovery() {
  return discoveryCache ?? { servers: [], raw: [], unsupported: [] };
}
async function handleAlreadyOnBackend(server, match, apiBaseUrl, apiKey, removalMap) {
  const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
  if (orgId) {
    try {
      await getSharedSeenStore().markSeen(orgId, server, match.status);
    } catch {
    }
  }
  const entries = removalMap?.get(server.name) ?? [server];
  for (const entry of entries) {
    try {
      await removeOrDisableServer(entry);
    } catch {
    }
  }
}
function registerMcpSubmitHandlers() {
  electron.ipcMain.handle("mcp:discover", async () => {
    const { servers, unsupported } = await runDiscovery();
    console.log(`[mcp:discover] Found ${servers.length} servers, ${unsupported.length} unsupported`);
    for (const s of servers) {
      console.log(`[mcp:discover]   supported: ${s.name}@${s.client} source=${s.source} path=${s.path}`);
    }
    for (const s of unsupported) {
      const reason = describeUnsupportedReason(s) ?? "unknown";
      console.log(`[mcp:discover]   unsupported: ${s.name}@${s.client} source=${s.source} path=${s.path} reason=${reason}`);
    }
    return { servers, unsupported };
  });
  electron.ipcMain.handle("mcp:findDuplicates", async () => {
    const { servers } = getCachedDiscovery();
    return findDuplicateGroups(servers);
  });
  electron.ipcMain.handle("mcp:resubmitServer", async (_event, params) => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;
    const userId = params.userId || setup.userId;
    if (!apiKey || !apiBaseUrl) {
      return { success: false, error: "Not signed in or server URL not configured." };
    }
    const { servers: cached2, raw: cachedRaw } = getCachedDiscovery();
    let server = cached2.find((s) => s.name === params.originalName);
    const rawEntries = cachedRaw.filter((s) => s.name === (server?.originalName ?? params.originalName));
    if (!server && params.config && params.client) {
      server = {
        name: params.originalName,
        client: params.client,
        source: params.source || "user",
        path: params.configPath ?? "",
        config: params.config
      };
    }
    if (!server) {
      return { success: false, error: `Server "${params.originalName}" not found.` };
    }
    try {
      const renamed = { ...server, name: params.newName, originalName: server.name };
      const result = await submitServerRequest(renamed, apiBaseUrl, apiKey, userId);
      console.log(`[mcp:resubmitServer] Submit result for "${params.newName}":`, JSON.stringify(result));
      if (result.alreadyPending) {
        return { success: false, error: `"${params.newName}" already has a pending request.` };
      }
      if (result.alreadyExists) {
        return { success: false, error: result.errorMessage ?? `"${params.newName}" already exists.` };
      }
      let wasAutoApproved = result.autoApproved === true;
      if (!wasAutoApproved) {
        const role = await fetchUserRole(apiBaseUrl, apiKey);
        if (role === "admin" || role === "owner") {
          try {
            await approveServerRequest(result.request_id, apiBaseUrl, apiKey);
            wasAutoApproved = true;
          } catch {
          }
        }
      }
      {
        const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
        if (orgId) {
          try {
            await getSharedSeenStore().markSeen(orgId, server, wasAutoApproved ? "registered" : "requested");
          } catch {
          }
        } else {
          console.warn(`[mcp:submit] No org_id available - "${server.name}" won't be marked as seen; next detection will prompt.`);
        }
      }
      const entriesToRemove = rawEntries.length > 0 ? rawEntries : [server];
      for (const entry of entriesToRemove) {
        try {
          await removeOrDisableServer(entry);
        } catch {
        }
      }
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[mcp:resubmitServer] Error:`, msg);
      return { success: false, error: msg };
    }
  });
  electron.ipcMain.handle("mcp:removeServers", async (_event, targets) => {
    const { servers: deduped, raw: filtered } = getCachedDiscovery();
    const removed = [];
    const errors = [];
    const nameOnly = /* @__PURE__ */ new Set();
    const nameAndClient = /* @__PURE__ */ new Set();
    for (const t of targets) {
      if (typeof t === "string") nameOnly.add(t);
      else nameAndClient.add(`${t.name}:${t.client}`);
    }
    for (const s of deduped) {
      if (s.originalName && nameOnly.has(s.name)) {
        nameOnly.add(s.originalName);
      }
      if (s.originalName && nameAndClient.has(`${s.name}:${s.client}`)) {
        nameAndClient.add(`${s.originalName}:${s.client}`);
      }
    }
    for (const server of filtered) {
      const matchByName = nameOnly.has(server.name);
      const matchByPair = nameAndClient.has(`${server.name}:${server.client}`);
      if (!matchByName && !matchByPair) continue;
      try {
        await removeOrDisableServer(server);
        removed.push(`${server.name} (${server.client})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${server.name} [${server.client}]: ${msg}`);
      }
    }
    return { removed, errors };
  });
  electron.ipcMain.handle("mcp:readConfig", async (_event, configPath) => {
    try {
      return await fs.promises.readFile(configPath, "utf-8");
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("mcp:applyAppIntegrations", async (_event, args) => {
    console.log("[mcp:applyAppIntegrations]", args.apps, DRY_RUN ? "(dry-run)" : "");
    return await applyAppIntegrations({ ...args, dryRun: DRY_RUN });
  });
  electron.ipcMain.handle("mcp:revertAppIntegrations", async (_event, args) => {
    const { configs } = args;
    let reverted = 0;
    const errors = [];
    const allowedDirs = [os.homedir(), electron.app.getPath("userData")];
    const isAllowedPath = (p) => allowedDirs.some((dir) => path.resolve(p).startsWith(dir + path.sep));
    for (const { configPath, backupPath, appId } of configs) {
      try {
        if (appId === "claude-code" && !backupPath) {
          const { execFile: execFile2 } = await import("child_process");
          const { promisify: promisify2 } = await import("util");
          const execFileAsync2 = promisify2(execFile2);
          const revertArgs = ["mcp", "remove", "edison-watch", "-s", "user"];
          logClaudeCmd(revertArgs);
          await execFileAsync2("claude", revertArgs, { timeout: 1e4 });
          reverted++;
          console.log("[MCP Revert] Removed edison-watch from Claude Code via CLI");
          continue;
        }
        if (!isAllowedPath(configPath) || !isAllowedPath(backupPath)) {
          errors.push(`Path not allowed: ${configPath}`);
          continue;
        }
        if (!backupPath || !await fs.promises.access(backupPath).then(() => true).catch(() => false)) {
          errors.push(`No backup found for ${configPath}`);
          continue;
        }
        await fs.promises.copyFile(backupPath, configPath);
        reverted++;
        console.log(`[MCP Revert] Restored ${configPath} from ${backupPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${configPath}: ${msg}`);
        console.warn("[MCP Revert] Failed to restore", configPath, err);
      }
    }
    return { reverted, errors };
  });
  electron.ipcMain.handle("mcp:analyzeSecrets", async (_event, params) => {
    const { servers: cached2 } = getCachedDiscovery();
    const allServers = deduplicateServers(cached2);
    const skipSet = new Set(params?.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    return servers.map((server) => ({
      name: server.name,
      client: server.client,
      source: server.source,
      config: server.config,
      templatized: detectSecrets(server)
    }));
  });
  electron.ipcMain.handle("mcp:analyzeServerSecrets", async (_event, params) => {
    const server = {
      name: params.serverName,
      client: params.sourceApp,
      source: "user",
      path: params.configPath,
      config: params.config
    };
    const result = detectSecrets(server);
    return {
      config: params.config,
      templatizedConfig: result.config,
      templateFields: result.templateFields,
      secretValues: result.secretValues
    };
  });
  electron.ipcMain.handle("mcp:submitWithTemplates", async (_event, params) => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params.apiBaseUrl || setup.apiBaseUrl;
    const userId = params.userId || setup.userId;
    if (!apiKey || !apiBaseUrl) {
      return {
        submitted: 0,
        autoApproved: 0,
        skipped: 0,
        alreadyOnBackend: 0,
        total: 0,
        error: "Not signed in or server URL not configured."
      };
    }
    const { servers: cached2, raw: cachedRaw } = getCachedDiscovery();
    const allServers = deduplicateServers(cached2);
    const skipSet = new Set(params.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    const removalMap = buildRemovalMap(cachedRaw, servers);
    const serverList = servers.map((s) => ({ name: s.name, client: s.client, clients: s.clients, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    let alreadyOnBackend = 0;
    const errors = [];
    const failures = [];
    const backendIndex = await fetchBackendFingerprints(apiBaseUrl, apiKey);
    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";
    for (const server of servers) {
      const backendMatch = findBackendFingerprintMatch(server, backendIndex);
      if (backendMatch) {
        alreadyOnBackend++;
        await handleAlreadyOnBackend(server, backendMatch, apiBaseUrl, apiKey, removalMap);
        failures.push({
          name: server.name,
          client: server.client,
          reason: "already-on-backend",
          message: backendMatch.status === "registered" ? `Already registered on Edison Watch as "${backendMatch.name}"` : `Already pending review on Edison Watch as "${backendMatch.name}"`,
          backendStatus: backendMatch.status,
          config: server.config,
          configPath: server.path
        });
        continue;
      }
      try {
        const overrides = params.templateOverrides[server.name];
        const submitResult = overrides ? await submitServerWithOverrides(server, overrides, apiBaseUrl, apiKey, userId) : await submitServerRequest(server, apiBaseUrl, apiKey, userId);
        if (submitResult.alreadyPending) continue;
        if (submitResult.alreadyExists) {
          failures.push({
            name: server.name,
            client: server.client,
            reason: "conflict",
            message: submitResult.errorMessage ?? "A server with this name already exists",
            config: server.config,
            configPath: server.path
          });
          continue;
        }
        submitted++;
        let wasAutoApproved = submitResult.autoApproved === true;
        if (wasAutoApproved) {
          autoApproved++;
        } else if (canAutoApprove) {
          try {
            await approveServerRequest(submitResult.request_id, apiBaseUrl, apiKey);
            autoApproved++;
            wasAutoApproved = true;
          } catch (approveErr) {
            const msg = approveErr instanceof Error ? approveErr.message : String(approveErr);
            errors.push(`${server.name}: auto-approval failed - ${msg}`);
          }
        }
        {
          const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
          if (orgId) {
            try {
              await getSharedSeenStore().markSeen(orgId, server, wasAutoApproved ? "registered" : "requested");
            } catch {
            }
          } else {
            console.warn(`[mcp:submit] No org_id available - "${server.name}" won't be marked as seen; next detection will prompt.`);
          }
        }
        const rawEntries = removalMap.get(server.name) ?? [server];
        for (const entry of rawEntries) {
          try {
            await removeOrDisableServer(entry);
          } catch {
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ name: server.name, client: server.client, reason: "error", message: msg, config: server.config, configPath: server.path });
      }
    }
    return {
      submitted,
      autoApproved,
      alreadyOnBackend,
      skipped: servers.length - submitted - failures.length,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : void 0,
      failures: failures.length > 0 ? failures : void 0
    };
  });
  electron.ipcMain.handle("mcp:submitAllDiscovered", async (_event, params) => {
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = params?.apiKey || creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl() || params?.apiBaseUrl || setup.apiBaseUrl;
    const userId = params?.userId || setup.userId;
    if (!apiKey || !apiBaseUrl) {
      return {
        submitted: 0,
        autoApproved: 0,
        skipped: 0,
        alreadyOnBackend: 0,
        total: 0,
        error: "Not signed in or server URL not configured."
      };
    }
    const { servers: cached2, raw: cachedRaw } = getCachedDiscovery();
    const allServers = deduplicateServers(cached2);
    const skipSet = new Set(params?.skipServers ?? []);
    const servers = skipSet.size > 0 ? allServers.filter((s) => !skipSet.has(s.name)) : allServers;
    const removalMap = buildRemovalMap(cachedRaw, servers);
    const serverList = servers.map((s) => ({ name: s.name, client: s.client, clients: s.clients, source: s.source }));
    let submitted = 0;
    let autoApproved = 0;
    let alreadyOnBackend = 0;
    const errors = [];
    const failures = [];
    const backendIndex = await fetchBackendFingerprints(apiBaseUrl, apiKey);
    const role = await fetchUserRole(apiBaseUrl, apiKey);
    const canAutoApprove = role === "admin" || role === "owner";
    for (const server of servers) {
      const backendMatch = findBackendFingerprintMatch(server, backendIndex);
      if (backendMatch) {
        alreadyOnBackend++;
        await handleAlreadyOnBackend(server, backendMatch, apiBaseUrl, apiKey, removalMap);
        failures.push({
          name: server.name,
          client: server.client,
          reason: "already-on-backend",
          message: backendMatch.status === "registered" ? `Already registered on Edison Watch as "${backendMatch.name}"` : `Already pending review on Edison Watch as "${backendMatch.name}"`,
          backendStatus: backendMatch.status,
          config: server.config,
          configPath: server.path
        });
        continue;
      }
      try {
        const submitResult = await submitServerRequest(server, apiBaseUrl, apiKey, userId);
        if (submitResult.alreadyPending) continue;
        if (submitResult.alreadyExists) {
          failures.push({
            name: server.name,
            client: server.client,
            reason: "conflict",
            message: submitResult.errorMessage ?? "A server with this name already exists",
            config: server.config,
            configPath: server.path
          });
          continue;
        }
        submitted++;
        const { request_id } = submitResult;
        let wasAutoApproved = submitResult.autoApproved === true;
        if (wasAutoApproved) {
          autoApproved++;
        } else if (canAutoApprove) {
          try {
            await approveServerRequest(request_id, apiBaseUrl, apiKey);
            autoApproved++;
            wasAutoApproved = true;
          } catch (approveErr) {
            const msg = approveErr instanceof Error ? approveErr.message : String(approveErr);
            errors.push(`${server.name}: auto-approval failed - ${msg}`);
            console.error(`[mcp:submitAllDiscovered] Auto-approval failed for "${server.name}":`, approveErr);
          }
        }
        {
          const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
          if (orgId) {
            try {
              await getSharedSeenStore().markSeen(orgId, server, wasAutoApproved ? "registered" : "requested");
            } catch {
            }
          } else {
            console.warn(`[mcp:submit] No org_id available - "${server.name}" won't be marked as seen; next detection will prompt.`);
          }
        }
        const rawEntries = removalMap.get(server.name) ?? [server];
        for (const entry of rawEntries) {
          try {
            await removeOrDisableServer(entry);
          } catch (removeErr) {
            console.error(`[mcp:submitAllDiscovered] Failed to remove "${entry.name}" from ${entry.path}:`, removeErr);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push({ name: server.name, client: server.client, reason: "error", message: msg, config: server.config, configPath: server.path });
        console.error("[mcp:submitAllDiscovered]", `${server.name}: ${msg}`);
      }
    }
    return {
      submitted,
      autoApproved,
      alreadyOnBackend,
      skipped: servers.length - submitted - failures.length,
      total: servers.length,
      servers: serverList,
      errors: errors.length > 0 ? errors : void 0,
      failures: failures.length > 0 ? failures : void 0
    };
  });
  electron.ipcMain.handle("mcp:handleServerAction", async (_event, params) => {
    if (params.action !== "registered" && params.action !== "requested") {
      return { action: params.action };
    }
    const setup = getSetupData();
    const creds = getCredentialsForEnv();
    const apiKey = creds?.apiKey;
    const apiBaseUrl = getApiBaseUrl();
    if (!apiKey || !apiBaseUrl) {
      throw new Error("Not signed in or server URL not configured.");
    }
    const server = {
      name: params.serverName,
      client: params.sourceApp,
      source: params.source || "user",
      path: params.configPath,
      config: params.config
    };
    const backendIndex = await fetchBackendFingerprints(apiBaseUrl, apiKey);
    const backendMatch = findBackendFingerprintMatch(server, backendIndex);
    if (backendMatch) {
      await handleAlreadyOnBackend(server, backendMatch, apiBaseUrl, apiKey);
      return {
        action: params.action,
        alreadyOnBackend: true,
        backendStatus: backendMatch.status,
        existingName: backendMatch.name
      };
    }
    const submitResult = params.templateOverrides && params.templateOverrides.length > 0 ? await submitServerWithOverrides(server, params.templateOverrides, apiBaseUrl, apiKey, setup.userId) : await submitServerRequest(server, apiBaseUrl, apiKey, setup.userId);
    if (submitResult.alreadyPending) {
      return { action: params.action, alreadyPending: true };
    }
    if (submitResult.alreadyExists) {
      return { action: params.action, alreadyExists: true, errorMessage: submitResult.errorMessage };
    }
    const { request_id } = submitResult;
    let autoApproved = submitResult.autoApproved === true;
    let approveError;
    if (!autoApproved && params.action === "registered") {
      const role = await fetchUserRole(apiBaseUrl, apiKey);
      if (role === "admin" || role === "owner") {
        try {
          await approveServerRequest(request_id, apiBaseUrl, apiKey);
          autoApproved = true;
        } catch (err) {
          approveError = err instanceof Error ? err.message : String(err);
          console.error(`[mcp:handleServerAction] Auto-approval failed for "${params.serverName}":`, err);
        }
      }
    }
    const seenAction = autoApproved ? "registered" : "requested";
    {
      const orgId = await getOrRefreshOrgId(apiBaseUrl, apiKey);
      if (orgId) {
        try {
          await getSharedSeenStore().markSeen(orgId, server, seenAction);
        } catch {
        }
      } else {
        console.warn(`[mcp:submit] No org_id available - "${server.name}" won't be marked as seen; next detection will prompt.`);
      }
    }
    try {
      await removeOrDisableServer(server);
    } catch {
    }
    return { request_id, action: params.action, autoApproved, approveError };
  });
}
function getStdiodBinaryPath() {
  const exe = process.platform === "win32" ? "edison-stdiod.exe" : "edison-stdiod";
  if (electron.app.isPackaged) {
    return path$1.join(process.resourcesPath, "bin", exe);
  }
  const repoRoot = path$1.resolve(__dirname, "..", "..", "..");
  return path$1.join(repoRoot, "stdiod", "target", "release", exe);
}
function stdiodBinaryExists() {
  return node_fs.existsSync(getStdiodBinaryPath());
}
function stampPath() {
  return path.join(electron.app.getPath("userData"), "stdiod-install-stamp.json");
}
function readInstallStamp() {
  try {
    const p = stampPath();
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (typeof parsed.appVersion !== "string" || typeof parsed.binaryPath !== "string") {
      return null;
    }
    return { appVersion: parsed.appVersion, binaryPath: parsed.binaryPath };
  } catch {
    return null;
  }
}
function writeInstallStamp() {
  const stamp = {
    appVersion: electron.app.getVersion(),
    binaryPath: getStdiodBinaryPath()
  };
  try {
    fs.writeFileSync(stampPath(), JSON.stringify(stamp, null, 2), "utf-8");
  } catch (err) {
    console.error("[stdiod] failed to persist install stamp:", err);
  }
}
function getStateFilePath() {
  return path$1.join(os$1.homedir(), ".config", "edison-stdiod", "state.json");
}
function getConfigFilePath() {
  return path$1.join(os$1.homedir(), ".config", "edison-stdiod", "config.toml");
}
async function readStateFile() {
  const filePath = getStateFilePath();
  let stat;
  try {
    stat = await node_fs.promises.stat(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { state: null, ageMs: null };
    }
    throw err;
  }
  const raw = await node_fs.promises.readFile(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return { state: parsed, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return { state: null, ageMs: null };
  }
}
async function configFileExists() {
  try {
    await node_fs.promises.access(getConfigFilePath());
    return true;
  } catch {
    return false;
  }
}
function getClientLogPath() {
  const dir = process.platform === "win32" ? path$1.join(os$1.homedir(), ".local", "state", "edison-stdiod") : path$1.join(os$1.homedir(), "Library", "Logs", "edison-stdiod");
  return path$1.join(dir, "client.log");
}
function stdiodLog(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [stdiod] ${msg}
`;
  try {
    const filePath = getClientLogPath();
    node_fs.mkdirSync(path$1.dirname(filePath), { recursive: true });
    node_fs.appendFileSync(filePath, line);
  } catch {
  }
  console.log(`[stdiod] ${msg}`);
}
const LAUNCHD_LABEL = "watch.edison.stdiod";
const WIN_TASK_BASENAME = "Edison Watch stdiod";
let cachedWinTaskName = null;
function winTaskName() {
  if (cachedWinTaskName) return cachedWinTaskName;
  let name = WIN_TASK_BASENAME;
  try {
    const out = node_child_process.execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true
    }).toString();
    const sid = out.trim().split(",").pop()?.trim().replace(/^"|"$/g, "");
    if (sid && sid.startsWith("S-")) name = `${WIN_TASK_BASENAME} ${sid}`;
  } catch {
  }
  cachedWinTaskName = name;
  return name;
}
let cachedInstalled = null;
const INSTALLED_CACHE_TTL_MS = 5e3;
function dryRun() {
  return process.env.EDISON_DRY_RUN === "1";
}
async function runStdiod(args) {
  const binary = getStdiodBinaryPath();
  return new Promise((resolve, reject) => {
    const child = node_child_process.spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
function fdDiagnostics() {
  try {
    const openFds = node_fs.readdirSync("/dev/fd").length;
    return `openFds=${openFds}`;
  } catch {
    return null;
  }
}
function describeSpawnError(op, err) {
  const e = err;
  const parts = [];
  if (e?.code) parts.push(e.code);
  if (e?.syscall) parts.push(`syscall=${e.syscall}`);
  const fds = fdDiagnostics();
  if (fds) parts.push(fds);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  const message = `${e?.message ?? String(err)}${detail}`;
  stdiodLog(`${op}: spawn failed: ${message}`);
  return { ok: false, errorCode: "spawn_failed", errorMessage: message };
}
function classifyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("permission denied") || s.includes("eacces")) {
    return "permission_denied";
  }
  if (s.includes("not installed")) return "not_installed";
  if (s.includes("missing api key") || s.includes("missing backend url")) {
    return "not_logged_in";
  }
  return "unknown";
}
async function isLaunchAgentLoaded() {
  const now = Date.now();
  if (cachedInstalled && now - cachedInstalled.at < INSTALLED_CACHE_TTL_MS) {
    return cachedInstalled.value;
  }
  const value = await new Promise((resolve) => {
    if (process.platform === "win32") {
      const child2 = node_child_process.spawn("schtasks", ["/query", "/tn", winTaskName()], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true
      });
      child2.on("error", () => resolve(false));
      child2.on("close", (code) => resolve(code === 0));
      return;
    }
    const uid = process.getuid?.() ?? -1;
    if (uid < 0) {
      resolve(false);
      return;
    }
    const child = node_child_process.spawn("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  cachedInstalled = { value, at: Date.now() };
  return value;
}
function invalidateInstalledCache() {
  cachedInstalled = null;
}
async function ensureBinary() {
  if (!stdiodBinaryExists()) {
    const path2 = getStdiodBinaryPath();
    stdiodLog(`binary missing at ${path2}`);
    return {
      ok: false,
      errorCode: "binary_missing",
      errorMessage: `edison-stdiod binary not found at ${path2}`
    };
  }
  return null;
}
async function getStatus() {
  if (dryRun()) {
    return {
      binaryAvailable: true,
      installed: false,
      loggedIn: false,
      state: null,
      stateAgeMs: null
    };
  }
  const binaryAvailable = stdiodBinaryExists();
  const loggedIn = await configFileExists();
  const { state, ageMs } = await readStateFile();
  const installed2 = await isLaunchAgentLoaded();
  return { binaryAvailable, installed: installed2, loggedIn, state, stateAgeMs: ageMs };
}
async function install() {
  if (dryRun()) return { ok: true };
  const missing = await ensureBinary();
  if (missing) return missing;
  invalidateInstalledCache();
  stdiodLog(`install: binary=${getStdiodBinaryPath()}`);
  try {
    const result = await runStdiod(["install"]);
    stdiodLog(
      `install: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ""}`
    );
    if (result.code === 0) {
      writeInstallStamp();
      return { ok: true };
    }
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    };
  } catch (err) {
    return describeSpawnError("install", err);
  }
}
async function login(input) {
  if (dryRun()) return { ok: true };
  const missing = await ensureBinary();
  if (missing) return missing;
  const args = ["login", "--backend", input.backend, "--api-key", input.apiKey];
  if (input.edisonSecretKey) args.push("--edison-secret-key", input.edisonSecretKey);
  if (input.deviceId) args.push("--device-id", input.deviceId);
  if (input.deviceLabel) args.push("--device-label", input.deviceLabel);
  stdiodLog(`login: backend=${input.backend} deviceId=${input.deviceId ?? "(default)"}`);
  try {
    const result = await runStdiod(args);
    stdiodLog(
      `login: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ""}`
    );
    if (result.code === 0) return { ok: true };
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    };
  } catch (err) {
    return describeSpawnError("login", err);
  }
}
async function uninstall(opts = {}) {
  if (dryRun()) return { ok: true };
  const missing = await ensureBinary();
  if (missing) return missing;
  invalidateInstalledCache();
  const args = ["uninstall"];
  if (opts.purge) args.push("--purge");
  stdiodLog(`uninstall: purge=${Boolean(opts.purge)}`);
  try {
    const result = await runStdiod(args);
    stdiodLog(
      `uninstall: exit=${result.code}${result.stderr.trim() ? ` stderr=${result.stderr.trim()}` : ""}`
    );
    if (result.code === 0) return { ok: true };
    return {
      ok: false,
      errorCode: classifyError(result.stderr),
      errorMessage: result.stderr.trim() || `exit ${result.code}`
    };
  } catch (err) {
    return describeSpawnError("uninstall", err);
  }
}
async function resetStdiod(input) {
  if (dryRun()) return { ok: true };
  const missing = await ensureBinary();
  if (missing) return missing;
  const { state } = await readStateFile();
  const deviceId = input.deviceId ?? state?.device_id ?? void 0;
  const deviceLabel = input.deviceLabel ?? state?.device_label ?? void 0;
  stdiodLog(`reset: starting (preserving deviceId=${deviceId ?? "(default)"})`);
  const torn = await uninstall({ purge: true });
  if (!torn.ok) {
    stdiodLog(`reset: teardown failed: ${torn.errorCode ?? ""} ${torn.errorMessage ?? ""}`);
    return torn;
  }
  const signedIn = await login({ ...input, deviceId, deviceLabel });
  if (!signedIn.ok) {
    stdiodLog(`reset: login failed: ${signedIn.errorCode ?? ""} ${signedIn.errorMessage ?? ""}`);
    return signedIn;
  }
  const installed2 = await install();
  if (!installed2.ok) {
    stdiodLog(`reset: install failed: ${installed2.errorCode ?? ""} ${installed2.errorMessage ?? ""}`);
    return installed2;
  }
  invalidateInstalledCache();
  stdiodLog("reset: complete");
  return { ok: true };
}
async function getLogPath() {
  if (dryRun()) return null;
  const logPath = process.platform === "win32" ? path$1.join(os$1.homedir(), ".local", "state", "edison-stdiod", "daemon.log") : `${process.env.HOME}/Library/Logs/edison-stdiod/daemon.log`;
  try {
    await node_fs.promises.access(logPath);
    return logPath;
  } catch {
    return null;
  }
}
function registerStdiodHandlers() {
  electron.ipcMain.handle("stdiod:status", () => getStatus());
  electron.ipcMain.handle("stdiod:install", () => install());
  electron.ipcMain.handle("stdiod:login", (_event, input) => login(input));
  electron.ipcMain.handle("stdiod:uninstall", (_event, opts) => uninstall(opts ?? {}));
  electron.ipcMain.handle("stdiod:reset", (_event, input) => resetStdiod(input));
  electron.ipcMain.handle("stdiod:getLogPath", () => getLogPath());
}
function registerIpcHandlers(deps) {
  const {
    getMainWindow: getMainWindow2,
    getAuthLoopbackUrl: getAuthLoopbackUrl2,
    createTray: createTray2,
    startEventSubscription: startEventSubscription2,
    startQuarantineMonitorIfEnabled: startQuarantineMonitorIfEnabled2,
    startQuarantinePolling: startQuarantinePolling2
  } = deps;
  electron.ipcMain.on("auth:open-saml", (_event, samlUrl) => {
    const mainWindow2 = getMainWindow2();
    const authWindow = new electron.BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      modal: true,
      parent: mainWindow2 || void 0,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    authWindow.loadURL(samlUrl);
    authWindow.webContents.on("did-finish-load", () => {
      const currentUrl = authWindow.webContents.getURL();
      if (currentUrl.includes("access_token=") || currentUrl.includes("code=")) {
        getMainWindow2()?.webContents.send("auth:callback", currentUrl);
        authWindow.close();
      }
    });
    authWindow.webContents.on("will-navigate", (_event2, url2) => {
      if (url2.startsWith("edison-watch://")) {
        getMainWindow2()?.webContents.send("auth:callback", url2);
        authWindow.close();
      }
    });
    authWindow.webContents.on("will-redirect", (_event2, url2) => {
      if (url2.startsWith("edison-watch://")) {
        getMainWindow2()?.webContents.send("auth:callback", url2);
        authWindow.close();
      }
    });
  });
  electron.ipcMain.handle("auth:getLoopbackUrl", () => getAuthLoopbackUrl2());
  electron.ipcMain.handle("config:getActiveEnv", () => getActiveEnv());
  electron.ipcMain.handle("config:getEffectiveBaseUrls", () => {
    const apiBaseUrl = getApiBaseUrl();
    const mcpBaseUrl = getMcpBaseUrl();
    if (!apiBaseUrl)
      console.warn(
        "[config:getEffectiveBaseUrls] apiBaseUrl is null - renderer will have no API URL."
      );
    if (!mcpBaseUrl)
      console.warn(
        "[config:getEffectiveBaseUrls] mcpBaseUrl is null - server health checks will fail."
      );
    return {
      mcpBaseUrl,
      apiBaseUrl,
      docsBaseUrl: ENV_DOCS_URL
    };
  });
  electron.ipcMain.handle("setup:getData", () => {
    return getSetupData();
  });
  electron.ipcMain.on("setup:reached-final", () => {
    createTray2();
  });
  electron.ipcMain.on("setup:complete", (_event, data) => {
    markSetupComplete(data);
    console.log("[setup:complete] Setup data saved");
    startEventSubscription2();
    startHookHealthMonitor();
    injectAllHooks().catch((err) => console.error("[HookInjection] Failed to inject hooks:", err));
    startQuarantineMonitorIfEnabled2().catch(
      (err) => console.error("[Quarantine] Failed to start monitor after setup:", err)
    );
    startQuarantinePolling2();
    const win = getMainWindow2();
    if (win) {
      win.hide();
      setTimeout(() => {
        if (!win.isDestroyed()) win.show();
      }, 500);
    }
  });
  electron.ipcMain.handle("setup:reset", () => {
    markSetupIncomplete();
    return { ok: true };
  });
  electron.ipcMain.handle("setup:update", (_event, data) => {
    markSetupComplete(data);
    return { ok: true };
  });
  electron.ipcMain.handle(
    "secretKey:verify",
    async (_event, args) => {
      const apiBaseUrl = getApiBaseUrl();
      const creds = getCredentialsForEnv();
      if (!apiBaseUrl || !creds?.apiKey) return { ok: false };
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/v1/user/secret-key/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
          body: JSON.stringify({ key: args.key })
        });
        if (!res.ok) return { ok: false };
        const data = await res.json();
        return { ok: true, valid: data.valid, domainValid: data.domain_valid };
      } catch {
        return { ok: false };
      }
    }
  );
  electron.ipcMain.handle("mcp:applyForSecretKey", async (_event, args) => {
    const mcpBaseUrl = getMcpBaseUrl();
    const creds = getCredentialsForEnv();
    if (!mcpBaseUrl || !creds?.apiKey) {
      return { success: false, modifiedConfigs: [] };
    }
    const setup = getSetupData();
    const apps = setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS;
    console.log("[mcp:applyForSecretKey]", apps, DRY_RUN ? "(dry-run)" : "");
    return await applyAppIntegrations({
      serverAddress: setup.serverAddress ?? "",
      mcpBaseUrl,
      apiKey: creds.apiKey,
      edisonSecretKey: args.edisonSecretKey,
      apps,
      dryRun: DRY_RUN
    });
  });
  electron.ipcMain.handle("accounts:list", () => {
    return getSavedAccounts().map(({ userId, userEmail, savedAt }) => ({
      userId,
      userEmail,
      savedAt
    }));
  });
  electron.ipcMain.handle("accounts:switch", async (_event, userId) => {
    const current = getSetupData();
    if (current.userId === userId) return { ok: true };
    const data = switchToAccount(userId);
    if (!data) return { ok: false };
    pendingApprovals.clear();
    startEventSubscription2();
    startHookHealthMonitor();
    startQuarantineMonitorIfEnabled2().catch(
      (err) => console.error("[Quarantine] Failed to start monitor on account switch:", err)
    );
    startQuarantinePolling2();
    const newSetup = getSetupData();
    const mcpBaseUrl = getMcpBaseUrl();
    const creds = getCredentialsForEnv();
    if (mcpBaseUrl && creds?.apiKey) {
      try {
        await applyAppIntegrations({
          serverAddress: newSetup.serverAddress ?? "",
          mcpBaseUrl,
          apiKey: creds.apiKey,
          edisonSecretKey: creds.edisonSecretKey,
          apps: (newSetup.configuredApps?.length ? newSetup.configuredApps : ALL_SUPPORTED_APPS).filter((app2) => ALL_SUPPORTED_APPS.includes(app2))
        });
        console.log("[accounts:switch] MCP integrations updated for new account");
      } catch (err) {
        console.error("[accounts:switch] Failed to update MCP integrations:", err);
      }
    }
    return { ok: true };
  });
  electron.ipcMain.handle("accounts:remove", (_event, userId) => {
    try {
      removeAccount(userId);
    } catch {
    }
    return { ok: true };
  });
  electron.ipcMain.handle("approval:approve", async (_event, approvalId) => {
    await handleApproval(approvalId, "approve");
  });
  electron.ipcMain.handle("approval:deny", async (_event, approvalId) => {
    await handleApproval(approvalId, "deny");
  });
  electron.ipcMain.on("approval:resize", (_event, contentHeight) => {
    resizeApprovalWindow(contentHeight);
  });
  electron.ipcMain.handle("menu:check-health", async () => {
    return getIsServerOnline();
  });
  electron.ipcMain.handle("shell:openExternal", async (_event, url2) => {
    await electron.shell.openExternal(url2);
  });
  electron.ipcMain.handle("menu:openFeedback", () => {
    showFeedbackWindow();
  });
  electron.ipcMain.handle("menu:resizeWindow", (_event, width, height) => {
    const mainWindow2 = getMainWindow2();
    if (mainWindow2 && !mainWindow2.isDestroyed()) {
      mainWindow2.setMinimumSize(Math.min(width, 480), Math.min(height, 300));
      mainWindow2.setSize(width, height, true);
      mainWindow2.center();
    }
  });
  electron.ipcMain.handle("menu:getVersion", () => {
    return electron.app.getVersion();
  });
  electron.ipcMain.handle("update:getState", () => getUpdateState());
  electron.ipcMain.handle("update:check", () => checkForUpdates());
  electron.ipcMain.handle("update:download", () => downloadUpdate());
  electron.ipcMain.handle("update:install", () => quitAndInstall());
  electron.ipcMain.handle("update:getSettings", () => getSettings());
  electron.ipcMain.handle(
    "update:setSettings",
    (_event, patch) => updateSettings(patch)
  );
  electron.ipcMain.handle("menu:getMcpConfig", () => {
    return getMcpConfig();
  });
  electron.ipcMain.handle("menu:getMcpUrl", () => {
    return getMcpUrl();
  });
  electron.ipcMain.handle("mcp:detectClients", async () => {
    const clients = [];
    const checks = [
      {
        id: "vscode",
        name: "VS Code",
        getPath: () => Promise.resolve(getVscodeUserMcpPath()),
        detectDir: (configPath) => path.dirname(path.dirname(configPath))
        // ~/Library/Application Support/Code/
      },
      { id: "cursor", name: "Cursor", getPath: () => Promise.resolve(getCursorConfigPath()) },
      {
        id: "claude-code",
        name: "Claude Code",
        getPath: () => Promise.resolve(getClaudeCodeUserSettingsPath())
      },
      {
        id: "claude-desktop",
        name: "Claude Desktop",
        getPath: () => Promise.resolve(getClaudeDesktopConfigPath())
        // detectDir defaults to dirname(configPath) which is what we want:
        // ~/Library/Application Support/Claude/ exists iff Claude Desktop
        // has been launched at least once.
      },
      {
        id: "claude-cowork",
        name: "Claude Cowork",
        getPath: () => Promise.resolve(getClaudeCoworkConfigPath()),
        // Cowork shares the .app bundle and config file with Claude Desktop.
        // The discriminator is `vm_bundles/`, written on first Cowork launch.
        // Pointing detectDir at it makes fs.access fail (and Cowork drop
        // out of the list) when only Desktop has been used.
        detectDir: (configPath) => path.join(path.dirname(configPath), "vm_bundles")
      },
      { id: "windsurf", name: "Windsurf", getPath: () => Promise.resolve(getWindsurfConfigPath()) },
      { id: "zed", name: "Zed", getPath: () => Promise.resolve(getZedConfigPath()) },
      {
        id: "codex",
        name: "Codex",
        getPath: () => Promise.resolve(getCodexConfigPath())
        // Codex is a CLI tool - detected by ~/.codex/ dir (macAppExists returns true for CLI-only clients)
      }
    ];
    for (const check of checks) {
      try {
        const configPath = await check.getPath();
        const checkDir = check.detectDir ? check.detectDir(configPath) : path.dirname(configPath);
        await fs.promises.access(checkDir);
        if (!await macAppExists(check.id)) continue;
        clients.push({ id: check.id, name: check.name, configPath });
      } catch {
      }
    }
    try {
      const jbPaths = await getJetBrainsMcpConfigPaths();
      const nameMap = {
        intellij: "IntelliJ IDEA",
        pycharm: "PyCharm",
        webstorm: "WebStorm"
      };
      for (const { client, path: path2 } of jbPaths) {
        if (!await macAppExists(client)) continue;
        clients.push({ id: client, name: nameMap[client] ?? client, configPath: path2 });
      }
    } catch {
    }
    return clients;
  });
  registerMcpSubmitHandlers();
  registerStdiodHandlers();
  electron.ipcMain.handle("mcp:injectHooks", async () => {
    return await injectAllHooks();
  });
  electron.ipcMain.handle("mcp:removeHooks", async () => {
    return await removeAllHooks();
  });
  electron.ipcMain.handle("mcp:getHookStatus", async () => {
    const claudeCodeMcpStatus = await checkClaudeCodeMcpConnection();
    return await getHookStatus(getMcpUrl(), getIsServerOnline(), claudeCodeMcpStatus);
  });
  electron.ipcMain.handle("mcp:injectVsCodeWorkspaceHook", async (_event, workspacePath) => {
    return await injectVsCodeWorkspaceHook(workspacePath);
  });
  electron.ipcMain.handle("mcp:removeVsCodeWorkspaceHook", async (_event, workspacePath) => {
    return await removeVsCodeWorkspaceHook(workspacePath);
  });
  const keychainFile = path.join(electron.app.getPath("userData"), ".personal-key.enc");
  electron.ipcMain.handle("keychain:save", async (_event, plaintext) => {
    if (!electron.safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: "OS encryption not available" };
    }
    const encrypted = electron.safeStorage.encryptString(plaintext);
    await fs.promises.writeFile(keychainFile, encrypted);
    return { ok: true };
  });
  electron.ipcMain.handle("keychain:load", async () => {
    if (!electron.safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await fs.promises.readFile(keychainFile);
      return electron.safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("keychain:delete", async () => {
    try {
      await fs.promises.unlink(keychainFile);
    } catch {
    }
    return { ok: true };
  });
  electron.ipcMain.handle("debug:runQuarantine", async () => {
    return runDebugQuarantine();
  });
  electron.ipcMain.handle("debug:resetQuarantine", async () => {
    try {
      handleQuarantineDisabled();
      const result = await restoreAllQuarantinedServers();
      return { success: true, restored: result.restored, errors: result.errors };
    } catch (err) {
      return {
        success: false,
        restored: 0,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}
function buildAppMenu$1(deps) {
  const showDeveloperMenu = getBuildDefaultEnv() !== "release";
  const currentEnv = getDebugEnvOverride() ?? getBuildDefaultEnv();
  const envSubmenu = DEBUG_ENV_NAMES.map((name) => ({
    label: name === "dev" ? "dev (localhost)" : name,
    type: "radio",
    checked: currentEnv === name,
    click: async () => {
      setDebugEnvOverride(name);
      deps.logEnvConfig(`switch→${name}`);
      deps.updateAppMenu();
      deps.getMainWindow()?.webContents.send("env:changed", name);
      const setup = getSetupData();
      const mcpBaseUrl = getMcpBaseUrl();
      const creds = getCredentialsForEnv(name);
      if (mcpBaseUrl && creds?.apiKey) {
        try {
          await applyAppIntegrations({
            serverAddress: setup.serverAddress ?? "",
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: creds.edisonSecretKey,
            apps: setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
          });
          deps.slog(`[env:switch] MCP integrations updated for ${name}`);
        } catch (err) {
          deps.slog(`[env:switch] Failed to update MCP integrations: ${err}`);
        }
      } else if (mcpBaseUrl && !creds?.apiKey) {
        deps.slog(`[env:switch] No API key stored for env "${name}" - MCP integrations not updated`);
      }
      startServerStatusChecks(deps.updateTrayMenu);
    }
  }));
  const devSubmenu = [
    { label: "Switch Environment", submenu: envSubmenu },
    { type: "separator" },
    { label: "Clear App Data & Restart", click: () => deps.handleClearDataAndRestart() }
  ];
  const developerItem = { label: "Developer", submenu: devSubmenu };
  const template = [
    ...process.platform === "darwin" ? [
      {
        label: electron.app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          ...showDeveloperMenu ? [developerItem, { type: "separator" }] : [],
          { role: "quit" }
        ]
      }
    ] : [],
    { label: "Actions", submenu: deps.buildTrayMenuItems() },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        ...process.platform !== "darwin" && showDeveloperMenu ? [{ type: "separator" }, developerItem] : []
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...process.platform === "darwin" ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]
      ]
    }
  ];
  return electron.Menu.buildFromTemplate(template);
}
let cached = {
  binaryAvailable: false,
  installed: false,
  loggedIn: false,
  state: null,
  stateAgeMs: null
};
let refreshTimer = null;
function getCachedStdiodStatus() {
  return cached;
}
function statusFingerprint(s) {
  const { stateAgeMs: _ageMs, ...rest } = s;
  return JSON.stringify(rest);
}
async function refreshStdiodStatusCache() {
  try {
    cached = await getStatus();
  } catch {
  }
  return cached;
}
function startStdiodStatusCacheRefresh(intervalMs, onUpdate) {
  if (refreshTimer) return;
  refreshStdiodStatusCache().then(() => onUpdate?.());
  refreshTimer = setInterval(async () => {
    const before = statusFingerprint(cached);
    await refreshStdiodStatusCache();
    if (onUpdate && statusFingerprint(cached) !== before) onUpdate();
  }, intervalMs);
}
const CONNECTION_LABELS = {
  starting: "starting",
  connected: "connected",
  reconnecting: "reconnecting",
  needs_reauth: "needs reauth (Sign In)",
  needs_upgrade: "needs upgrade (update Edison Watch)"
};
function buildStdiodMenuItems(trayIconPath2, onReset) {
  const status = getCachedStdiodStatus();
  const items = [];
  if (!status.binaryAvailable) {
    items.push({ label: "Local tunnel: binary missing", enabled: false });
    return items;
  }
  const buildActions = () => {
    const actions = [
      {
        label: "Open logs folder",
        click: () => {
          const logDir = process.platform === "win32" ? path$1.join(os$1.homedir(), ".local", "state", "edison-stdiod") : path$1.join(os$1.homedir(), "Library", "Logs", "edison-stdiod");
          electron.shell.openPath(logDir).catch(() => {
          });
        }
      }
    ];
    if (onReset && (status.installed || status.loggedIn)) {
      actions.push({ label: "Reset Local Tunnel…", click: onReset });
    }
    return actions;
  };
  if (!status.installed) {
    items.push({
      label: status.loggedIn ? "Local tunnel: off" : "Local tunnel: not signed in",
      enabled: false
    });
    if (status.loggedIn) items.push(...buildActions());
    return items;
  }
  const conn = status.state?.connection_state ?? "starting";
  items.push({
    label: `Local tunnel: ${CONNECTION_LABELS[conn] ?? conn}`,
    enabled: false
  });
  if (status.state?.device_id) {
    const deviceId = status.state.device_id;
    const label = status.state.device_label ? `${deviceId} (${status.state.device_label})` : deviceId;
    items.push({
      label: `Device: ${label}`,
      click: () => {
        electron.clipboard.writeText(deviceId);
        if (electron.Notification.isSupported()) {
          new electron.Notification({
            title: "Edison Watch",
            body: "Device ID copied to clipboard",
            ...process.platform !== "darwin" && { icon: trayIconPath2 }
          }).show();
        }
      }
    });
  }
  const servers = status.state?.servers ?? [];
  if (servers.length > 0) {
    const running = servers.filter((s) => s.state === "running").length;
    items.push({
      label: `Tunneled servers: ${running}/${servers.length} running`,
      enabled: false
    });
  }
  if (status.state?.last_error) {
    items.push({ label: `Last error: ${status.state.last_error}`, enabled: false });
  }
  items.push(...buildActions());
  return items;
}
const PLIST_RELATIVE_PATH = "Library/LaunchAgents/watch.edison.stdiod.plist";
function computeRefreshReason(input) {
  const { stamp, appVersion, binaryPath, plistBody } = input;
  if (plistBody === null) return "LaunchAgent loaded but plist unreadable";
  if (!plistBody.includes(binaryPath)) return "plist points at a different binary path";
  if (!stamp) return "no install stamp recorded";
  if (stamp.appVersion !== appVersion) {
    return `app updated ${stamp.appVersion} -> ${appVersion}`;
  }
  if (stamp.binaryPath !== binaryPath) return "bundle path changed since last install";
  return null;
}
async function readPlistBody() {
  try {
    return await node_fs.promises.readFile(path$1.join(os$1.homedir(), PLIST_RELATIVE_PATH), "utf-8");
  } catch {
    return null;
  }
}
async function maybeRefreshStdiodInstall() {
  if (process.platform !== "darwin") return;
  if (process.env.EDISON_DRY_RUN === "1") return;
  if (!electron.app.isPackaged && !process.env.EW_STDIOD_REFRESH_TEST) return;
  if (!stdiodBinaryExists()) return;
  if (!await isLaunchAgentLoaded()) return;
  const reason = computeRefreshReason({
    stamp: readInstallStamp(),
    appVersion: electron.app.getVersion(),
    binaryPath: getStdiodBinaryPath(),
    plistBody: await readPlistBody()
  });
  if (!reason) return;
  stdiodLog(`install refresh: ${reason}; re-running install to restart the daemon`);
  const result = await install();
  if (result.ok) {
    stdiodLog("install refresh: daemon restarted on current binary");
  } else {
    stdiodLog(
      `install refresh failed: ${result.errorCode ?? "unknown"} ${result.errorMessage ?? ""}`.trim()
    );
  }
}
function notify(body, trayIconPath2) {
  if (!electron.Notification.isSupported()) return;
  new electron.Notification({
    title: "Edison Watch",
    body,
    ...process.platform !== "darwin" && { icon: trayIconPath2 }
  }).show();
}
function notifyChanged(deps) {
  deps.getMainWindow()?.webContents.send("stdiod:changed");
}
async function waitForConnected(deps, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await refreshStdiodStatusCache().catch(() => null);
    deps.updateTrayMenu();
    notifyChanged(deps);
    if (status?.state?.connection_state === "connected") return true;
  }
  return false;
}
async function handleStdiodReset(deps) {
  const { trayIconPath: trayIconPath2 } = deps;
  const apiBaseUrl = getApiBaseUrl();
  const creds = getCredentialsForEnv();
  if (!apiBaseUrl || !creds?.apiKey) {
    notify("Sign in to Edison Watch before resetting the local tunnel.", trayIconPath2);
    return;
  }
  const choice = electron.dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Reset", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Reset Local Tunnel",
    message: "Reset the local stdio tunnel daemon?",
    detail: "This stops the daemon, wipes its local config, state, and logs, then re-registers and restarts it with your current credentials. Tunneled servers reconnect automatically. Use this if the tunnel is stuck or failed to start."
  });
  if (choice !== 0) return;
  notify("Resetting local tunnel…", trayIconPath2);
  deps.getMainWindow()?.webContents.send("stdiod:resetting");
  try {
    const result = await resetStdiod({
      backend: apiBaseUrl,
      apiKey: creds.apiKey,
      edisonSecretKey: creds.edisonSecretKey
    });
    await refreshStdiodStatusCache().catch(() => {
    });
    deps.updateTrayMenu();
    notifyChanged(deps);
    if (!result.ok) {
      notify(
        `Local tunnel reset failed: ${result.errorMessage ?? result.errorCode ?? "unknown error"}`,
        trayIconPath2
      );
      return;
    }
    const connected = await waitForConnected(deps, 25e3);
    notify(
      connected ? "Local tunnel reconnected." : "Local tunnel reset. Still reconnecting in the background…",
      trayIconPath2
    );
  } catch (err) {
    notifyChanged(deps);
    notify(
      `Local tunnel reset failed: ${err instanceof Error ? err.message : String(err)}`,
      trayIconPath2
    );
  }
}
const appIconPath = path.join(__dirname, "../../resources/icon.png");
const winIconPath = path.join(__dirname, "../../resources/icon.ico");
installMonitorTee();
const LOG_FILE = path.join(os.tmpdir(), "ew-startup.log");
function slog(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
  }
  console.log(msg);
}
const is = {
  get dev() {
    return !electron.app.isPackaged;
  }
};
const electronApp = {
  setAppUserModelId: (id) => {
    if (process.platform === "win32") electron.app.setAppUserModelId(electron.app.isPackaged ? id : process.execPath);
  }
};
let mainWindow = null;
let tray = null;
let approvalWindow = null;
let isRestarting = false;
function startEventSubscription() {
  startEventSubscription$1(handleQuarantineEnabled, handleQuarantineDisabled, () => {
    pollQuarantineConfig().catch(() => {
    });
  });
}
function buildTrayMenuItems() {
  const setupData = getSetupData();
  const pendingCount = pendingApprovals.size;
  const userDisplayName = setupData.userEmail || "Not signed in";
  const items = [
    { label: "Open Edison Watch", click: () => showMainWindow() },
    { type: "separator" },
    { label: "Enabled", type: "checkbox", checked: true, click: () => {
    } },
    { label: getIsServerOnline() ? "Backend: Connected" : "Backend: Disconnected", enabled: false },
    {
      label: isSseConnected() ? "Live updates: Connected" : "Live updates: Disconnected",
      enabled: false
    },
    { label: userDisplayName, enabled: false },
    { type: "separator" },
    {
      label: pendingCount > 0 ? `Pending Approvals (${pendingCount})` : "No Pending Approvals",
      enabled: pendingCount > 0,
      click: pendingCount > 0 ? () => showPendingApprovalsDialog() : void 0
    },
    {
      label: "Register MCP Servers",
      enabled: Boolean(
        getCredentialsForEnv()?.apiKey && (setupData.apiBaseUrl || setupData.serverAddress)
      ),
      click: async () => {
        let isAdminOrOwner = false;
        const apiBaseUrl = getApiBaseUrl();
        const envCreds = getCredentialsForEnv();
        if (apiBaseUrl && envCreds?.apiKey) {
          const role = await fetchUserRole(apiBaseUrl, envCreds.apiKey);
          isAdminOrOwner = role === "admin" || role === "owner";
        }
        showServerRegistrationDialog(mainWindow ?? void 0, isAdminOrOwner);
      }
    },
    {
      label: "Open Dashboard",
      enabled: Boolean(getApiBaseUrl()),
      click: () => {
        const dashboardUrl = getApiBaseUrl();
        if (dashboardUrl) electron.shell.openExternal(dashboardUrl);
      }
    },
    { type: "separator" },
    {
      label: "Copy EdisonWatch MCP config",
      enabled: Boolean(getMcpUrl()),
      click: () => {
        const mcpConfig = getMcpConfig();
        if (mcpConfig) {
          electron.clipboard.writeText(mcpConfig);
          if (electron.Notification.isSupported()) {
            const n = new electron.Notification({
              title: "Edison Watch",
              body: "MCP config copied - paste into VSCode, Cursor, or your MCP client",
              ...process.platform !== "darwin" && { icon: trayIconPath }
            });
            n.show();
          }
        }
      }
    },
    {
      label: "Copy MCP URL",
      enabled: Boolean(getMcpUrl()),
      click: () => {
        const url2 = getMcpUrl();
        if (url2) {
          electron.clipboard.writeText(url2);
          if (electron.Notification.isSupported()) {
            const n = new electron.Notification({
              title: "Edison Watch",
              body: "MCP URL copied to clipboard",
              ...process.platform !== "darwin" && { icon: trayIconPath }
            });
            n.show();
          }
        }
      }
    },
    { type: "separator" },
    ...buildStdiodMenuItems(trayIconPath, () => {
      void handleStdiodReset({
        getMainWindow: () => mainWindow,
        updateTrayMenu,
        trayIconPath
      });
    }),
    { type: "separator" },
    { label: getHookStatusLabel(), enabled: false },
    {
      label: getAutoQuarantineEnabled() ? "MCP Auto-Quarantine: Enabled" : "MCP Auto-Quarantine: Disabled",
      enabled: false
    }
  ];
  const pendingVersion = getPendingUpdateVersion();
  if (isUpdateDownloaded() && pendingVersion) {
    items.push({
      label: `Restart to update (v${pendingVersion})`,
      click: () => quitAndInstall()
    });
  } else if (pendingVersion) {
    items.push({
      label: `Download update (v${pendingVersion})`,
      click: () => {
        downloadUpdate().catch((err) => console.error("[update] download failed:", err));
        updateTrayMenu();
      }
    });
  } else {
    items.push({
      label: "Check for Updates",
      click: async () => {
        const state = await checkForUpdates();
        if (electron.Notification.isSupported()) {
          if (state.version && state.status !== "idle" && state.status !== "error") {
            new electron.Notification({
              title: "Edison Watch",
              body: `Version ${state.version} is available.`,
              ...process.platform !== "darwin" && { icon: trayIconPath }
            }).show();
          } else if (state.status === "error") {
            new electron.Notification({
              title: "Edison Watch",
              body: "Update check failed. Please check your connection.",
              ...process.platform !== "darwin" && { icon: trayIconPath }
            }).show();
          } else {
            new electron.Notification({
              title: "Edison Watch",
              body: "You're already on the latest version.",
              ...process.platform !== "darwin" && { icon: trayIconPath }
            }).show();
          }
        }
        updateTrayMenu();
      }
    });
  }
  items.push(
    { type: "separator" },
    {
      label: "Debug Window",
      click: () => showDebugWindow(mainWindow ?? void 0)
    },
    { type: "separator" },
    {
      label: "Re-run Setup Wizard",
      click: () => rerunWizard()
    },
    {
      label: "Clear App Data & Restart",
      click: () => handleClearDataAndRestart()
    },
    {
      label: "Update Keys",
      click: () => showUpdateKeysWindow(
        getSetupData,
        (key) => markSetupComplete({ edisonSecretKey: key }),
        async (compositeKey) => {
          const setup = getSetupData();
          const mcpBaseUrl = getMcpBaseUrl();
          const creds = getCredentialsForEnv();
          setup.serverAddress ?? "";
          if (!mcpBaseUrl || !creds?.apiKey) return;
          await applyAppIntegrations({
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: compositeKey,
            apps: setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS
          });
        }
      )
    },
    {
      label: "Send Feedback",
      click: () => showFeedbackWindow()
    },
    {
      label: "Sign Out",
      click: () => handleLogoutAndRestart()
    },
    {
      label: "Quit",
      click: () => electron.app.quit()
    }
  );
  return items;
}
function buildTrayMenu() {
  return electron.Menu.buildFromTemplate(buildTrayMenuItems());
}
function createTray() {
  if (tray) {
    updateTrayMenu();
    return;
  }
  let trayIconToUse = trayIconPath;
  if (process.platform === "win32") {
    const img = electron.nativeImage.createFromPath(appIconPath);
    trayIconToUse = img.resize({ width: 16, height: 16 });
  }
  tray = new electron.Tray(trayIconToUse);
  tray.setToolTip("Edison Watch");
  const showMenu = () => {
    if (!tray) return;
    refreshStdiodStatusCache().catch(() => {
    });
    tray.popUpContextMenu(buildTrayMenu());
  };
  tray.on("click", process.platform === "darwin" ? showMenu : showMainWindow);
  tray.on("right-click", showMenu);
  startServerStatusChecks(updateTrayMenu);
  startStdiodStatusCacheRefresh(1e4, updateTrayMenu);
  if (process.platform === "darwin" && electron.app.dock?.setMenu) {
    electron.app.dock.setMenu(buildTrayMenu());
  }
}
function updateTrayMenu() {
  if (tray && process.platform === "darwin" && electron.app.dock?.setMenu) {
    electron.app.dock.setMenu(buildTrayMenu());
  }
  updateAppMenu();
}
function buildAppMenu() {
  return buildAppMenu$1({
    getMainWindow: () => mainWindow,
    updateAppMenu,
    updateTrayMenu,
    logEnvConfig,
    slog,
    handleClearDataAndRestart,
    buildTrayMenuItems
  });
}
function updateAppMenu() {
  electron.Menu.setApplicationMenu(buildAppMenu());
}
async function rerunWizard() {
  markSetupIncomplete();
  isRestarting = true;
  electron.BrowserWindow.getAllWindows().forEach((w) => w.destroy());
  await electron.session.defaultSession.clearStorageData({
    storages: ["localstorage", "cookies", "indexdb"]
  });
  isRestarting = false;
  createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setMinimumSize(400, 500);
    mainWindow.setSize(540, 760, true);
    mainWindow.center();
  }
}
function stopAllServices() {
  stopServerStatusChecks();
  stopUpdateManager();
  stopEventSubscription();
  stopHookHealthMonitor();
  stopQuarantineMonitor();
  stopQuarantinePolling();
  pendingApprovals.clear();
}
async function handleLogoutAndRestart() {
  console.log("[Logout] Signing out...");
  stopAllServices();
  await uninstall({ purge: false }).catch(() => {
  });
  markSetupIncomplete();
  updateTrayMenu();
  await rerunWizard();
}
const CLEAR_DATA_FILES = [
  "setup.json",
  "accounts.json",
  ".personal-key.enc",
  "edison_debug_env.json",
  "seen-servers.json"
];
async function handleClearDataAndRestart() {
  const { response } = await electron.dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Clear & Restart"],
    defaultId: 0,
    cancelId: 0,
    title: "Clear App Data",
    message: "This will delete all local config files and restart the app. This cannot be undone."
  });
  if (response !== 1) return;
  const userDataPath = electron.app.getPath("userData");
  slog(`[clear-data] Clearing app data at: ${userDataPath}`);
  stopAllServices();
  await uninstall({ purge: true }).catch(() => {
  });
  slog("[clear-data] Tore down stdiod daemon");
  for (const file of CLEAR_DATA_FILES) {
    try {
      fs.unlinkSync(path.join(userDataPath, file));
      slog(`[clear-data] Removed ${file}`);
    } catch {
    }
  }
  await electron.session.defaultSession.clearStorageData();
  slog("[clear-data] Relaunching app...");
  electron.app.relaunch();
  electron.app.exit(0);
}
function createWindow() {
  slog("createWindow: start");
  electron.nativeTheme.themeSource = "dark";
  const mainWindowState = windowStateKeeper({
    defaultWidth: 461,
    defaultHeight: 605
  });
  mainWindow = new electron.BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 400,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    // Match the renderer's dark background to avoid a white flash before paint.
    backgroundColor: "#1C1C1C",
    ...process.platform === "win32" ? { icon: winIconPath } : {},
    ...process.platform === "linux" ? { icon: path.join(__dirname, "../../build/icon.png") } : {},
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindowState.manage(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("ready-to-show", () => {
    slog("ready-to-show, showing window");
    mainWindow?.show();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    slog("did-finish-load");
    logEnvConfig("startup");
    flushBufferedAuthCallback();
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_e, code, desc) => slog(`did-fail-load code=${code} desc=${desc}`)
  );
  mainWindow.webContents.on(
    "render-process-gone",
    (_e, d) => slog(`render-process-gone reason=${d.reason} code=${d.exitCode}`)
  );
  if (process.env.EDISON_DEBUG_RENDERER === "true") {
    mainWindow.webContents.on("console-message", (_e, level, message) => {
      slog(`[renderer:${level}] ${message}`);
    });
  }
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl.includes("/auth/callback") || navigationUrl.includes("code=")) {
      event.preventDefault();
      deliverAuthCallback(navigationUrl, "will-navigate");
    }
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}
const gotSingleInstanceLock = initDeepLinkAuth({
  getMainWindow: () => mainWindow,
  showMainWindow,
  log: slog
});
initSentry();
function logEnvConfig(context) {
  const msg = `[env:${context}] activeEnv=${getActiveEnv()} buildEnv=${getBuildDefaultEnv()} apiBaseUrl=${getApiBaseUrl()} mcpBaseUrl=${getMcpBaseUrl()} VITE_API_BASE_URL=${""} VITE_MCP_BASE_URL=${""}`;
  slog(msg);
  mainWindow?.webContents.executeJavaScript(`console.log(${JSON.stringify(msg)})`).catch(() => {
  });
}
slog("module loaded, waiting for app.whenReady");
initQuarantineManager(updateTrayMenu, () => mainWindow);
setSseStatusCallback(updateTrayMenu);
initApprovalsHandler(
  () => mainWindow,
  () => approvalWindow,
  (w) => {
    approvalWindow = w;
  },
  updateTrayMenu
);
electron.app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  slog("app.whenReady fired");
  electronApp.setAppUserModelId("com.edisonwatch.desktop");
  updateAppMenu();
  try {
    await Promise.race([
      startAuthLoopbackServer(() => mainWindow),
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error("auth loopback server listen timeout")), 5e3)
      )
    ]);
    slog(`auth loopback server listening at ${getAuthLoopbackUrl() ?? "(unknown)"}`);
  } catch (err) {
    slog(`auth loopback server failed to start; falling back to edison-watch://: ${err}`);
    console.error("[App] Auth loopback server failed to start, falling back to protocol:", err);
  }
  electron.app.on("browser-window-created", (_, window2) => {
  });
  slog("calling registerIpcHandlers");
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getAuthLoopbackUrl: () => getAuthLoopbackUrl(),
    createTray,
    startEventSubscription,
    startQuarantineMonitorIfEnabled,
    startQuarantinePolling
  });
  slog("registerIpcHandlers ok");
  electron.ipcMain.handle("app:clearDataAndRestart", () => handleClearDataAndRestart());
  initUpdateManager({ onStateChange: updateTrayMenu, getMainWindow: () => mainWindow });
  maybeRefreshStdiodInstall().catch((err) => console.error("[Stdiod] install refresh failed:", err));
  if (isSetupComplete()) {
    slog("setup complete, creating tray");
    createTray();
    startEventSubscription();
    startHookHealthMonitor();
    await injectAllHooks().catch((err) => console.error("[HookInjection] Failed:", err));
    await warmOrgIdCacheOnStartup();
    startQuarantineMonitorIfEnabled().catch((err) => console.error("[Quarantine] Failed:", err));
    startQuarantinePolling();
    const setup = getSetupData();
    const mcpBaseUrl = getMcpBaseUrl();
    const creds = getCredentialsForEnv();
    if (mcpBaseUrl && creds?.apiKey) {
      const rawApps = setup.configuredApps?.length ? setup.configuredApps : ALL_SUPPORTED_APPS;
      let configuredApps = rawApps.filter((app2) => ALL_SUPPORTED_APPS.includes(app2));
      const migrations = setup.appliedMigrations ?? [];
      if (!migrations.includes("codex-backfill") && !configuredApps.includes("codex") && isCodexInstalled()) {
        slog("startup: backfilling codex into configuredApps");
        configuredApps = [...configuredApps, "codex"];
        markSetupComplete({ configuredApps, appliedMigrations: [...migrations, "codex-backfill"] });
      } else if (!migrations.includes("codex-backfill")) {
        markSetupComplete({ appliedMigrations: [...migrations, "codex-backfill"] });
      }
      if (configuredApps.includes("claude-code")) {
        checkClaudeCodeMcpConnection().then(async (status) => {
          if (status === "connected") {
            slog("startup: Claude Code MCP already connected, skipping re-registration");
            return;
          }
          slog(`startup: Claude Code MCP status is "${status}", re-registering`);
          await applyAppIntegrations({
            serverAddress: setup.serverAddress ?? "",
            mcpBaseUrl,
            apiKey: creds.apiKey,
            edisonSecretKey: creds.edisonSecretKey,
            apps: ["claude-code"]
          });
          slog("startup: Claude Code MCP re-registration complete");
        }).catch(
          (err) => console.error("[Startup] Failed to check/re-register Claude Code MCP:", err)
        );
      }
      const expectedUrl = `${mcpBaseUrl.replace(/\/$/, "")}/mcp/${creds.apiKey}/`;
      findAppsNeedingReRegistration(configuredApps, expectedUrl).then(async (missingApps) => {
        if (missingApps.length === 0) {
          slog("startup: all configured apps have edison-watch registered");
          return;
        }
        slog(`startup: edison-watch missing from ${missingApps.join(", ")}, re-registering`);
        await applyAppIntegrations({
          serverAddress: setup.serverAddress ?? "",
          mcpBaseUrl,
          apiKey: creds.apiKey,
          edisonSecretKey: creds.edisonSecretKey,
          apps: missingApps
        });
        slog(`startup: re-registered edison-watch for ${missingApps.join(", ")}`);
      }).catch(
        (err) => console.error("[Startup] Failed to check/re-register app MCP configs:", err)
      );
      findAppsMissingClientTag(configuredApps).then(async (apps) => {
        if (apps.length === 0) return;
        slog(`startup: adding client tag to ${apps.join(", ")}`);
        await applyAppIntegrations({
          serverAddress: setup.serverAddress ?? "",
          mcpBaseUrl,
          apiKey: creds.apiKey,
          edisonSecretKey: creds.edisonSecretKey,
          apps
        });
        slog(`startup: client tag migration done for ${apps.join(", ")}`);
      }).catch((err) => console.error("[Startup] client tag migration failed:", err));
    }
    slog("tray/subscription/monitor ok");
  } else {
    slog("setup not complete");
  }
  slog("calling createWindow");
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !isRestarting && !tray) {
    electron.app.quit();
  }
});
