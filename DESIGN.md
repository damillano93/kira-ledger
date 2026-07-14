# DESIGN.md — Kira Ledger & Orchestration Engine

> Day 1 scope: the business problem, the domain model, the ledger design, and where money can race.
> Open questions and assumptions live in [DECISIONS.md](DECISIONS.md). No code yet — on purpose.

*Where I lean on experience: I work on payment orchestration at Yuno — normalizing many PSPs with genuinely different shapes behind one API — and previously on consumer fintech at RappiPay. I'll flag the calls that come from having operated these things, not just read about them.*

## 1. The business problem

Moving money is an API call. Any junior can ask a bank for an ACH or sign a Solana transaction in an afternoon. What Kira actually sells is different: **the guarantee that its books and the outside world never diverge**, while money crosses rails that disagree about almost everything:

- **They settle at different speeds — and "settled" means different things on each.** ACH settles T+1/T+2 and can still be returned weeks later (a revocable promise). A wire is same-day and irrevocable (the failure mode is a human error you can't undo). FedNow is irrevocable in seconds. Crypto finality is *probabilistic*: a transaction you saw in a block can vanish in a reorg, which is why a deposit is not money until it clears a per-chain confirmation threshold.
- **They speak different units.** Our books are USD cents (2 decimals). Money arrives as USDC on Solana (6 decimals: 5,000 USDC = 5,000,000,000 minor units) or USDT on Polygon. Decimals are a property of the `(token, chain)` pair, never of the token — and every conversion is a chance to create or destroy fractions of a cent, which a double-entry ledger forbids.
- **They fail differently, and so do we.** ACH fails *backwards* (late returns), wires fail *forward* (irreversible), chains fail *probabilistically* (reorgs) — and our own process can die in the gap between writing the ledger and calling the provider. The ledger design must make every one of those failures **detectable by query and correctable by new entries**, never by editing history.

One sentence to hold the whole design: *the ledger doesn't record where the money is; it records what we know and what we've promised, with enough structure to prove — at any instant — that our promises to clients are backed by assets we can verify against the outside world.*

A consequence that shapes everything below: **a client's balance is Kira's liability, not Kira's asset.** Kira *owes* Northwind that money. Kira's assets are what back the debt: on-chain wallets and the omnibus bank account. Every movement keeps assets and liabilities in lockstep — that is what double-entry buys us.

## 2. The domain in my words

- **Account** — not a table: Kira's standing promise to a Client or Sub-Client that we know exactly how much of their money we hold, in USD, and can prove it. It carries inbound instructions (deposit addresses per chain) and two distinct balances: **pending** (seen, not yet spendable — a deposited check) and **available** (spendable). A payout may only ever draw on available.
- **Client / Sub-Client / Omnibus** — Northwind is the Client; its own customers are Sub-Clients. At the bank the funds are pooled in one omnibus account; on our ledger every Sub-Client's balance is tracked separately. The bank sees one number; we must always be able to prove that number equals the sum of the parts.
- **Transfer** — one movement of money with a direction (`inbound`/`outbound`/`internal`) and a type (`fiat`/`crypto`). A transfer is a *process with a lifecycle*, not a row that flips a flag: it is detected, confirmed, credited, held, submitted, settled — and every step leaves ledger entries.
- **Ramp** — the conversion boundary. **Off-ramp**: stablecoin arrives, fees are applied, USD is credited. **On-ramp**: USD leaves as a stablecoin payout. Ramps are where units change, so ramps are where rounding policy and fee itemization live.
- **Route** — a standing treasury rule: "when X arrives, automatically send Y." It's what makes this an *orchestration* engine — Northwind doesn't log in to pay its coffee roaster every time it gets paid; the route does it, auditably and exactly once per triggering deposit. I read "when X *arrives*" as "when X becomes **available**" — the glossary is explicit that a payout may only draw on available, so a route firing on unconfirmed pending money would violate it.
- **Fee** — a transparent, itemized invoice, not a silent haircut. Three components (platform % by volume, fixed pass-through, optional client markup), each its own ledger line. The markup is **not Kira revenue** — it is margin Kira collects on behalf of the Client.

### The Northwind flow, as a story

A coffee buyer pays Northwind's sub-account **5,000 USDC on Solana**. For the first seconds that money is *visible but not collected* — we record it as **pending** (risk: a reorg can un-happen it). Once the chain finalizes it, the **off-ramp** runs: Kira takes its itemized fees, and the net USD lands in **available**. That credit trips a **route**: pay the roaster **$4,200 by ACH** (mocked provider) and send **600 USDT on Polygon** (real, on testnet) to a supplier who prefers crypto. Each payout first *reserves* funds (so concurrent payouts can't double-spend), then goes out through a provider/chain, then settles. At end of day, **reconciliation** re-derives everything from the ledger and checks it against on-chain truth and provider statements — both directions.

Annotated risk moments in that story: a reorg between *detected* and *confirmed*; a crash between the ledger write and the provider call; a race between the two payouts drawing on the same available balance; a webhook delivered twice or out of order. Sections 5–6 pin each one to a guardrail.

## 3. Actors and what each needs to see

| Actor | Their question | What the system owes them |
|---|---|---|
| **Kira Ops** (primary UI user) | "Do the books balance *right now* — and if not, where exactly?" | Transfer timelines with live state + confirmations, the navigable ledger (every entry, every fee), the recon report with both mismatch types, dedupe evidence |
| **Northwind** (Client treasurer) | "Where is my money and what did it cost to move?" | Omnibus + per-sub-client balances with pending/available split, fee itemization per deposit, route audit trail, payout status |
| **Sub-Clients** | (structure, not active users here) | Own balance and history within the omnibus |
| **Vendor / Counterparty** | Never touch the system | Registered counterparty details; deposit instructions (address per chain) attributable to the right account |
| **The auditor** (implicit) | "Reconstruct any balance at any past instant" | Append-only history — the reason corrections are compensating entries, never edits |

UI implication for Days 3–4: **one app, an Ops view first** (it's what the evaluator opens), with a client-scoped view second. No sub-client portal.

## 4. The ledger model

### 4.1 Chart of accounts

**Assets** (what Kira controls in the world — each mirrors an external source of truth):
- `asset:crypto:solana:usdc`, `asset:crypto:polygon:usdt` — 1:1 mirrors of our deposit wallets. Ledger balance == on-chain balance *is* the reconciliation.
- `asset:bank:omnibus:{provider}` — one mirror per fiat provider (each reconciles against a different statement).
- `asset:transit:*` (offramp, ach_outbound, onramp) — **money in flight**. These accounts are what make the crash window *visible*: any aged balance sitting in transit is, by definition, an entry-never-confirmed waiting to be investigated. They must trend to zero.

**Liabilities** (what Kira owes):
- Per Sub-Client: pending and available tracked as separate **buckets** — never mixed.
- `liability:outbound_hold:{client}` — funds reserved for in-flight payouts (available drops the instant a payout starts, not when it settles).
- `liability:{client}:markup_earned` — the Client's markup margin (not Kira revenue).

**Revenue/expense**: `revenue:platform_fee`, `revenue:passthrough_recovery` / `expense:provider_fees`, and `equity:rounding_residual` — rounding dust and peg slippage are absorbed by the house in an *explicit, observable* account. If it grows abnormally, we have a conversion bug and we can see it.

**System**:
- `conversion:{asset}` — paired conversion (trading) accounts, one per asset, that join single-asset legs of a cross-asset transaction at an explicit rate. The pair opens when a deposit is detected and closes when its ramp settles — **a nonzero conversion balance *is* money mid-conversion (or a rate bug)**, visible by query. (Every ledger transaction already nets to zero on its own — no "world" counter-account is needed for balancing; the outside world shows up as assets and liabilities moving in lockstep.)
- `asset:receivable:{client}` / `expense:reorg_loss` — where a post-threshold reorg clawback lands when the client's available can't cover it (§6 R8).

### 4.2 Structural rules

1. **Double-entry, enforced by the database.** Entries are grouped in ledger transactions; a **deferrable constraint trigger** (`INITIALLY DEFERRED` — Postgres has no deferred CHECK; it fires per row at commit, so the validation must be once-per-transaction guarded) verifies `SUM(amount) = 0` per `(transaction, asset)`. Unbalanced money is not a bug to catch in review — it is physically uncommittable.
2. **Append-only, enforced by the database.** `UPDATE`/`DELETE` on entries is revoked and trigger-blocked. Corrections — reorgs, ACH returns, failed payouts — are *new compensating entries* that net to zero and tell the true story ("we saw a deposit, the chain undid it, we reversed it").
3. **Balances are queries.** `balance(account, bucket) = SUM(entries)`. No stored balance exists anywhere, per the glossary. (The `spend_guards` reservation counter of §6 R5 is not a balance — it is a rebuildable concurrency lock, and the ledger always wins.)
4. **Pending → available is a new transaction** (−pending / +available), never a mutation of an existing entry. That is how pending/available coexists with append-only.
5. **Multi-asset ledger, USD client books.** Client liabilities are **always USD on the books, from the very first entry** — exactly as the glossary demands. Native minor units (`BIGINT` + an `assets(symbol, chain, decimals)` registry — decimals are data, never code) live *only* on asset-mirror/transit/conversion accounts, which track Kira's assets against chain truth; they are not the client's claim. Any cross-asset transaction is built from single-asset legs, each summing to zero, joined through the `conversion:{asset}` pair at an explicit rate — cross-asset entries never appear in one leg. No floats anywhere on the money path — including fee math (basis points as integers, divided through the `Money` rounding function of DECISIONS #8, never raw integer truncation) and JSON (amounts as strings).

### 4.3 Core tables (sketch)

```
assets(id, symbol, chain, decimals)                     -- 'USDC.solana' → 6; decimals are config
clients(id, name, parent_id)                            -- parent_id NULL = Client, else Sub-Client
accounts(id, client_id, kind, asset_id)                 -- kind: client|sub_client|chain_inbound|
                                                        --  fee_revenue|transit|external|...
ledger_transactions(id, type, transfer_id, external_ref, created_at)
ledger_entries(id, transaction_id, account_id, asset_id,
               bucket,                                  -- pending | available | hold
               amount_minor,                            -- signed BIGINT, ≠ 0; the sign IS the
                                                        --  glossary's "direction" (debit/credit)
               created_at)                              -- append-only (trigger + REVOKE)
transfers(id, account_id, direction, type, rail, asset_id, amount_minor,
          counterparty_id, status, tx_hash, provider_ref, client_idem_key,
          route_execution_id, ...)
transfer_events(id, transfer_id, from_status, to_status, detail, created_at)
routes(id, account_id, match, active) / route_actions(route_id, seq, action)
route_executions(id, route_id, trigger_transfer_id, status,
                 UNIQUE(route_id, trigger_transfer_id)) -- a route fires ONCE per deposit
fee_schedules(client_id, platform_bps, fixed_minor, markup_bps)
fee_applications(transfer_id, fee_type, amount_minor, ledger_transaction_id,
                 UNIQUE(transfer_id, fee_type))         -- fees can't double-apply on retry
idempotency_keys(scope, key, request_hash, response, status, PK(scope,key))
outbox(id, transfer_id, provider, operation, payload,
       provider_idem_key UNIQUE, status, attempts, next_retry_at)
webhook_events(provider, external_event_id, payload, signature_ok,
               processed_at, PK(provider, external_event_id))
spend_guards(account_id, asset_id, bucket,
             headroom_minor CHECK (>= 0))               -- concurrency reservation counter, NOT a
                                                        --  balance: rebuildable from SUM(entries)
                                                        --  at any time; see §6 R5
```

`external_ref` (tx hash / provider ref) on every ledger transaction is what turns end-of-day reconciliation into two anti-joins — it exists from day 1 precisely so recon is a query, not a project.

### 4.4 The Northwind flow as actual entries

Worked example — fee schedule: platform 0.50%, fixed pass-through $1.00, client markup 0.25% (see DECISIONS #5). Dr/Cr; stored as integer minor units. Every transaction below sums to zero **per asset**; cross-asset movements balance through the `conversion:*` pair (§4.1). The client's liability is in **USD from the first entry** — native units appear only on Kira's asset mirrors.

**T1 — Deposit detected (0 confirmations)** — idempotency key `(chain, tx_hash, instruction_index)`. The USDC hits our wallet mirror; the client's claim is booked in USD at the 1:1 peg (DECISIONS #6), joined through the conversion pair:
```
USDC leg (sums to zero in USDC):
Dr  asset:crypto:solana:usdc [pending]        5,000.000000 USDC
Cr  conversion:usdc.solana                    5,000.000000 USDC
USD leg (sums to zero in USD):
Dr  conversion:usd                                5,000.00
Cr  liability:northwind:sub1 [pending]            5,000.00
```

**T2 — Threshold reached → off-ramp client leg.** Pure USD — the conversion already happened at the peg in T1; here the pending claim becomes spendable, with fees itemized on the gross (25.00 + 1.00 + 12.50):
```
Dr  liability:northwind:sub1 [pending]            5,000.00
Cr  liability:northwind:sub1 [available]          4,961.50
Cr  revenue:platform_fee                             25.00
Cr  revenue:passthrough_recovery                      1.00
Cr  liability:northwind:markup_earned                12.50
```
(The USDC asset mirror moves buckets in the same commit: Dr `asset…usdc [available]` / Cr `asset…usdc [pending]`.)

**T3 — Off-ramp asset settlement.** Client credit (T2) and asset settlement are deliberately decoupled — Kira lends the float in between (DECISIONS #7):
```
Dr  asset:transit:offramp                     5,000.000000 USDC
Cr  asset:crypto:solana:usdc [available]      5,000.000000 USDC
--- provider settles: USD lands at the bank ---
USDC leg:  Dr conversion:usdc.solana 5,000.000000 · Cr asset:transit:offramp 5,000.000000
USD  leg:  Dr asset:bank:omnibus:provider_a 5,000.00 · Cr conversion:usd 5,000.00
```
Both conversion accounts opened in T1 now net to zero — the conversion is closed end to end. Had the rate not been exactly 1:1, the residue would post to `equity:rounding_residual` (DECISIONS #8).

**T4 — Route fires → ACH payout $4,200.** The hold is where the no-negative invariant lives — this debit only commits if available ≥ 4,200, atomically:
```
Dr  liability:northwind:sub1 [available]          4,200.00
Cr  liability:outbound_hold:northwind             4,200.00
--- provider settles ---
Dr  liability:outbound_hold:northwind             4,200.00
Cr  asset:bank:omnibus:provider_a                 4,200.00   (via asset:transit:ach_outbound)
```

**T5 — Route fires → on-ramp 600 USDT on Polygon.** Outbound fees go on top (the vendor receives exactly 600.000000 USDT): 3.00 + 1.00 + 1.50. The full 605.50 is held, but **fees are recognized only at settlement** — revenue is never booked for a service not delivered, and a failed payout releases everything with one compensating pair:
```
Hold:
Dr  liability:northwind:sub1 [available]            605.50
Cr  liability:outbound_hold:northwind               605.50
Settled (conversion transaction; the USDT asset/transit legs mirror T3 symmetrically):
Dr  liability:outbound_hold:northwind               605.50
Cr  conversion:usd                                  600.00
Cr  revenue:platform_fee                              3.00
Cr  revenue:passthrough_recovery                      1.00
Cr  liability:northwind:markup_earned                 1.50
Failed instead:
Dr  liability:outbound_hold:northwind               605.50
Cr  liability:northwind:sub1 [available]            605.50   (nothing to claw back)
```

**End state, provable by query:** sub1 available = 4,961.50 − 4,200.00 − 605.50 = **$156.00**. Every transaction sums to zero per asset; nothing was ever mutated. An ACH return 30 days later? A new compensating pair — history intact.

## 5. Transfer state machines

Transitions are the contract the Day 3 code transcribes. Every transition is an `UPDATE … WHERE status = <expected>` (rowcount 0 ⇒ someone else won ⇒ no-op), and every transition appends a `transfer_events` row.

**Inbound crypto:**
```
detected → confirming → confirmed → offramped(credited)  → [routes evaluate]
    │           └→ reorged_out   (compensate pending; tx may reappear = NEW transfer)
    └→ rejected                  (wrong token/amount/address → quarantine, never silent credit)
```

**Outbound (fiat or crypto):**
```
created → funds_held → submitted → pending_settlement → settled
             │             └→ failed → funds_released  (hold → available, compensating)
             └→ failed(insufficient_funds)             (the CHECK aborted the hold)
                                     pending_settlement → returned   (late ACH return)
```
States only move forward; a late/duplicate webhook for a superseded state is recorded and ignored. For the USDT leg, "settled" = our own send reaching its confirmation threshold on Polygon. `funds_held` reserves the full amount *including* fees, but fees are only recognized at `settled` (§4.4 T5) — so `funds_released` is always a single compensating pair, never a fee clawback.

## 6. Where money can't race

The rule behind every guardrail: **the invariant lives in Postgres, where it cannot race** — a constraint or row lock, never "read balance, decide in memory, write."

| # | Hazard (where in the flow) | Guardrail |
|---|---|---|
| R1 | Deposit detected twice (poller restart, poller+webhook overlap) | `UNIQUE(chain, tx_hash, instruction_index)` + `INSERT … ON CONFLICT DO NOTHING`; only the winning insert posts the ledger tx, same commit. The instruction index is not optional: one Solana tx routinely carries several SPL transfers — the key must admit all of them and dedupe each |
| R2 | Two workers both flip pending→available | Guarded transition (`WHERE status='confirming'`) + partial unique on `(transfer_id, type='deposit_confirmed')` |
| R3 | Fees applied twice on worker retry | `UNIQUE(transfer_id, fee_type)` — retry becomes a no-op |
| R4 | **Route fires twice** (event redelivery ⇒ two ACHs, two USDT sends) — *the* double-spend of this challenge | `UNIQUE(route_id, trigger_transfer_id)`; only the winner creates child transfers, in the same DB tx |
| R5 | Concurrent payouts overdraw available (incl. a flood of them) | Two-phase hold: `UPDATE spend_guards SET headroom = headroom − x` with `CHECK (headroom ≥ 0)` in the same tx as the hold entries. The row lock serializes; the CHECK makes negative a theorem violation, not a code path. The guard is **not a balance** in the glossary's sense — the balance remains `SUM(entries)`, per the glossary's "derived, never stored" rule; this is a *concurrency reservation counter*, rebuildable from the ledger at any moment (a recon job asserts `guard == SUM(entries)` and a rebuild routine proves it). At RappiPay-scale wallets, read-modify-write on a stored balance is the classic incident; this shape is what avoids it without giving up the lock |
| R6 | **Crash window**: hold written, provider never called (or vice versa) | Transactional **outbox**: hold entries + transfer + outbox row with a *deterministic* provider idempotency key (`payout:{transfer_id}`) commit atomically. A separate dispatcher calls the provider with that key; providers dedupe by it. Recovery *queries the provider by reference before ever retrying*. Never HTTP inside a DB transaction. Exactly-once doesn't exist between systems — at-least-once + dedupe + recon does |
| R7 | Webhook duplicated / out of order / forged | HMAC signature over raw body + timestamp tolerance (replay), `PK(provider, event_id)` insert-first dedupe, monotonic state machine (no backward transitions) |
| R8 | Reorg | Before threshold: compensate pending (structurally no loss — pending is unspendable). After threshold + spent: with Solana at `finalized` this is essentially precluded — the post-threshold path exists for probabilistic-finality chains (Polygon's N-block threshold) and as defense-in-depth. Handling: claw back the client's *remaining* available and book any shortfall to `asset:receivable:{client}` (write-off to `expense:reorg_loss` only if uncollectable). The `CHECK (≥ 0)` guard is **never** bypassed — client books never go negative; the hole has a named owner instead (DECISIONS #10) |
| R9 | API caller retries `POST /transfers` | `idempotency_keys` insert-first: replay same key+body → stored response; same key, different body → 422; in-flight → 409 |

## 7. Architecture boundaries & extensibility

A **modular monolith on Postgres** — every critical invariant is a Postgres guarantee (constraint, unique index, transaction, row lock), not distributed-systems discipline. One process (web + worker), communicating through the database: outbox as the queue (`FOR UPDATE SKIP LOCKED`), guarded updates as the state machine.

- **Ledger Core** — the *only* module that writes `ledger_entries`. One door for money.
- **Chain Gateway (port)** — two implementations per chain: *real* (Solana devnet / Polygon Amoy, polling watchers with persisted cursors — restart-safe, dedupe makes re-scan harmless) and a *simulator* (deterministic demos, reorg injection, CI without faucets). The simulator doesn't replace the real leg; it exists because money systems must be tested against failures you can't provoke on demand.
- **Fiat Provider port** — `createPayout(clientReference, …)`, `getPayout(ref)`, `verifyWebhook(raw)`; canonical domain states and a retryable/terminal error taxonomy. This is my day job at Yuno: the port must speak *domain*, never leak a provider's vocabulary upward, and every provider eventually delivers a duplicate or out-of-order webhook — dedupe is not optional. Two deliberately different mocks (shapes are a preview, to be confirmed when the fiat brief lands — see DECISIONS #18): *AcmePay* (async, 202 + signed webhooks with duplicates and disorder built in, amounts in cents) and *LegacyBank* (sync accept + polling, no webhooks, `"4200.00"` string amounts, ACH-style return codes). The orchestrator can't tell them apart; the same test suite runs against both — that's the proof the abstraction is real. A third provider is a new adapter behind the *existing* port plus a config row — no rewrite of the ledger core or the orchestrator, which is the glossary's actual bar.
- **Recon worker** — EOD job (also trigger-by-endpoint for demos): two anti-joins per mirror account. External txs with no ledger entry ⇒ *settled-with-no-entry*; in-transit entries past SLA with no external confirmation ⇒ *entry-never-confirmed*. Plus the solvency check: Σ client liabilities ≤ Σ mirror assets.

## 8. What I'm deliberately not doing (and why)

- **No Kafka/Redis/microservices/event-sourcing framework** — the append-only ledger already *is* the event log; Postgres already gives transactional queues and locks. Complexity that doesn't buy correctness is scored against me — and against the system.
- **No Tron, Wire, SWIFT, FedNow implementations** — the required flow uses Solana, Polygon, ACH. The ports make the rest adapters, and the design names the seam; that's enough.
- **No generic FX / multi-currency** — books are USD by definition; stablecoin pegs are modeled as a rate (1:1 assumed, DECISIONS #6) so honesty is cheap later.
- **No real auth/multi-tenancy, no sub-client portal, no partial payouts** — one seeded Client (Northwind) with sub-clients; routes fire all-or-nothing per trigger (DECISIONS #13).

Every "no" here is an ADR in DECISIONS.md with the trade-off spelled out.
