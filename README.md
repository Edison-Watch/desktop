<div align="center">

# Edison Watch — Desktop

**The local control plane for [Edison Watch](https://edison.watch).**
Discover the MCP servers wired into your AI tools, quarantine the risky ones, keep your credentials encrypted, and bridge local servers to the Edison Watch gateway — all from your machine.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform: macOS · Windows · Linux](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey.svg)](#installation)

</div>

<!--
  TODO: add a hero screenshot or GIF of the setup wizard / main view here, e.g.
  <div align="center"><img width="70%" src="resources/screenshot.png" alt="Edison Watch desktop"></div>
-->

> **Status: experimental.** This is early software under active development and has **not** had an independent security audit. The desktop app is a **client for the Edison Watch platform** — it requires an Edison Watch account and connects to the Edison backend. UI, on-disk formats, and behavior may change before a 1.0 release.

## What it does

Modern AI tools (Claude, Cursor, VS Code, and friends) connect to [MCP](https://modelcontextprotocol.io/) servers that can read your files, hold credentials, and reach the network. They're configured in a dozen different places and are easy to lose track of. The Edison Watch desktop app gives you one place to see and control them:

- **Discover** every MCP server configured across the AI clients installed on your machine — no manual inventory.
- **Quarantine** newly-appeared or unapproved servers ("shadow MCPs") before they can run, with a review-and-approve flow.
- **Encrypt** credentials with zero-knowledge keys (personal and organization), so secrets never leave your device in the clear.
- **Bridge** local stdio MCP servers to the Edison Watch gateway through the bundled [`edison-stdiod`](https://github.com/Edison-Watch/stdiod) daemon — a single outbound, no-inbound-ports tunnel — so they're reachable and governed without being exposed.
- **Stay current** with in-app auto-updates.

### Supported AI clients

Claude Code · Claude Desktop · Claude Cowork · Cursor · VS Code · Windsurf · Zed · JetBrains IDEs · Codex

## How it works

The app runs in your menu bar / system tray and supervises the bundled `edison-stdiod` daemon. On first launch a setup wizard walks you through signing in, connecting your installed AI clients, and setting up encryption. From then on it watches your clients' MCP configuration, surfaces changes for review, and keeps the tunnel to the Edison Watch backend healthy.

```
AI clients on your machine ──▶ Edison Watch desktop (discover · quarantine · encrypt)
                                        │
                                        ▼
                              edison-stdiod daemon ──▶  outbound tunnel  ──▶ Edison Watch gateway
```

## Installation

> Prebuilt, signed installers will be published on the [Releases](https://github.com/Edison-Watch/desktop/releases) page. Until then, build from source (below).

| Platform | Format |
| --- | --- |
| macOS | `.dmg` (universal — Apple Silicon + Intel) |
| Windows | `.exe` installer (x64, arm64) |
| Linux | `.AppImage` (x64, arm64) |

## Build from source

You'll need [Node.js 22+](https://nodejs.org/) and npm. The app depends on the [`@edison/shared`](https://github.com/Edison-Watch/shared) package, wired in as a Git submodule, so clone recursively:

```sh
git clone --recurse-submodules https://github.com/Edison-Watch/desktop.git
cd desktop
npm ci
```

(Already cloned without submodules? Run `git submodule update --init --recursive`.)

Then:

```sh
npm run dev          # run the app in development with hot reload
npm run build        # typecheck + build the renderer/main/preload bundles
npm run typecheck    # typecheck only (node + web projects)
npm run test         # unit tests (vitest)
```

Packaging installers also bundles the `edison-stdiod` daemon and per-platform runtimes; see the `build:mac` / `build:win` / `build:linux` scripts in [`package.json`](./package.json) and the helpers under [`scripts/`](./scripts).

## Project structure

```
src/main/        Electron main process — discovery, quarantine, daemon supervision, IPC
src/main/clients/  Per-AI-client adapters (Cursor, VS Code, Claude, …)
src/preload/     Context-isolated bridge
src/renderer/    React 19 UI (setup wizard, views, components)
resources/       Icons, entitlements, bundled assets
scripts/         Build/staging scripts (stdiod, Python, runtimes)
shared/          @edison/shared submodule (UI, auth, config, crypto)
```

## Related repositories

- [**Edison-Watch/stdiod**](https://github.com/Edison-Watch/stdiod) — the `edison-stdiod` tunnel daemon bundled with this app.
- [**Edison-Watch/shared**](https://github.com/Edison-Watch/shared) — shared React components, design tokens, and client utilities (consumed here as a submodule).

## Security

Please **do not** report security issues through public GitHub issues or pull requests. Report privately via the repository's **Security** tab ("Report a vulnerability") or by emailing <security@edison.watch>.

## Contributing

Issues and focused pull requests are welcome. Please keep changes small and run `npm run typecheck` and `npm run test` before opening a PR.

## License

Licensed under the [GNU Affero General Public License v3.0](./LICENSE).
