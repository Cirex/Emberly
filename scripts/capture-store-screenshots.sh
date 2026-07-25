#!/usr/bin/env bash
#
# Capture App Store screenshots from the iOS Simulator at Apple's exact sizes.
#
#   scripts/capture-store-screenshots.sh maintenance /path/to/EmberlyMaintenance.app
#   scripts/capture-store-screenshots.sh security    /path/to/EmberlySecurity.app
#
# Output lands in apps/<app>/store/screenshots/<device>/NN_<name>.png, using
# fastlane deliver's naming so `deliver` can upload the directory as-is. EAS
# Metadata does NOT handle screenshots — it covers text and settings only — so
# these are uploaded by fastlane or by hand.
#
# WHY A SCRIPT. Store screenshots have to be recaptured every time the UI moves,
# at exact pixel sizes, across two device classes, for every app. Doing that by
# hand is how you end up shipping a screenshot of a screen that no longer exists,
# or one rejected for being 4px off.
#
# The two device sizes below were verified by capturing from these simulators
# rather than taken from documentation:
#   iPhone 17 Pro Max     -> 1320x2868  (Apple's "6.9 inch" slot)
#   iPad Pro 13-inch (M5) -> 2064x2752  (Apple's "iPad 13 inch" slot)
# Both apps declare supportsTablet, so both need both sets.
#
# The .app must be a SIMULATOR build. A Debug-iphoneos build cannot install here
# — wrong platform slice — which is the first thing that goes wrong.

set -euo pipefail

APP_NAME="${1:-}"
APP_PATH="${2:-}"

if [[ -z "$APP_NAME" || -z "$APP_PATH" ]]; then
  echo "usage: $0 <maintenance|security|manager> <path-to-simulator-.app>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="$REPO_ROOT/apps/$APP_NAME/store/screenshots"

if [[ ! -d "$APP_PATH" ]]; then
  echo "error: no .app at $APP_PATH" >&2
  exit 66
fi

# Refuse a device build early, with the reason. Installing it fails with a much
# less obvious message.
if /usr/libexec/PlistBuddy -c "Print :CFBundleSupportedPlatforms:0" \
     "$APP_PATH/Info.plist" 2>/dev/null | grep -q "iPhoneOS"; then
  echo "error: $APP_PATH is a DEVICE build (CFBundleSupportedPlatforms: iPhoneOS)." >&2
  echo "       The simulator needs a Debug-iphonesimulator build." >&2
  exit 65
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Info.plist")"
echo "app: $APP_NAME  bundle: $BUNDLE_ID"

# device label : simulator name : expected WxH
DEVICES=(
  "iphone-6.9:iPhone 17 Pro Max:1320x2868"
  "ipad-13:iPad Pro 13-inch (M5):2064x2752"
)

# Screens to capture. Deep links would be better than sleeps, but the apps have
# no screenshot-mode entry points yet, so this captures the launch state and
# leaves the rest for a human to drive. Extend as deep links are added.
SHOTS=("01_launch")

udid_for() {
  xcrun simctl list devices available \
    | sed -n "s/^ *$1 (\([A-F0-9-]\{36\}\)).*/\1/p" | head -1
}

for entry in "${DEVICES[@]}"; do
  label="${entry%%:*}"; rest="${entry#*:}"
  sim_name="${rest%%:*}"; expected="${rest##*:}"

  udid="$(udid_for "$sim_name")"
  if [[ -z "$udid" ]]; then
    echo "  skip $label — no simulator named '$sim_name'" >&2
    continue
  fi

  echo "  $label  ($sim_name)"
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true

  xcrun simctl install "$udid" "$APP_PATH"
  xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  # No launch-complete signal exists; give the JS bundle time to render.
  sleep 8

  mkdir -p "$OUT_ROOT/$label"
  for shot in "${SHOTS[@]}"; do
    out="$OUT_ROOT/$label/$shot.png"
    xcrun simctl io "$udid" screenshot --type=png "$out" >/dev/null 2>&1
    w="$(sips -g pixelWidth "$out" | awk '/pixelWidth/{print $2}')"
    h="$(sips -g pixelHeight "$out" | awk '/pixelHeight/{print $2}')"
    got="${w}x${h}"
    if [[ "$got" != "$expected" ]]; then
      echo "    ✗ $shot — got ${got}, App Store expects ${expected}" >&2
      exit 70
    fi
    echo "    ✓ $shot  $got"
  done

  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
done

echo
echo "wrote $OUT_ROOT"
echo "note: only the launch screen is captured automatically. Apple wants 3-10 per"
echo "      device; drive the app to the other screens and re-run, or add deep"
echo "      links and extend SHOTS above."
