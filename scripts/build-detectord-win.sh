#!/usr/bin/env bash
# Cross-build mcp_detector_daemon (edison-detectord) for Windows (arm64 + x64)
# from macOS/Linux and stage it into desktop/bin/detectord/<arch>/ so an
# electron-builder win.extraResources rule can copy the matching-arch binary
# into the packaged app. Mirrors build-stdiod-win.sh.
#
# Why gnullvm + cargo-zigbuild: rustls pulls in `ring`, whose C-crypto can't be
# cross-compiled to *-windows-msvc from macOS/Linux. The *-pc-windows-gnullvm
# targets use a GNU-style LLVM/mingw toolchain that `ring` is happy with, and
# zig (via cargo-zigbuild) supplies that C toolchain with no MSVC SDK. gnullvm
# binaries are UCRT/MSVC-ABI compatible and run natively on Windows. For official
# release builds prefer native Windows CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
DETECTORD_DIR="$REPO_ROOT/detectord"
BIN_NAME="mcp_detector_daemon"
OUT_ROOT="$CLIENT_DIR/bin/detectord"

if [[ ! -d "$DETECTORD_DIR" ]]; then
  echo "build-detectord-win.sh: expected the daemon clone at $DETECTORD_DIR" >&2
  exit 1
fi

command -v zig >/dev/null 2>&1 || {
  echo "build-detectord-win.sh: zig required (brew install zig)" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null 2>&1 || {
  echo "build-detectord-win.sh: cargo-zigbuild required (cargo install cargo-zigbuild)" >&2; exit 1; }

# electron-builder ${arch} : rust gnullvm target
for spec in "arm64:aarch64-pc-windows-gnullvm" "x64:x86_64-pc-windows-gnullvm"; do
  arch="${spec%%:*}"
  target="${spec##*:}"
  if ! rustup target list --installed | grep -q "^${target}\$"; then
    echo "Installing rustup target $target ..."
    rustup target add "$target"
  fi
  echo "Building $BIN_NAME for $target ..."
  ( cd "$DETECTORD_DIR" && cargo zigbuild --release --target "$target" --bin "$BIN_NAME" )
  mkdir -p "$OUT_ROOT/$arch"
  cp "$DETECTORD_DIR/target/$target/release/$BIN_NAME.exe" "$OUT_ROOT/$arch/edison-detectord.exe"
  echo "Staged -> $OUT_ROOT/$arch/edison-detectord.exe"
done

echo "Done. Windows daemon binaries staged under $OUT_ROOT/<arch>/"
