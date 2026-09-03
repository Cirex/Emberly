#!/usr/bin/env bash
# Mint the ANON_KEY and SERVICE_ROLE_KEY JWTs for a Supabase deployment.
# They are HS256 JWTs signed with JWT_SECRET — not random strings, which is why
# Coolify's password generator cannot produce them.
#
#   ./mint-keys.sh "$JWT_SECRET" [years]
set -euo pipefail
SECRET="${1:?usage: ./mint-keys.sh <JWT_SECRET> [years]}"
YEARS="${2:-5}"
IAT=$(date +%s); EXP=$((IAT + YEARS*31536000))
b64() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
sign() {
  local h p; h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64)
  p=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$1" "$IAT" "$EXP" | b64)
  printf '%s.%s.%s\n' "$h" "$p" \
    "$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$SECRET" -binary | b64)"
}
echo "ANON_KEY=$(sign anon)"
echo "SERVICE_ROLE_KEY=$(sign service_role)"
echo
echo "# expires $(date -r "$EXP" 2>/dev/null || date -d "@$EXP" 2>/dev/null)"
