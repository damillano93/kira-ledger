#!/usr/bin/env bash
# A signed inbound deposit + proof of idempotency (no double-credit on redelivery).
# This is the same HTTP path the on-chain watcher drives; here we sign it by hand.
set -uo pipefail
cd "$(dirname "$0")" && source ./lib.sh
require API_KEY WEBHOOK_SECRET

TS=$(date +%s)
# 5,000 USDC in 6-decimal minor units. Unique txHash so each demo run is a fresh deposit.
BODY='{"txHash":"demo_'"$TS"'","chain":"solana-devnet","amount":"5000000000","currency":"USDC","userAccountId":"'"$USER_ACCOUNT"'","externalAccountId":"'"$EXTERNAL_ACCOUNT"'"}'
SIG=$(hmac_hex "$WEBHOOK_SECRET" "$BODY")

section "Balance BEFORE"
curl -s -m 30 "$BASE/accounts/$USER_ACCOUNT/balance"; echo

section "Signed webhook — first delivery (expect 201, credits PENDING)"
show 201 -X POST "$BASE/webhooks/chain" -H 'content-type: application/json' \
  -H "x-timestamp: $TS" -H "x-signature: $SIG" --data "$BODY"

section "SAME webhook redelivered (expect 200, idempotent:true — no second credit)"
show 200 -X POST "$BASE/webhooks/chain" -H 'content-type: application/json' \
  -H "x-timestamp: $TS" -H "x-signature: $SIG" --data "$BODY"

section "Balance AFTER — pending rose by 5,000 USDC exactly ONCE"
curl -s -m 30 "$BASE/accounts/$USER_ACCOUNT/balance"; echo
note "available stays put: a deposit is not spendable until it clears (confirmation threshold)."
