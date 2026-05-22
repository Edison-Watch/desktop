#!/usr/bin/env bash
# Build the edison-stdiod daemon as a universal macOS binary and stage it
# into client_2/bin/ so electron-builder's mac.extraResources rule can copy
# it into Contents/Resources/bin/ of the packaged .app.
#
# Why universal: electron-builder.yml sets mac.target: universal, which
# requires every nested binary inside the .app to also be a universal
# Mach-O - otherwise the universal merge step fails. We build both arches
# with cargo and stitch them with lipo.
#
# Why outside resources/: keeping the staged binary in a top-level bin/
# directory means it does NOT match the default `files` glob (which
# captures resources/**) and so isn't double-included in the asar.
# electron-builder picks it up only via the explicit extraResources rule.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
STDIOD_DIR="$REPO_ROOT/stdiod"
OUT_DIR="$CLIENT_DIR/bin"
OUT_BIN="$OUT_DIR/edison-stdiod"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-stdiod.sh: only supported on macOS (got $(uname -s))" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Ensure both rustup targets are installed. The user's machine usually has
# only the host target by default.
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  if ! rustup target list --installed | grep -q "^${target}\$"; then
    echo "Installing rustup target $target ..."
    rustup target add "$target"
  fi
done

echo "Building edison-stdiod for aarch64-apple-darwin ..."
( cd "$STDIOD_DIR" && cargo build --release --bin edison-stdiod --target aarch64-apple-darwin )

echo "Building edison-stdiod for x86_64-apple-darwin ..."
( cd "$STDIOD_DIR" && cargo build --release --bin edison-stdiod --target x86_64-apple-darwin )

echo "Creating universal binary at $OUT_BIN ..."
lipo -create \
  "$STDIOD_DIR/target/aarch64-apple-darwin/release/edison-stdiod" \
  "$STDIOD_DIR/target/x86_64-apple-darwin/release/edison-stdiod" \
  -output "$OUT_BIN"
chmod +x "$OUT_BIN"

echo "Verifying architectures ..."
lipo -info "$OUT_BIN"
