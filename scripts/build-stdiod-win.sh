#!/usr/bin/env bash
# Cross-build edison-stdiod for Windows (arm64 + x64) from macOS/Linux and stage
# it into client_2/bin/stdiod/<arch>/ so an electron-builder win.extraResources
# rule can copy the matching-arch binary into the packaged app.
#
# Why gnullvm + cargo-zigbuild: rustls pulls in `ring`, whose C-crypto can't be
# cross-compiled to *-windows-msvc from macOS (ring hardcodes bare clang for
# aarch64-windows; cargo-xwin feeds clang-cl /imsvc flags -> incompatible). The
# *-pc-windows-gnullvm targets use a GNU-style LLVM/mingw toolchain that `ring`
# is happy with, and zig (via cargo-zigbuild) supplies that C toolchain with no
# MSVC SDK. gnullvm binaries are UCRT/MSVC-ABI compatible and run natively on
# Windows. For official release builds prefer native Windows CI (see
# .github/workflows/build-stdiod-windows.yaml); this script is for local builds.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
STDIOD_DIR="$REPO_ROOT/stdiod"
OUT_ROOT="$CLIENT_DIR/bin/stdiod"

command -v zig >/dev/null 2>&1 || {
  echo "build-stdiod-win.sh: zig required (brew install zig)" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null 2>&1 || {
  echo "build-stdiod-win.sh: cargo-zigbuild required (cargo install cargo-zigbuild)" >&2; exit 1; }

# electron-builder ${arch} : rust gnullvm target
for spec in "arm64:aarch64-pc-windows-gnullvm" "x64:x86_64-pc-windows-gnullvm"; do
  arch="${spec%%:*}"
  target="${spec##*:}"
  if ! rustup target list --installed | grep -q "^${target}\$"; then
    echo "Installing rustup target $target ..."
    rustup target add "$target"
  fi
  echo "Building edison-stdiod for $target ..."
  ( cd "$STDIOD_DIR" && cargo zigbuild --release --target "$target" --bin edison-stdiod )
  mkdir -p "$OUT_ROOT/$arch"
  cp "$STDIOD_DIR/target/$target/release/edison-stdiod.exe" "$OUT_ROOT/$arch/edison-stdiod.exe"
  echo "Staged -> $OUT_ROOT/$arch/edison-stdiod.exe"
done

echo "Done. Windows daemon binaries staged under $OUT_ROOT/<arch>/"
