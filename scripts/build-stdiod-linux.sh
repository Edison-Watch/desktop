#!/usr/bin/env bash
# Build edison-stdiod for Linux (x64 + arm64) and stage it into
# client_2/bin/stdiod/<arch>/ so a (future) linux.extraResources rule can copy
# the matching-arch binary into the packaged app - and so the binary can be
# shipped standalone (the CLI-first Linux story).
#
# Why static musl: targeting *-unknown-linux-musl produces a fully static
# binary with ZERO glibc dependency, so the same file runs on any Linux distro
# (Debian, Fedora, Arch, Alpine, containers) without a per-distro build or a
# glibc-version floor. This is the most distro-agnostic artifact possible.
#
# Why cargo-zigbuild: rustls pulls in `ring`, whose C-crypto needs a real C
# cross-toolchain. zig (via cargo-zigbuild) supplies one with no system cross
# packages, exactly as we already do for the Windows gnullvm target
# (see build-stdiod-win.sh). Works from macOS or Linux hosts.
#
# Usage:  bash scripts/build-stdiod-linux.sh            # both arches
#         TARGET_ARCHES="x64" bash scripts/build-stdiod-linux.sh   # one arch
#
# For official release builds, native Linux CI (ubuntu, oldest supported) is
# also fine and avoids the zig dependency; this script is for local/dev builds
# and cross-building from a Mac.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLIENT_DIR/.." && pwd)"
STDIOD_DIR="$REPO_ROOT/stdiod"
OUT_ROOT="$CLIENT_DIR/bin/stdiod"

command -v zig >/dev/null 2>&1 || {
  echo "build-stdiod-linux.sh: zig required (brew install zig / see ziglang.org)" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null 2>&1 || {
  echo "build-stdiod-linux.sh: cargo-zigbuild required (cargo install cargo-zigbuild)" >&2; exit 1; }

# electron-builder ${arch} : rust musl target
ALL_SPECS=("x64:x86_64-unknown-linux-musl" "arm64:aarch64-unknown-linux-musl")
WANT="${TARGET_ARCHES:-x64 arm64}"

# Validate requested arches up front. An unknown token (typo, or an unsupported
# value like "amd64") would otherwise be silently skipped by the per-arch filter
# below, letting the script exit 0 after building nothing (or only a subset) and
# leaving bin/stdiod incomplete for electron-builder. Parse into an array so a
# whitespace-only TARGET_ARCHES (which ${:-} does NOT default, since it is not
# empty) collapses to zero tokens and is rejected here rather than silently
# building nothing.
read -ra WANT_ARCHES <<< "$WANT"
if [ ${#WANT_ARCHES[@]} -eq 0 ]; then
  echo "build-stdiod-linux.sh: TARGET_ARCHES requests no architectures" >&2; exit 1
fi
KNOWN_ARCHES=""
for spec in "${ALL_SPECS[@]}"; do KNOWN_ARCHES="$KNOWN_ARCHES ${spec%%:*}"; done
for arch in "${WANT_ARCHES[@]}"; do
  case " $KNOWN_ARCHES " in
    *" $arch "*) ;;
    *) echo "build-stdiod-linux.sh: unsupported arch '$arch' in TARGET_ARCHES (supported:$KNOWN_ARCHES)" >&2; exit 1 ;;
  esac
done

for spec in "${ALL_SPECS[@]}"; do
  arch="${spec%%:*}"
  target="${spec##*:}"
  case " $WANT " in *" $arch "*) ;; *) continue ;; esac

  if ! rustup target list --installed | grep -q "^${target}\$"; then
    echo "Installing rustup target $target ..."
    rustup target add "$target"
  fi
  echo "Building edison-stdiod for $target ..."
  ( cd "$STDIOD_DIR" && cargo zigbuild --release --target "$target" --bin edison-stdiod )
  mkdir -p "$OUT_ROOT/$arch"
  cp "$STDIOD_DIR/target/$target/release/edison-stdiod" "$OUT_ROOT/$arch/edison-stdiod"
  chmod +x "$OUT_ROOT/$arch/edison-stdiod"
  echo "Staged -> $OUT_ROOT/$arch/edison-stdiod"
done

echo "Done. Linux daemon binaries staged under $OUT_ROOT/<arch>/"
