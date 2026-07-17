#!/usr/bin/env bash
# The "make us trust the system" script: every guardrail rejects, live.
# Stateless — safe to run anytime, in any order.
set -uo pipefail
cd "$(dirname "$0")" && source ./lib.sh
require API_KEY WEBHOOK_SECRET

TS=$(date +%s)
BODY='{"txHash":"probe_'"$TS"'","chain":"solana-devnet","amount":"1000000","currency":"USDC","userAccountId":"'"$USER_ACCOUNT"'","externalAccountId":"'"$EXTERNAL_ACCOUNT"'"}'
GOOD_SIG=$(hmac_hex "$WEBHOOK_SECRET" "$BODY")

section "Webhook with a TAMPERED signature is rejected"
note "Correct body, wrong signature -> the HMAC check fails closed."
show 401 -X POST "$BASE/webhooks/chain" -H 'content-type: application/json' \
  -H "x-timestamp: $TS" -H 'x-signature: deadbeefdeadbeef' --data "$BODY"

section "Webhook with a STALE timestamp is rejected (replay protection)"
note "Valid signature but an old timestamp -> outside the freshness window."
show 401 -X POST "$BASE/webhooks/chain" -H 'content-type: application/json' \
  -H 'x-timestamp: 1000000000' -H "x-signature: $GOOD_SIG" --data "$BODY"

section "Payout WITHOUT an API key is rejected"
show 401 -X POST "$BASE/transfers/payout" -H 'content-type: application/json' \
  -H "idempotency-key: probe-$TS" \
  --data '{"userAccountId":"'"$USER_ACCOUNT"'","destinationAccountId":"'"$ACH_DEST"'","amount":"100","currency":"USD"}'

section "Payout with a FLOAT amount is rejected (money is integer minor units)"
show 400 -X POST "$BASE/transfers/payout" -H 'content-type: application/json' \
  -H "authorization: Bearer $API_KEY" -H "idempotency-key: probe-f-$TS" \
  --data '{"userAccountId":"'"$USER_ACCOUNT"'","destinationAccountId":"'"$ACH_DEST"'","amount":"10.50","currency":"USD"}'

section "Payout beyond AVAILABLE is rejected (no negative balance)"
note "A huge amount against available funds -> insufficient_funds, never an overdraft."
show 422 -X POST "$BASE/transfers/payout" -H 'content-type: application/json' \
  -H "authorization: Bearer $API_KEY" -H "idempotency-key: probe-i-$TS" \
  --data '{"userAccountId":"'"$USER_ACCOUNT"'","destinationAccountId":"'"$ACH_DEST"'","amount":"999999999999","currency":"USD"}'
