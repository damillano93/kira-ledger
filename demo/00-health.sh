#!/usr/bin/env bash
# Read-only liveness/readiness + public surfaces. No secrets needed.
set -uo pipefail
cd "$(dirname "$0")" && source ./lib.sh

section "Liveness — is the process up?"
show 200 "$BASE/healthz"

section "Readiness — is the database reachable?"
show 200 "$BASE/readyz"

section "OpenAPI spec is served (Swagger UI lives at $BASE/docs)"
curl -s -m 30 "$BASE/docs/json" | head -c 200; echo " ..."

section "Live dashboard data (balances, fees, transfers, routing)"
curl -s -m 30 "$BASE/dashboard/data" | head -c 300; echo " ..."
note "Open $BASE/dashboard in a browser for the live view."
