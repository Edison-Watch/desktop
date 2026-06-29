#!/usr/bin/env bash
# Build Linux AppImages locally - compact and/or full tray variants, x64 + arm64.
#
# Cross-builds the edison-stdiod daemon (both arches) from the sibling ../stdiod
# checkout, then packages with electron-builder using the static AppImage
# runtime. Each variant gets a distinct artifact name so both can coexist.
#
# Always builds BOTH arches: electron-builder.yml lists arch [x64, arm64] and the
# CLI `--arm64`/`--x64` flags do NOT restrict it when the config lists arches, so
# both daemons must be present. For a single arch, override the config, e.g.
#   npx electron-builder --linux -c.linux.target.0.arch=arm64
#
# Usage:  bash scripts/build-appimage.sh                    # compact + full
#         VARIANTS="compact" bash scripts/build-appimage.sh # one variant
#
# Prereqs: sibling ../stdiod checkout; zig + cargo-zigbuild; musl rustup targets
#          (rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl);
#          `npm install` already run.
#
# Output:  dist/EdisonWatch-<version>-<arch>-<variant>.AppImage
#          (static runtime - no libz.so/libfuse2 needed to launch.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

VARIANTS="${VARIANTS:-compact full}"

echo "==> Cross-building edison-stdiod (x64 + arm64) from ../stdiod"
npm run build:stdiod:linux

for variant in $VARIANTS; do
  # Validate explicitly - an unknown/typo'd variant must fail loudly, not
  # silently fall back to compact while producing a mislabeled artifact.
  case "$variant" in
    compact) compact=1 ;;
    full) compact=0 ;;
    *)
      echo "build-appimage.sh: unknown variant '$variant' (expected: compact | full)" >&2
      exit 1
      ;;
  esac
  echo "==> Building '$variant' AppImages (x64 + arm64, EDISON_TRAY_COMPACT=$compact)"
  EDISON_TRAY_COMPACT=$compact npm run build
  EDISON_TRAY_COMPACT=$compact npx electron-builder --linux \
    -c.appImage.artifactName="EdisonWatch-\${version}-\${arch}-$variant.\${ext}"
done

echo "==> Done. AppImages in dist/:"
ls -1 "$DESKTOP_DIR"/dist/*.AppImage 2>/dev/null || true
