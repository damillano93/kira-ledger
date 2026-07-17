#!/usr/bin/env bash
# Fire the Northwind route off a CONFIRMED off-ramp, then settle both legs and
# show the execution complete. In production the chain watcher fires this
# automatically on confirmation; here we trigger it by hand for a repeatable demo.
#
# Usage: OFFRAMP_TRANSFER_ID=<uuid> ./03-route-settle.sh
#   Get a confirmed off-ramp id from the dashboard (a 'offramp' transfer) or from
#   the on-chain flow. The route reserves $4,200 ACH + 600 USDT for USER_ACCOUNT.
set -uo pipefail
cd "$(dirname "$0")" && source ./lib.sh
require API_KEY

: "${OFFRAMP_TRANSFER_ID:?set OFFRAMP_TRANSFER_ID=<confirmed offramp transfer uuid>}"
AUTH=(-H "authorization: Bearer $API_KEY")

section "Trigger the Northwind route (fires exactly once per off-ramp)"
TRIG=$(curl -s -m 30 -X POST "$BASE/routing/trigger" -H 'content-type: application/json' "${AUTH[@]}" \
  --data '{"offrampTransferId":"'"$OFFRAMP_TRANSFER_ID"'","userAccountId":"'"$USER_ACCOUNT"'"}')
echo "$TRIG"
EXEC=$(printf '%s' "$TRIG" | grep -o '"executionId":"[^"]*"' | head -1 | cut -d'"' -f4)
ACH_REF=$(printf '%s' "$TRIG" | grep -o '"externalRef":"acp_[^"]*"' | head -1 | cut -d'"' -f4)
USDT_REF=$(printf '%s' "$TRIG" | grep -o '"externalRef":"0x[^"]*"' | head -1 | cut -d'"' -f4)
note "execution=$EXEC  ach_ref=$ACH_REF  usdt_ref=$USDT_REF"
[ -n "$EXEC" ] || { echo "no execution created (already fired? insufficient funds?)"; exit 0; }

section "Settle the ACH leg (acmepay — native webhook 'push' shape)"
show 200 -X POST "$BASE/mock/providers/acmepay/settle" -H 'content-type: application/json' \
  --data '{"externalRef":"'"$ACH_REF"'"}'

section "Settle the USDT leg (polygon-usdt — native 'poll' shape)"
show 200 -X POST "$BASE/mock/providers/polygon-usdt/poll" -H 'content-type: application/json' \
  --data '{"externalRef":"'"$USDT_REF"'"}'

section "Execution status (expect completed, both legs settled)"
curl -s -m 30 "${AUTH[@]}" "$BASE/routing/executions/$EXEC"; echo
