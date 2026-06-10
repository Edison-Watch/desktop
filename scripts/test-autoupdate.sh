#!/usr/bin/env bash
#
# Local end-to-end auto-update test - no pushing, no R2.
#
# Builds the app, serves it over a local HTTP feed advertising a higher version,
# and launches it so you can drive check -> download -> install -> relaunch.
#
# macOS reality: applying an update REQUIRES a real Developer-ID signature -
# Squirrel hard-crashes (Trace/BPT trap) on an unsigned/ad-hoc update. So:
#   - With a "Developer ID Application" cert (default): the app is signed and the
#     WHOLE flow works, install included. One build; the served "update" is the
#     same bits re-advertised as a higher version, so it installs and relaunches
#     but the version number stays the same.
#   - EW_TEST_REAL=1: two signed builds at consecutive versions, so the relaunch
#     shows a genuinely higher version (slower - signs the bundle twice).
#   - No cert: an ad-hoc build is made so you can see check/download/banner, but
#     DO NOT click "Restart to update" - it will crash. Get a cert to test it.
#
# Build time is ~60-120s (electron-builder copies Electron + asar + signs the
# bundle); that is the floor in this monorepo, it is not stuck.
#
# Knobs:  PORT=8420   EW_TEST_USERDATA=/path (isolate config in a dir)
#
set -euo pipefail
cd "$(dirname "$0")/.." # -> client_2

PORT="${PORT:-8420}"
WORK="/tmp/ew-autoupdate"
FEED="$WORK/feed"
APP="$WORK/base/Edison Watch.app"
BASE_VER="99.9.9-test.1"
NEXT_VER="99.9.9-test.2"
REAL_TWO="${EW_TEST_REAL:-0}"

rm -rf "$WORK" dist-test-base dist-test-next
mkdir -p "$FEED" "$WORK/base"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  BUILD_ENV=(CSC_IDENTITY_AUTO_DISCOVERY=true)
  # timestamp=none skips the slow per-file Apple TSA round-trips; electronLanguages
  # trims the bundle (fewer files to copy + sign). Both safe for a test build.
  BUILD_ARGS=(-c.mac.notarize=false -c.mac.timestamp=none -c.electronLanguages=en)
  echo "==> Signed (Developer ID). Full flow works, install + relaunch included."
  [ "$REAL_TWO" = "1" ] && echo "    EW_TEST_REAL=1: two builds, relaunch shows a higher version."
else
  REAL_TWO=0
  BUILD_ENV=(CSC_IDENTITY_AUTO_DISCOVERY=false)
  BUILD_ARGS=(-c.mac.notarize=false -c.mac.hardenedRuntime=false -c.electronLanguages=en)
  echo "==> No Developer ID cert: ad-hoc build. check/download/banner work, but DO NOT"
  echo "    click 'Restart to update' - macOS can't apply an unsigned update and the"
  echo "    app will crash. Get a Developer ID cert to test the install."
fi

# electron-builder's `-c.extraMetadata.version` rewrites package.json IN PLACE
# (version + strips scripts/devDeps). Back it up and restore it (before each
# build and on exit) so the test never leaves the working tree dirty.
PKG_BAK="$WORK/package.json.bak"
cp package.json "$PKG_BAK"
restore_pkg() { cp "$PKG_BAK" package.json 2>/dev/null || true; }
trap 'restore_pkg' EXIT

# Shared prep: the version is injected later at the electron-builder step, so the
# JS bundle is identical across builds - build it once.
echo "==> Building app bundle (~60-120s in this monorepo, not stuck)..."
npm run build:stdiod >/dev/null
npx electron-vite build --mode demo >/dev/null

package() { # $1 = version, $2 = output dir
  echo "==> Packaging v$1 - watch the lines below (not stuck)..."
  restore_pkg # start from a pristine package.json each time
  rm -rf "$2"
  if ! env "${BUILD_ENV[@]}" npx electron-builder --mac zip --arm64 \
    "${BUILD_ARGS[@]}" -c.extraMetadata.version="$1" \
    -c.directories.output="$2" --publish never 2>&1 \
    | grep --line-buffered -vE "duplicate dependency references"; then
    echo "build failed (see output above)" >&2
    exit 1
  fi
}

package "$BASE_VER" dist-test-base
cp -R "dist-test-base/mac-arm64/Edison Watch.app" "$APP"

if [ "$REAL_TWO" = "1" ]; then
  # Real second build so the relaunched app genuinely shows the new version.
  package "$NEXT_VER" dist-test-next
  cp dist-test-next/latest-mac.yml "$FEED"/
  cp dist-test-next/*-mac.zip "$FEED"/
  cp dist-test-next/*.blockmap "$FEED"/ 2>/dev/null || true
else
  # Reuse the build's own zip but advertise a higher version in the manifest, so
  # the app sees an update without a second build. The bits (and signature) are
  # the running app's own, so Squirrel validates and applies it; the version just
  # won't change on relaunch. sha512 still matches the real zip.
  cp dist-test-base/latest-mac.yml "$FEED"/
  cp dist-test-base/*-mac.zip "$FEED"/
  cp dist-test-base/*.blockmap "$FEED"/ 2>/dev/null || true
  sed -i '' "s/^version: ${BASE_VER}\$/version: ${NEXT_VER}/" "$FEED/latest-mac.yml"
fi

echo "==> Serving http://localhost:$PORT:"
ls -1 "$FEED"
(cd "$FEED" && python3 -m http.server "$PORT") >/tmp/ew-autoupdate-server.log 2>&1 &
SERVER_PID=$!

# Launch via LaunchServices (`open`), NOT the raw binary. A raw-launched process
# isn't registered as the app bundle, and Squirrel.Mac's apply does code-signing
# self-checks that ASSERT/SIGTRAP in that case. `open` makes the launch
# production-like. Env vars can't be passed through `open`, so we hand them to
# launchd via `launchctl setenv` (test-only, cleared on exit) - this avoids a
# file-based feed override, which would be a feed-hijack risk in a security app.
launchctl setenv EW_UPDATE_TEST 1
launchctl setenv EW_UPDATE_FEED "http://localhost:$PORT"
trap 'restore_pkg; launchctl unsetenv EW_UPDATE_TEST; launchctl unsetenv EW_UPDATE_FEED; kill $SERVER_PID 2>/dev/null || true' EXIT
restore_pkg # builds are done; make sure the working tree is clean now
sleep 1

echo "==> Launching v$BASE_VER via LaunchServices. Use the tray or in-window banner"
echo "    to check, download, and restart-to-update. Quit any running Edison Watch first."
echo "    (App logs go to Console.app / 'log stream', not this terminal.)"
echo "------------------------------------------------------------------"
# open -W blocks until the (original) app exits, so cleanup runs at the right time.
if [ -n "${EW_TEST_USERDATA:-}" ]; then
  mkdir -p "$EW_TEST_USERDATA"
  open -W "$APP" --args --user-data-dir="$EW_TEST_USERDATA"
else
  open -W "$APP"
fi
