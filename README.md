# kira-ledger

A multi-rail ledger & orchestration engine: an append-only double-entry ledger on Postgres that takes stablecoin deposits (Solana), converts them to USD books with itemised fees, and orchestrates standing payout routes across fiat and crypto rails — with every invariant enforced as a database constraint and reconciliation as a query.

**Live**: staging — https://kira-ledger-staging.fly.dev
· [API docs (Swagger)](https://kira-ledger-staging.fly.dev/docs)
· [Ops dashboard](https://kira-ledger-staging.fly.dev/dashboard)
· [health](https://kira-ledger-staging.fly.dev/healthz)

---

## One-command setup

```bash
docker compose up --build -d && docker compose exec app npx tsx scripts/migrate.ts
```

API on http://localhost:3000 (Swagger at `/docs`, dashboard at `/dashboard`). Migrations are a separate, idempotent step by design — the same script runs once per release on Fly via `release_command` (see [fly.toml](fly.toml)), never per-machine on boot, so containers can't race on DDL. Compose mirrors that split.

**Port caveat**: the `db` service binds host port **5432**. If something already listens there, change the host side of the mapping in [docker-compose.yml](docker-compose.yml) (`"5432:5432"` → e.g. `"15432:5432"`); the app talks to `db:5432` over the compose network, so nothing else changes.

Compose dev credentials: `API_KEY=dev-api-key-change-me`, `WEBHOOK_SECRET=dev-webhook-secret-change-me`.

### Without Docker

Requires Node ≥ 20 and a local Postgres. [.env.example](.env.example) documents every variable; nothing auto-loads a `.env`, so export explicitly (or `set -a; source .env; set +a`):

```bash
export DATABASE_URL=postgres://kira:kira@localhost:5432/kira
export API_KEY=dev-api-key-change-me
export WEBHOOK_SECRET=dev-webhook-secret-change-me

npm install
npm run migrate
npm run dev
```

## Tests

```bash
npm test            # the whole suite: unit + integration + concurrency + BDD
npm run test:int    # integration specs only
npx tsc --noEmit    # typecheck
```

`npm test` is self-contained: a global setup starts a throwaway Postgres container (`kira-ledger-test-db`, host port **5433** — deliberately not 5432) and applies all migrations before any spec runs. Docker is the only prerequisite.

The suite covers the structural guarantees against a real database — the deferred double-entry trigger, the append-only guard, `CHECK (headroom_minor >= 0)` under a concurrent payout flood — plus the BDD specs in [test/bdd/](test/bdd/), a thin Gherkin-style layer over vitest whose output reads as a living spec (`Feature: Northwind end-to-end … Given a 5,000 USDC deposit …`). No cucumber machinery; each step is plain code, printed as a transcript.

Reconciliation also runs standalone (cron/CI friendly, exits non-zero on any mismatch):

```bash
DATABASE_URL=postgres://kira:kira@localhost:5432/kira npx tsx scripts/run-recon.ts
# flags: --max-age-minutes N   --json
# under compose (DATABASE_URL already set in the container):
docker compose exec app npx tsx scripts/run-recon.ts
```

The same report is served over HTTP: `GET /recon/report` (bearer API key, `?maxAgeMinutes=` optional).

## The Northwind flow, live

```
USDC on Solana                Kira ledger (Postgres)                     counterparties
--------------                ----------------------                     --------------
deposit tx --> watcher/webhook --> deposit booked PENDING (USDC, unspendable)
               chain finality  --> off-ramp: USDC->USD at par, fee itemised,
                                   net lands in AVAILABLE          (ADR-007)
                                        | post-commit bridge       (ADR-026)
                                        v
                                   route fires once per deposit    (R4, ADR-013)
                                   reserves ALL legs or none
                                   |- leg 1: acmepay      $4,200.00 ACH --> roaster
                                   '- leg 2: polygon-usdt 600 USDT     --> supplier
                                   settlement events move legs settled/failed
                                   recon: anti-joins ledger <-> chain <-> statements
```

The steps below run against staging or local — set the base once:

```bash
BASE=https://kira-ledger-staging.fly.dev     # or http://localhost:3000
WEBHOOK_SECRET=...                           # compose default: dev-webhook-secret-change-me
API_KEY=...                                  # compose default: dev-api-key-change-me
```

**1. A signed deposit webhook books a pending deposit.** The signature is HMAC-SHA256 over the exact raw body; computing it is one `openssl` line:

```bash
BODY='{"txHash":"demo-tx-001","chain":"solana-devnet","amount":"5000000000","currency":"USDC","userAccountId":"00000000-0000-0000-0000-000000000002","externalAccountId":"00000000-0000-0000-0000-000000000001"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)

curl -s -X POST "$BASE/webhooks/chain" \
  -H 'content-type: application/json' \
  -H "x-timestamp: $(date +%s)" \
  -H "x-signature: $SIG" \
  --data "$BODY"
```

`201` with a transfer id, booked to the **pending** bucket (5,000 USDC = `5000000000` at 6dp — amounts are integer minor-unit strings everywhere, never floats). Re-run the same curl: `200` with `"idempotent": true` — redelivery is a keyed no-op (`UNIQUE` on the idempotency key derived from `chain:txHash`). Tamper one byte of the body without re-signing and you get `401`.

**2. See the pending balance** (seeded Northwind sub-account):

```bash
curl -s "$BASE/accounts/00000000-0000-0000-0000-000000000002/balance"
```

**3. Confirmation — how it actually happens.** There is deliberately no HTTP lever that moves pending to available: only observed chain finality does. The chain watcher detects deposits at `confirmed` commitment (books pending) and credits at `finalized` (posts the USDC→USD conversion: at the default 100 bps, 5,000 USDC → $4,950.00 available + $50.00 itemised fee). On a deployment without the watcher enabled, a webhook-injected deposit stays honestly pending. To watch the full transition live, run the real devnet leg below; the same path is also exercised deterministically by the BDD suite.

**4. The route fires.** After the credit commits, the post-commit bridge fires the seeded standing rule (`northwind-pay-roaster-and-supplier`): reserve $4,200.00 for the ACH leg and $600.00/600 USDT for the Polygon leg — all-or-nothing, then dispatch to providers. The same engine entry point is exposed for manual/demo use:

```bash
curl -s -X POST "$BASE/routing/trigger" \
  -H "authorization: Bearer $API_KEY" -H 'content-type: application/json' \
  --data '{"offrampTransferId":"<confirmed offramp transfer id>","userAccountId":"00000000-0000-0000-0000-000000000002"}'
```

Replay it: the execution comes back `already_fired` — `UNIQUE(route_id, trigger_transfer_id)` makes a route fire exactly once per deposit. Inspect legs (and grab each leg's `externalRef`):

```bash
curl -s "$BASE/routing/executions/<executionId>"
```

**5. Settle the legs.** The mock levers stand in for the providers' own settlement channels (AcmePay webhooks, LegacyBank polling, Polygon finality) and drive the exact same adapter path a real webhook would:

```bash
# ACH leg: force AcmePay's native settlement webhook through the adapter
curl -s -X POST "$BASE/mock/providers/acmepay/settle" \
  -H 'content-type: application/json' \
  --data '{"externalRef":"<acmepay externalRef>","outcome":"settled"}'

# Crypto leg: poll the simulated Polygon send until it finalizes (or force via /settle)
curl -s -X POST "$BASE/mock/providers/polygon-usdt/poll" \
  -H 'content-type: application/json' \
  --data '{"externalRef":"<0x... tx hash>"}'

# Provider-side truth, as recon consumes it
curl -s "$BASE/mock/providers/acmepay/statements"
```

**6. Watch and reconcile.** `$BASE/dashboard` shows balances, itemised fees, transfer states and routing activity live; then run the recon CLI (step above) — three anti-joins (settled-with-no-entry, entry-never-confirmed, guard-vs-ledger drift) over an append-only ledger, chain events and provider statements. A clean run prints `OK — ledger, chain and provider statements all agree.`

## Real testnet leg (Solana devnet)

The inbound leg is real: actual SPL transfers on Solana devnet, watched, finalized and booked by the same code paths as above.

```bash
npx tsx scripts/devnet-setup.ts
```

One shot, idempotent (state cached in `.devnet/`, gitignored): generates the payer and deposit wallets, airdrops SOL, creates a 6-decimal test-USDC mint and funds the payer. Honest caveat: the devnet RPC faucet is aggressively rate-limited and periodically dry — if the airdrop keeps failing, fund the printed payer address once at https://faucet.solana.com and re-run (the script skips the airdrop when the balance suffices).

Paste the printed values into the environment (`SOLANA_USDC_MINT`, `SOLANA_DEPOSIT_OWNER`, `ENABLE_CHAIN_WATCHER=true`), start the server (`npm run dev`), then:

```bash
npx tsx scripts/devnet-deposit.ts 250    # a real 250 test-USDC transfer on devnet
```

The watcher detects the signature at `confirmed` commitment and books the pending deposit; once the transaction is `finalized` (~30s; or slot depth ≥ `CONFIRMATIONS`, whichever first) it credits available USD minus the fee and triggers the standing route — the full flow of the previous section, driven by a chain instead of a curl. The script prints an explorer link for the transaction.

The test mint is a self-issued token, not canonical USDC — Circle's faucet requires a browser and captcha, which kills unattended setup (ADR-023). Swapping to Circle's devnet USDC is configuration, not code: `SOLANA_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

## Architecture at a glance

A modular monolith on Postgres, where every critical invariant is a database guarantee rather than application discipline — chosen deliberately for correctness per unit of complexity (ADR-001).

- **Double-entry, append-only, structurally enforced.** A deferred constraint trigger makes an unbalanced transaction physically uncommittable (per currency); `UPDATE`/`DELETE` on entries is trigger-blocked. Corrections are new compensating entries, never edits. Balances are `SUM(entries)`.
- **No negative balances by construction.** Concurrent payouts serialize on a per-account guard row (`SELECT … FOR UPDATE` + conditional decrement), with `CHECK (headroom_minor >= 0)` as the structural backstop — overdraft is a constraint violation, not a code path (ADR-004/ADR-020).
- **Idempotency as constraints, never cache.** Every dedupe is a Postgres row: `UNIQUE` idempotency keys on transfers, `UNIQUE(chain, signature)` on chain events, `UNIQUE(route_id, trigger_transfer_id)` on route firings, `UNIQUE(provider, external_ref)` on statements (ADR-011).
- **One vendor port, three adapters.** Two mock fiat providers with deliberately different vocabularies (AcmePay: camelCase, cents-as-number, push webhooks; LegacyBank: snake_case, dollar-strings, polling) plus a simulated Polygon USDT adapter behind the same 4-method `PayoutProvider` port — provider #3 is a config entry, not a redesign (ADR-024).
- **Reconciliation as anti-joins.** Chain events and provider statements are keyed facts; recon is five read-only SELECTs detecting settled-with-no-entry, entry-never-confirmed and guard drift. It reports, never edits (DESIGN §9).
- **Observability as paging judgment.** Typed business events over pino, with an explicit page/don't-page policy — see [OBSERVABILITY.md](OBSERVABILITY.md).
- **IaC deploy.** One Dockerfile, one `fly.toml` shared by staging and prod (`--app` selects the target), migrations via `release_command`, CI auto-deploys staging and gates prod behind a human — see [DEPLOY.md](DEPLOY.md).

## Docs

- [DESIGN.md](DESIGN.md) — the full design: domain model, ledger, guardrails, vendor abstraction, crash-consistency, recon.
- [DECISIONS.md](DECISIONS.md) — the ADR log; every judgment call with context, options and what was given up.
- [OBSERVABILITY.md](OBSERVABILITY.md) — signals, alerts, and what wakes a human at 3am.
- [DEPLOY.md](DEPLOY.md) — the copy-pasteable Fly.io runbook (staging + prod) and CI/CD.
