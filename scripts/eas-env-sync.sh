#!/usr/bin/env bash
#
# Mirror an app's local .env.production into its EAS environments — including
# REMOVING variables that no longer exist in the file.
#
# This supersedes eas-import-env.sh, which only ever added/overwrote a hardcoded
# list of five observability keys. Two failure modes that caused:
#   · a var deleted locally lived on in EAS forever (stale values silently
#     baked into every cloud build — including vars belonging to other projects)
#   · a var added locally was ignored unless someone edited the script's KEYS
#
# Usage:
#   scripts/eas-env-sync.sh <app-dir> [options]
#
#   --environments "production preview"   which EAS environments to sync (default both)
#   --prune                               delete EAS vars absent from the file
#   --dry-run                             show the plan, change nothing
#   --yes                                 skip the confirmation prompt when pruning
#
# Examples:
#   scripts/eas-env-sync.sh apps/security --dry-run          # diff only, the safe default read
#   scripts/eas-env-sync.sh apps/security                    # push adds/updates
#   scripts/eas-env-sync.sh apps/security --prune            # full mirror, with confirmation
#
# VALUES ARE NEVER PRINTED. The plan shows variable names and an action only —
# safe to paste into a ticket or run over a shared screen.
#
# Secret classification: a name matching TOKEN/SECRET/PASSWORD/PRIVATE is pushed
# with --visibility secret, EXCEPT anything prefixed EXPO_PUBLIC_, which Expo
# inlines into the client bundle — marking those secret would imply a
# confidentiality the shipped app does not have.
#
# Written for bash 3.2 (macOS stock): no associative arrays, state lives in
# temp files so this runs anywhere without a Homebrew bash.
set -euo pipefail

APP="${1:?usage: scripts/eas-env-sync.sh <app-dir> [--environments \"production preview\"] [--prune] [--dry-run] [--yes]}"
shift

ENVIRONMENTS="production preview"
PRUNE=0
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --environments) ENVIRONMENTS="${2:?--environments needs a value}"; shift 2 ;;
    --prune)        PRUNE=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    *) echo "✗ unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${APP%/}"
APP_DIR="$REPO_ROOT/${APP#"$REPO_ROOT/"}"
ENVFILE="$APP_DIR/.env.production"

[ -d "$APP_DIR" ] || { echo "✗ no such app directory: $APP" >&2; exit 1; }
[ -f "$ENVFILE" ] || { echo "✗ $APP/.env.production not found" >&2; exit 1; }

EAS=(bunx eas-cli)
command -v eas >/dev/null 2>&1 && EAS=(eas)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DESIRED="$WORK/desired"
REMOTE="$WORK/remote"

# ── desired state ─────────────────────────────────────────────────────────────
# Last assignment wins; one surrounding pair of quotes is stripped; everything
# after the first '=' is the value (values may contain '='). Comments and blank
# lines ignored.
: > "$DESIRED"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    \#*|"") continue ;;
  esac
  echo "$line" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*=' || continue
  key="${line%%=*}"
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  # last-wins: drop any earlier entry for this key
  grep -v "^${key}=" "$DESIRED" > "$DESIRED.tmp" 2>/dev/null || true
  mv "$DESIRED.tmp" "$DESIRED"
  printf '%s=%s\n' "$key" "$val" >> "$DESIRED"
done < "$ENVFILE"

desired_count="$(wc -l < "$DESIRED" | tr -d ' ')"

lookup() { grep -m1 "^$2=" "$1" 2>/dev/null | cut -d= -f2- || true; }
has_key() { grep -q "^$2=" "$1" 2>/dev/null; }
keys_of()  { cut -d= -f1 "$1" 2>/dev/null | sort; }

is_secret() {
  case "$1" in
    EXPO_PUBLIC_*) return 1 ;;
    *TOKEN*|*SECRET*|*PASSWORD*|*PRIVATE*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "→ ${APP}  ·  environments: ${ENVIRONMENTS}"
echo "  source: ${APP}/.env.production (${desired_count} variable(s))"
[ "$DRY_RUN" = "1" ] && echo "  DRY RUN — nothing will be changed"
[ "$PRUNE" = "0" ]   && echo "  (no --prune: variables missing from the file are reported, not deleted)"
echo

cd "$APP_DIR"
total_add=0; total_update=0; total_same=0; total_prune=0; exit_code=0

for env_name in $ENVIRONMENTS; do
  echo "── ${env_name} ─────────────────────────────────"

  # Current EAS state. Secret values return masked, so a secret always counts as
  # an update — harmless, --force is idempotent.
  "${EAS[@]}" env:list --environment "$env_name" --format short 2>/dev/null \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$REMOTE" || : > "$REMOTE"

  for key in $(keys_of "$DESIRED"); do
    vis="plaintext"; is_secret "$key" && vis="secret"
    want="$(lookup "$DESIRED" "$key")"

    if ! has_key "$REMOTE" "$key"; then
      action="ADD"; total_add=$((total_add+1))
    else
      have="$(lookup "$REMOTE" "$key")"
      case "$have" in
        *"This is a secret env variable"*) action="UPDATE"; total_update=$((total_update+1)) ;;
        "$want") printf '  ·  %-42s unchanged\n' "$key"; total_same=$((total_same+1)); continue ;;
        *) action="UPDATE"; total_update=$((total_update+1)) ;;
      esac
    fi

    printf '  +  %-42s %-7s (%s)\n' "$key" "$action" "$vis"
    [ "$DRY_RUN" = "1" ] && continue

    if ! "${EAS[@]}" env:create \
        --environment "$env_name" \
        --name "$key" \
        --value "$want" \
        --visibility "$vis" \
        --force --non-interactive >/dev/null 2>&1; then
      echo "     ✗ failed to push $key" >&2
      exit_code=1
    fi
  done

  # orphans: present in EAS, absent from the file
  : > "$WORK/orphans"
  for key in $(keys_of "$REMOTE"); do
    has_key "$DESIRED" "$key" || echo "$key" >> "$WORK/orphans"
  done
  orphan_count="$(wc -l < "$WORK/orphans" | tr -d ' ')"

  if [ "$orphan_count" -gt 0 ]; then
    echo
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      if [ "$PRUNE" = "1" ]; then
        printf '  -  %-42s DELETE  (absent from .env.production)\n' "$key"
      else
        printf '  !  %-42s ORPHAN  (in EAS, not in .env.production)\n' "$key"
      fi
    done < "$WORK/orphans"

    if [ "$PRUNE" = "1" ] && [ "$DRY_RUN" = "0" ]; then
      proceed=1
      if [ "$ASSUME_YES" = "0" ]; then
        echo
        printf '  Delete %s variable(s) from %s? [y/N] ' "$orphan_count" "$env_name"
        read -r reply </dev/tty || reply="n"
        case "$reply" in [Yy]*) proceed=1 ;; *) proceed=0; echo "  skipped" ;; esac
      fi
      if [ "$proceed" = "1" ]; then
        while IFS= read -r key; do
          [ -n "$key" ] || continue
          if "${EAS[@]}" env:delete \
              --environment "$env_name" \
              --variable-name "$key" \
              --non-interactive >/dev/null 2>&1; then
            total_prune=$((total_prune+1))
          else
            echo "     ✗ failed to delete $key" >&2
            exit_code=1
          fi
        done < "$WORK/orphans"
      fi
    fi
  fi
  echo
done

echo "──────────────────────────────────────────────"
printf 'added %d · updated %d · unchanged %d · deleted %d\n' \
  "$total_add" "$total_update" "$total_same" "$total_prune"

if [ "$PRUNE" = "0" ] && [ "$DRY_RUN" = "0" ]; then
  echo "Orphans left in place. Re-run with --prune to mirror the file exactly."
fi
echo "Verify:  (cd $APP && ${EAS[*]} env:list --environment production)"

exit "$exit_code"
