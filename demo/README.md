# Demo scripts — hitting the live (dev/staging) environment

Copy-pasteable `curl` scripts that exercise the deployed API at
`https://kira-ledger-staging.fly.dev`. Built for the Day 5 walkthrough: run them
one at a time on screen.

## Setup

```bash
cp demo/env.example demo/.env    # then edit demo/.env with the real secrets
source demo/.env                 # exports BASE, API_KEY, WEBHOOK_SECRET, account ids
chmod +x demo/*.sh
```

> **Secrets are never committed.** `demo/.env` is gitignored. `API_KEY` and
> `WEBHOOK_SECRET` were set at deploy time — read the names with
> `fly secrets list --app kira-ledger-staging` and keep the values in your
> password manager.

## The scripts

| Script | What it shows | Needs secrets |
|--------|---------------|---------------|
| `00-health.sh` | Liveness, readiness, OpenAPI, dashboard data | no |
| `01-guardrails.sh` | Every guardrail rejects: tampered signature, replay, no-auth, float amount, overdraft | yes |
| `02-deposit.sh` | Signed webhook deposit → pending credited, and a redelivery that does **not** double-credit (idempotency) | yes |
| `03-route-settle.sh` | Fire the Northwind route off a confirmed off-ramp, settle both legs, show `completed` | yes + `OFFRAMP_TRANSFER_ID` |
| `04-recon.sh` | Live reconciliation report (`ok:true`, zero mismatches) | yes |

## Suggested demo order

```bash
source demo/.env
./demo/00-health.sh        # it's alive
./demo/01-guardrails.sh    # ...and it refuses to do the wrong thing
./demo/02-deposit.sh       # real money movement, idempotent
./demo/04-recon.sh         # the books agree
```

The full deposit → confirmation → route → settlement chain runs **automatically**
when a real deposit lands on Solana devnet (the on-chain path). `03-route-settle.sh`
is the manual trigger for a repeatable, network-independent demo — pass a confirmed
off-ramp transfer id via `OFFRAMP_TRANSFER_ID` (grab one from `/dashboard`).

## Notes

- `01-guardrails.sh` is completely stateless — safe to run live, any time.
- Every script prints the HTTP status in green/red against what it expected.
- Requires `bash`, `curl`, and `openssl` (for the webhook HMAC).
