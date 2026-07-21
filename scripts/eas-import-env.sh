#!/usr/bin/env bash
#
# DEPRECATED — use scripts/eas-env-sync.sh instead.
#
# This script pushes only the five hardcoded KEYS below and never removes
# anything, so it silently misses newly added variables and leaves deleted ones
# live in EAS forever. eas-env-sync.sh mirrors the whole file in both
# directions (and --prune deletes orphans). Kept only so existing muscle memory
# and older runbooks don't break.
#
# Import an app's observability env vars from its local .env.production into the
# EAS environment for that app (so cloud builds actually get them — EAS never
# reads local .env files).
#
# Usage:
#   scripts/eas-import-env.sh <app-dir> [environments]
#   e.g. scripts/eas-import-env.sh apps/security                 # → production + preview
#        scripts/eas-import-env.sh apps/security "production"     # → production only
#
# Preview without pushing:
#   DRY_RUN=1 scripts/eas-import-env.sh apps/security
#
# EAS env vars are scoped per-PROJECT (this app's linked project) and per-
# ENVIRONMENT. Build profiles only see their own environment's vars, so by
# default we push to both `production` and `preview` (the profiles that produce
# distributable builds); `development` doesn't need Sentry. Run once per app,
# after `eas init` has linked it.
#
# Values are read from <app-dir>/.env.production and handed straight to eas —
# they are never printed. SENTRY_AUTH_TOKEN is pushed as a secret; the rest
# (client keys / slugs) as plaintext. Idempotent: --force overwrites existing.
set -euo pipefail

APP="${1:?usage: scripts/eas-import-env.sh <app-dir> [environments]}"
ENVIRONMENTS="${2:-production preview}"
ENVFILE="$APP/.env.production"

[ -f "$ENVFILE" ] || { echo "✗ $ENVFILE not found"; exit 1; }
command -v eas >/dev/null 2>&1 || { echo "✗ eas CLI not found (npm i -g eas-cli or use bunx eas-cli)"; exit 1; }

# Vars to import if present + non-empty. Only SENTRY_AUTH_TOKEN is a secret.
KEYS=(EXPO_PUBLIC_SENTRY_DSN EXPO_PUBLIC_POSTHOG_KEY SENTRY_ORG SENTRY_PROJECT SENTRY_AUTH_TOKEN)
SECRETS=" SENTRY_AUTH_TOKEN "

echo "→ Importing into EAS [$ENVIRONMENTS] for $APP"
[ "${DRY_RUN:-0}" = "1" ] && echo "  (DRY RUN — nothing will be pushed)"

# Expand the space-separated environment list into repeated --environment flags.
env_flags=()
for e in $ENVIRONMENTS; do env_flags+=(--environment "$e"); done

cd "$APP"
pushed=0
for key in "${KEYS[@]}"; do
  # last matching assignment; keep everything after the first '='; strip one pair of quotes
  val="$(grep -E "^${key}=" .env.production | tail -1 | cut -d= -f2- || true)"
  val="${val%\"}"; val="${val#\"}"
  if [ -z "$val" ]; then echo "  · $key — not set, skipping"; continue; fi

  vis="plaintext"; [[ "$SECRETS" == *" $key "* ]] && vis="secret"
  echo "  ✓ $key ($vis)"
  [ "${DRY_RUN:-0}" = "1" ] && { pushed=$((pushed+1)); continue; }

  eas env:create \
    "${env_flags[@]}" \
    --name "$key" \
    --value "$val" \
    --visibility "$vis" \
    --force --non-interactive >/dev/null
  pushed=$((pushed+1))
done

echo "✓ ${pushed} variable(s) processed across: $ENVIRONMENTS"
echo "  Verify:  (cd $APP && eas env:list --environment production)"
