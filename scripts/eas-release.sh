#!/usr/bin/env bash
#
# Build (and optionally submit) one mobile app through EAS, with the
# preflight checks that are easy to forget and expensive to miss.
#
# Usage:
#   scripts/eas-release.sh <app-dir> [options]
#
#   --profile <name>   EAS build profile (default: production)
#   --submit           run `eas submit` after a successful build
#   --skip-env         don't sync .env.production into EAS first
#   --allow-dirty      build even with uncommitted changes (see below)
#   --dry-run          run every check, then stop before building
#   --yes              non-interactive; assume yes at prompts
#
# Examples:
#   scripts/eas-release.sh apps/security --dry-run     # preflight only
#   scripts/eas-release.sh apps/security --submit      # build → TestFlight
#
# WHY THE DIRTY-TREE CHECK MATTERS: EAS builds from your COMMITTED git state,
# not your working tree. Uncommitted changes are silently absent from the
# binary. A native change (a new pod, an entitlement) left uncommitted produces
# a build that looks fine and is missing the feature.
set -euo pipefail

APP="${1:?usage: scripts/eas-release.sh <app-dir> [--profile production] [--submit] [--dry-run]}"
shift

PROFILE="production"
DO_SUBMIT=0
SKIP_ENV=0
ALLOW_DIRTY=0
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)     PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --submit)      DO_SUBMIT=1; shift ;;
    --skip-env)    SKIP_ENV=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    *) echo "✗ unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${APP%/}"
APP_DIR="$REPO_ROOT/${APP#"$REPO_ROOT/"}"

EAS=(bunx eas-cli)
command -v eas >/dev/null 2>&1 && EAS=(eas)

fail() { echo "✗ $1" >&2; exit 1; }

echo "━━ preflight ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. the app is real and EAS-ready
[ -d "$APP_DIR" ] || fail "no such app directory: $APP"
[ -f "$APP_DIR/eas.json" ] || fail "$APP has no eas.json — run 'eas init' in that directory and add a build profile first"

version="$(node -e "const j=require('$APP_DIR/app.json');const e=j.expo||j;console.log(e.version||'?')" 2>/dev/null || echo '?')"
bundle_id="$(node -e "const j=require('$APP_DIR/app.json');const e=j.expo||j;console.log((e.ios&&e.ios.bundleIdentifier)||'')" 2>/dev/null || echo '')"
linked="$(node -e "const j=require('$APP_DIR/app.json');const e=j.expo||j;console.log((e.extra&&e.extra.eas&&e.extra.eas.projectId)?'yes':'no')" 2>/dev/null || echo 'no')"

[ -n "$bundle_id" ] || fail "$APP has no ios.bundleIdentifier in app.json"
[ "$linked" = "yes" ] || fail "$APP is not linked to an EAS project — run 'eas init' inside $APP"

node -e "
const j=require('$APP_DIR/eas.json');
if(!j.build || !j.build['$PROFILE']) { console.error('missing'); process.exit(1); }
" 2>/dev/null || fail "eas.json has no build profile named '$PROFILE'"

echo "  ✓ app          $APP  v$version  ($bundle_id)"
echo "  ✓ profile      $PROFILE"

# 2. committed state — EAS builds this, not your working tree.
#    Shared packages count: they compile into the app.
watch_paths=("$APP" "packages")
dirty="$(cd "$REPO_ROOT" && git status --porcelain -- "${watch_paths[@]}" 2>/dev/null || true)"
if [ -n "$dirty" ]; then
  echo "  ! uncommitted changes affecting this build:"
  printf '%s\n' "$dirty" | sed 's/^/      /'
  if [ "$ALLOW_DIRTY" = "1" ]; then
    echo "      --allow-dirty set: continuing. These changes will NOT be in the binary."
  else
    fail "commit (or stash) the above, or pass --allow-dirty to build without them"
  fi
else
  echo "  ✓ git          clean across ${watch_paths[*]}"
fi

branch="$(cd "$REPO_ROOT" && git branch --show-current 2>/dev/null || echo '?')"
upstream_gone=0
(cd "$REPO_ROOT" && git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1) || upstream_gone=1
if [ "$upstream_gone" = "1" ]; then
  echo "  ! branch       $branch has no upstream (nothing pushed)"
else
  ahead="$(cd "$REPO_ROOT" && git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
  if [ "$ahead" -gt 0 ]; then
    echo "  ! branch       $branch is $ahead commit(s) ahead of its upstream — push so the build is reproducible"
  else
    echo "  ✓ branch       $branch, in sync with upstream"
  fi
fi

# 3. environment
if [ "$SKIP_ENV" = "1" ]; then
  echo "  · env          skipped (--skip-env)"
elif [ ! -f "$APP_DIR/.env.production" ]; then
  echo "  ! env          $APP/.env.production not found — EAS will build with whatever is already stored"
else
  echo "  · env          diff against EAS:"
  "$REPO_ROOT/scripts/eas-env-sync.sh" "$APP" --environments "$PROFILE" --dry-run 2>&1 | sed 's/^/      /'
fi

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — preflight complete, stopping before build."
  exit 0
fi

# Push the env for real before building, so the build reads current values.
if [ "$SKIP_ENV" = "0" ] && [ -f "$APP_DIR/.env.production" ]; then
  echo "━━ syncing env ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  sync_args=("$APP" --environments "$PROFILE")
  [ "$ASSUME_YES" = "1" ] && sync_args+=(--yes)
  "$REPO_ROOT/scripts/eas-env-sync.sh" "${sync_args[@]}"
  echo
fi

echo "━━ building ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cd "$APP_DIR"
build_args=(build --platform ios --profile "$PROFILE")
[ "$ASSUME_YES" = "1" ] && build_args+=(--non-interactive)
"${EAS[@]}" "${build_args[@]}"

if [ "$DO_SUBMIT" = "1" ]; then
  echo
  echo "━━ submitting ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  submit_args=(submit --platform ios --profile "$PROFILE" --latest)
  [ "$ASSUME_YES" = "1" ] && submit_args+=(--non-interactive)
  "${EAS[@]}" "${submit_args[@]}"
fi

echo
echo "✓ done — $APP v$version ($PROFILE)"
