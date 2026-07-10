#!/usr/bin/env bash
# Build the mcp_detector_daemon (edison-detectord) for Apple Silicon (arm64) and
# stage it into desktop/bin/ so electron-builder's mac.extraResources rule copies
# it into Contents/Resources/bin/ of the packaged .app.
#
# Mirrors build-stdiod.sh. The daemon source is the sibling `detectord/` clone
# (edison-client/detectord). The cargo binary is `mcp_detector_daemon`; we stage
# it under the friendlier name `edison-detectord` (matching the stdiod naming).
#
# arm64-only: we no longer build the x86_64 slice or lipo a universal binary.
# NOTE: if electron-builder.yml still sets mac.target: universal, the bundled
# binaries must match — target arm64 there too, or the universal merge fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
DETECTORD_DIR="$REPO_ROOT/detectord"
BIN_NAME="mcp_detector_daemon"
TARGET="aarch64-apple-darwin"
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

if ! rustup target list --installed | grep -q "^${TARGET}\$"; then
  echo "Installing rustup target $TARGET ..."
  rustup target add "$TARGET"
fi

echo "Building $BIN_NAME for $TARGET ..."
( cd "$DETECTORD_DIR" && cargo build --release --bin "$BIN_NAME" --target "$TARGET" )

echo "Staging binary at $OUT_BIN ..."
cp "$DETECTORD_DIR/target/$TARGET/release/$BIN_NAME" "$OUT_BIN"
chmod +x "$OUT_BIN"

echo "Verifying architecture ..."
lipo -info "$OUT_BIN"
