#!/usr/bin/env bash
# Shared helpers for the demo scripts. Source this, don't run it.
# Requires: bash, curl, openssl. Reads BASE / API_KEY / WEBHOOK_SECRET from env.

: "${BASE:=https://kira-ledger-staging.fly.dev}"
# Seeded Northwind account ids (fixed UUIDs, not secrets) — defaulted so the
# scripts run even if you only exported the secrets.
: "${USER_ACCOUNT:=00000000-0000-0000-0000-000000000002}"
: "${EXTERNAL_ACCOUNT:=00000000-0000-0000-0000-000000000001}"
: "${ACH_DEST:=00000000-0000-0000-0000-000000000010}"
: "${USDT_DEST:=00000000-0000-0000-0000-000000000011}"

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_bold=$'\033[1m'
c_green=$'\033[32m'; c_red=$'\033[31m'; c_cyan=$'\033[36m'

section() { printf '\n%s──────── %s ────────%s\n' "$c_bold$c_cyan" "$1" "$c_reset"; }
note()    { printf '%s%s%s\n' "$c_dim" "$1" "$c_reset"; }

require() {
  local missing=0
  for v in "$@"; do
    if [ -z "${!v:-}" ] || [ "${!v:-}" = "REPLACE_ME" ]; then
      printf '%sMissing env var: %s%s  (source demo/.env — see demo/env.example)\n' "$c_red" "$v" "$c_reset"
      missing=1
    fi
  done
  [ "$missing" = 0 ] || exit 1
}

# hmac_hex <secret> <raw-body>  -> HMAC-SHA256 hex, exactly over the bytes sent.
hmac_hex() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" | awk '{print $NF}'; }

# show <expected-code> <curl-args...> — prints status + body, green/red vs expected.
show() {
  local expected="$1"; shift
  local out code body
  out=$(curl -s -m 30 -w $'\n%{http_code}' "$@")
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$code" = "$expected" ]; then printf '%s' "$c_green"; else printf '%s' "$c_red"; fi
  printf 'HTTP %s%s  (expected %s)\n' "$code" "$c_reset" "$expected"
  printf '%s\n' "$body"
}
