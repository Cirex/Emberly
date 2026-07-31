#!/usr/bin/env bash
#
# One front door for shipping any app in this repo.
#
# Usage:
#   scripts/release.sh <app> [options]
#
#   <app>            web | maintenance | security | manager | resident
#   --dry-run        run every check, then stop before shipping anything
#   --submit         mobile only: submit to TestFlight after a successful build
#   --profile <name> mobile only: EAS build profile (default: production)
#   --preview        web only: deploy to a preview URL instead of production
#   --allow-dirty    mobile only: build despite uncommitted changes
#   --skip-env       mobile only: don't sync .env.production into EAS first
#   --yes            don't prompt before the irreversible step
#
# Examples:
#   scripts/release.sh security --dry-run     # what would ship, and from what
#   scripts/release.sh security --submit      # build → TestFlight
#   scripts/release.sh web --preview          # preview deploy
#   scripts/release.sh web                    # production deploy (prompts)
#
# This does not bump versions — that is `bun run version`, deliberately a
# separate step so a release is always shipping a version somebody chose.
set -euo pipefail

APP="${1:-}"
[ -n "$APP" ] || { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift

DRY_RUN=0
ASSUME_YES=0
WEB_TARGET="prod"
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; PASSTHRU+=("$1"); shift ;;
    --yes|-y)   ASSUME_YES=1; PASSTHRU+=("$1"); shift ;;
    --preview)  WEB_TARGET="preview"; shift ;;
    --profile)  PASSTHRU+=("$1" "${2:?--profile needs a value}"); shift 2 ;;
    --submit|--allow-dirty|--skip-env) PASSTHRU+=("$1"); shift ;;
    *) echo "✗ unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "$APP" in
  web|maintenance|security|manager|resident) ;;
  *) echo "✗ unknown app: $APP (web | maintenance | security | manager | resident)" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Version gate.
#
# A drifted app has no single answer to "what version is this", and the four
# places it lives do not all reach the binary. Shipping one is how a build
# ends up labelled with a version that never existed — so this refuses before
# anything is built rather than after.
# ---------------------------------------------------------------------------
version_line="$(bun run "$REPO_ROOT/scripts/version.mjs" 2>/dev/null | grep -E "^${APP}[[:space:]]" || true)"
if echo "$version_line" | grep -q "DRIFT"; then
  echo "✗ $APP's version disagrees with itself — refusing to ship an ambiguous build." >&2
  echo >&2
  bun run "$REPO_ROOT/scripts/version.mjs" >&2 || true
  exit 1
fi
VERSION="$(echo "$version_line" | awk '{print $2}')"
[ -n "$VERSION" ] || VERSION="?"

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ -t 0 ] || { echo "✗ not a terminal and --yes not given — refusing to ship unattended" >&2; exit 1; }
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) echo "aborted."; exit 1 ;; esac
}

# ---------------------------------------------------------------------------
# Mobile — delegate to eas-release.sh, which owns the EAS preflight.
# ---------------------------------------------------------------------------
if [ "$APP" != "web" ]; then
  if [ ! -f "apps/$APP/eas.json" ]; then
    echo "✗ apps/$APP has no eas.json, so it cannot be built by EAS." >&2
    echo "  Run 'eas init' inside apps/$APP and add a production build profile." >&2
    exit 1
  fi
  echo "━━ $APP v$VERSION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exec "$REPO_ROOT/scripts/eas-release.sh" "apps/$APP" "${PASSTHRU[@]}"
fi

# ---------------------------------------------------------------------------
# Web — Vercel. `deploy:*` already runs verify (test + typecheck + build)
# first, so a broken build never reaches a URL.
# ---------------------------------------------------------------------------
echo "━━ web v$VERSION → $WEB_TARGET ━━━━━━━━━━━━━━━━━━━"

branch="$(git branch --show-current 2>/dev/null || echo '?')"
dirty="$(git status --porcelain -- apps/web packages 2>/dev/null || true)"
if [ -n "$dirty" ]; then
  echo "  ! uncommitted changes in apps/web or packages:"
  printf '%s\n' "$dirty" | sed 's/^/      /'
  echo "      (Vercel deploys the WORKING TREE, so these WILL ship — unlike EAS, which uses git.)"
else
  echo "  ✓ git          clean across apps/web packages"
fi

ahead=0
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  ahead="$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
fi
if [ "$ahead" -gt 0 ]; then
  echo "  ! branch       $branch is $ahead commit(s) ahead of upstream"
else
  echo "  ✓ branch       $branch, in sync with upstream"
fi

if [ ! -f "apps/web/.env.production" ]; then
  echo "  ! env          apps/web/.env.production absent — Vercel will use its stored values"
else
  echo "  ✓ env          apps/web/.env.production present (Vercel's stored values still win at runtime)"
fi

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — preflight complete, stopping before deploy."
  exit 0
fi

if [ "$WEB_TARGET" = "prod" ]; then
  confirm "Deploy web v$VERSION to PRODUCTION?"
  script="deploy:prod"
else
  script="deploy:preview"
fi

echo "━━ deploying ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bun run --filter '@emberly/web' "$script"

echo
echo "✓ done — web v$VERSION ($WEB_TARGET)"
