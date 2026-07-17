#!/usr/bin/env bash
# Reconciliation over the running system: five read-only anti-joins comparing the
# append-only ledger against chain events and provider statements. A clean run is
# ok:true with zero mismatches.
set -uo pipefail
cd "$(dirname "$0")" && source ./lib.sh
require API_KEY

section "Reconciliation report (live)"
show 200 "${@:+$@}" -H "authorization: Bearer $API_KEY" "$BASE/recon/report"
note "Checks: settled-with-no-entry (chain + provider), entry-never-confirmed"
note "(transfers + legs), and guard-vs-SUM(entries) drift. Reports, never edits."
