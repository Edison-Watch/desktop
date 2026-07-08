#!/usr/bin/env bash
# Build the mcp_detector_daemon (edison-detectord) as a universal macOS binary
# and stage it into desktop/bin/ so electron-builder's mac.extraResources rule
# copies it into Contents/Resources/bin/ of the packaged .app.
#
# Mirrors build-stdiod.sh. The daemon source is the sibling `detectord/` clone
# (edison-client/detectord). The cargo binary is `mcp_detector_daemon`; we stage
# it under the friendlier name `edison-detectord` (matching the stdiod naming).
#
# Why universal: electron-builder.yml sets mac.target: universal, so every
# nested binary must also be universal or the merge fails; we build both arches
# and lipo them.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
DETECTORD_DIR="$REPO_ROOT/detectord"
BIN_NAME="mcp_detector_daemon"
OUT_DIR="$CLIENT_DIR/bin"
OUT_BIN="$OUT_DIR/edison-detectord"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-detectord.sh: only supported on macOS (got $(uname -s))" >&2
  exit 1
fi

if [[ ! -d "$DETECTORD_DIR" ]]; then
  echo "build-detectord.sh: expected the daemon clone at $DETECTORD_DIR" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  if ! rustup target list --installed | grep -q "^${target}\$"; then
    echo "Installing rustup target $target ..."
    rustup target add "$target"
  fi
done

echo "Building $BIN_NAME for aarch64-apple-darwin ..."
( cd "$DETECTORD_DIR" && cargo build --release --bin "$BIN_NAME" --target aarch64-apple-darwin )

echo "Building $BIN_NAME for x86_64-apple-darwin ..."
( cd "$DETECTORD_DIR" && cargo build --release --bin "$BIN_NAME" --target x86_64-apple-darwin )

echo "Creating universal binary at $OUT_BIN ..."
lipo -create \
  "$DETECTORD_DIR/target/aarch64-apple-darwin/release/$BIN_NAME" \
  "$DETECTORD_DIR/target/x86_64-apple-darwin/release/$BIN_NAME" \
  -output "$OUT_BIN"
chmod +x "$OUT_BIN"

echo "Verifying architectures ..."
lipo -info "$OUT_BIN"
