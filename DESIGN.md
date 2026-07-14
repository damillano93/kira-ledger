# DESIGN.md — Kira Ledger & Orchestration Engine

> Deliverable 1 (Days 1–2): the business problem, the domain model, the ledger design, where money can race — and, per the Day 2 brief, the boundaries, the vendor abstraction, crash-consistency, reconciliation, and the named trade-offs. A teammate should be able to build from this without asking me anything; a reviewer should understand the invariants without any code.
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
- `conversion:{asset}` — paired conversion (trading) accounts, one per asset, that join single-asset legs of a cross-asset transaction at an explicit rate. On the off-ramp the pair opens at deposit detection (T1) and closes at ramp settlement (T3); on the on-ramp it opens and closes within the payout settlement (T5). Either way: **a nonzero aged conversion balance *is* money mid-conversion (or a rate bug)**, visible by query. (Every ledger transaction already nets to zero on its own — no "world" counter-account is needed for balancing; the outside world shows up as assets and liabilities moving in lockstep.)
- `suspense:recon` — where reconciliation corrections post while an exception is being classified (§9): an orphaned external movement is booked here first, then reclassified with a further compensating pair once ops resolves it. Never a silent write-off.
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
                                                        --  fee_revenue|transit|conversion|suspense|...
ledger_transactions(id, type, transfer_id,
                    external_source, external_ref,      -- e.g. ('solana', '{tx_hash}:{ix}'),
                    created_at)                         --  ('acmepay', '{provider_ref}') — refs
                                                        --  are only unique per source (§9)
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
fee_schedules(client_id, rail, platform_bps, fixed_minor, markup_bps,
              UNIQUE(client_id, rail))                  -- per-rail from day one: ACH row = zeros
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
chain_cursors(chain, last_processed_ref, updated_at)    -- watcher resume point; re-scan overlaps
external_truth(id, source, external_id, amount_minor,   -- ingested statements & chain scans,
               observed_at)                             --  append-only; recon input (§9)
recon_exceptions(id, kind, source, external_id,         -- kind: settled_no_entry |
                 transfer_id, status, created_at)       --  entry_never_confirmed; append-only
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

## 7. System boundaries: API / domain / workers

A **modular monolith on Postgres** — every critical invariant is a Postgres guarantee (constraint, unique index, transaction, row lock), not distributed-systems discipline. One deployable (web + worker loops), communicating through the database: outbox as the queue (`FOR UPDATE SKIP LOCKED`), guarded updates as the state machine.

```
                     ┌──────────────────────────────────────────────────┐
  Ops / Client UI ──▶│ API layer (HTTP)                                 │
                     │ Idempotency-Key middleware · webhook endpoints   │
                     │ (verify sig → persist event → 200, process async)│
                     └────────────────────┬─────────────────────────────┘
                                          │ in-process calls
                     ┌────────────────────▼─────────────────────────────┐
                     │ Domain core (pure, no I/O)                       │
                     │ Money · fee engine · transfer state machines ·   │
                     │ route evaluation · **Ledger Core** — the ONLY    │
                     │ module that writes ledger_entries. One door.     │
                     └────────────────────┬─────────────────────────────┘
                                          │ SQL transactions
                     ┌────────────────────▼─────────────────────────────┐
                     │ Postgres — source of truth AND coordinator       │
                     │ ledger · transfers · outbox · webhook_events ·   │
                     │ idempotency_keys · spend_guards · chain_cursors  │
                     └────────────────────┬─────────────────────────────┘
                                          │ claim work (SKIP LOCKED)
                     ┌────────────────────▼─────────────────────────────┐
                     │ Workers (same deployable, separate loops)        │
                     │ outbox dispatcher · chain watchers · confirmation│
                     │ tracker · poller (LegacyBank) · recon job        │
                     └─────────┬───────────────────────┬────────────────┘
                               │ FiatProvider port     │ ChainGateway port
                     ┌─────────▼──────────┐  ┌─────────▼──────────────┐
                     │ AcmePay (mock)     │  │ Solana devnet · Polygon│
                     │ LegacyBank (mock)  │  │ Amoy · simulator       │
                     └────────────────────┘  └────────────────────────┘
```

Two boundary rules make the whole thing reason-about-able:

1. **The API layer never talks to a provider or a chain.** It validates, posts ledger transactions, and enqueues outbox rows — all in one DB transaction. Only workers cross the system boundary, and only by draining the outbox. This is what makes the crash window (§8) tractable: intent is always durable before any external call.
2. **The domain core does no I/O.** Money math, fee computation, state-transition legality, and route evaluation are pure functions — testable without a database, reusable from API and workers alike.

### 7.1 The vendor abstraction — provider #3 as a config change

The port speaks *domain*, never a provider's vocabulary (my day job at Yuno is exactly this — normalizing PSPs with genuinely different shapes behind one API — and the lesson is that any provider concept that leaks upward becomes a rewrite later):

```
FiatPayoutProvider:
  name: string                                      # registry key
  createPayout({ clientReference,                   # deterministic: payout:{transfer_id}
                 amountCents, currency,             # canonical units — adapters translate
                 counterparty, rail })
    → { providerRef?, status: CanonicalStatus }
  getPayout({ clientReference } | { providerRef })  # ALWAYS implemented — recovery (§8)
    → { status: CanonicalStatus, failureReason? }   #  and recon (§9) depend on it
  verifyWebhook(rawBody, headers)                   # only for push providers; poll providers
    → DomainEvent | invalid(reason)                 #  get a poller that synthesizes the same
                                                    #  DomainEvents — one path downstream
```

**Canonical states and the two mock shapes** (previews — see DECISIONS #18/#19):

| Canonical | *AcmePay* (async, push) | *LegacyBank* (sync accept, poll) |
|---|---|---|
| `initiated` | `202 {status:"pending"}` | `{"sts":"ACCEPTED"}` |
| `processing` | webhook `processing` | poll `IN_TRANSIT` |
| `settled` | webhook `completed` | poll `SETTLED` |
| `failed` (terminal) | webhook `rejected` + code | return codes `R01…` |
| `returned` (late) | webhook `reversed` | poll `RETURNED` |
| amounts | integer cents | string `"4200.00"` |
| dedupe | by `client_reference` | by `client_reference` |

Canonical states map 1:1 onto the §5 outbound machine: `initiated` = the ack that moves `funds_held → submitted`; `processing` drives `submitted → pending_settlement`; `settled`, `failed`, and `returned` drive their like-named transitions (a `failed` triggers `funds_released`; a late `returned` posts its compensating pair).

Adapters translate three things: units (string dollars ↔ cents), status vocabulary (mapped to canonical states above), and error taxonomy (**retryable vs terminal** — the only distinction the orchestrator needs). AcmePay's mock deliberately delivers duplicate and out-of-order webhooks; LegacyBank deliberately has transient timeouts. That's not sadism — it's the test harness for §8.

**Why provider #3 is a config change:** providers register in a config-driven registry (`rail → provider name → adapter + credentials + notification strategy`). Adding *FastACH Inc.* means implementing the 3-method port (a mock adapter is ~50 lines) and adding one config entry. The ledger core, orchestrator, recon, and UI don't change — they never knew provider names, only canonical states. The proof is mechanical: **one parameterized contract-test suite runs against every registered adapter**; a new adapter passes the same suite or doesn't ship. (This is also my prepared Day 5 live-change.)

### 7.2 The chain gateway

Same port philosophy for chains: `watchDeposits(cursor)`, `getConfirmations(txRef)`, `sendToken(…)` with two implementations per chain — *real* (Solana devnet / Polygon Amoy: polling watchers with persisted cursors and overlap re-scan; restart-safe because dedupe by `(chain, tx_hash, instruction_index)` makes re-scanning harmless) and a *simulator* (deterministic demos, reorg injection, CI without faucets). The simulator doesn't replace the real leg; it exists because money systems must be tested against failures you can't provoke on demand — you cannot order a reorg from devnet.

## 8. Failure & crash-consistency

**The crash window, named:** the process can die between the ledger write and the provider call — or between the provider call and recording its result. Order matters, so the rule is fixed: **ledger first, always; never HTTP inside a DB transaction.** Intent is committed atomically (hold entries + transfer + outbox row with a deterministic `provider_idem_key = payout:{transfer_id}`), then a dispatcher makes the external call. Walking every crash point of an outbound payout:

| # | Crash point | What exists | Recovery |
|---|---|---|---|
| C1 | Before the hold transaction commits | Nothing — atomicity | Caller retries with the same `Idempotency-Key` → clean re-execution |
| C2 | After commit, before dispatcher claims | Hold + outbox `pending` | Next dispatcher loop claims it. No special case |
| C3 | Dispatcher called provider, died before recording the ack | Outbox `in_flight`, provider *may* know the payout | Recovery sweep: any `in_flight` older than T → **`getPayout(clientReference)` first**. Provider knows it → record ack and move on. Provider doesn't → re-send with the *same* `clientReference`; the provider dedupes. Never a blind retry |
| C4 | Provider settled, webhook lost / never delivered | Transfer aged in `pending_settlement` | The poller (LegacyBank) or an aged-state sweep (AcmePay) calls `getPayout`; recon (§9) is the final backstop — this is exactly an *entry-never-confirmed* |
| C5 | Webhook received, crash before processing | Event persisted (insert-first, `PK(provider, event_id)`) | Events are processed async from the persisted row; provider redelivery is a keyed no-op |

Inbound is symmetric and simpler: the watcher's cursor is persisted, restart re-scans with overlap, and `(chain, tx_hash, instruction_index)` makes every re-scan idempotent. For outbound crypto, intent = the signed transaction persisted before broadcast; recovery queries by signature, and re-signs only after the blockhash window (~150 slots ≈ 60s) has expired (DECISIONS #12).

**Idempotency keys, precisely** (every dedupe is a Postgres row — none lives in process memory):

| Surface | Key | Mechanism | On replay |
|---|---|---|---|
| Inbound crypto deposit | `(chain, tx_hash, instruction_index)` | `UNIQUE` + `ON CONFLICT DO NOTHING` | Silent no-op; only the winning insert posts entries |
| Public API (create transfer/payout) | `Idempotency-Key` header, scoped per route + account | `PK(scope, key)` insert-first; stores `request_hash` + response | Same key+body → stored response. Same key, different body → `422`. In flight → `409` |
| Outbound provider call | `provider_idem_key = payout:{transfer_id}` | `UNIQUE` on outbox; provider contract requires dedupe by client reference | Provider returns the original result |
| Webhook delivery | `(provider, event_id)` | `PK` insert-first; HMAC over raw body + timestamp tolerance | Duplicate → no-op; replayed/stale → rejected |
| Ledger posting per business step | `(transfer_id, transaction type)` | Partial `UNIQUE` on `ledger_transactions` | A retried worker cannot double-post fees or confirmations |
| Route firing | `(route_id, trigger_transfer_id)` | `UNIQUE` on `route_executions` | A redelivered "deposit confirmed" event cannot fire the route twice |

Webhooks are hostile input: signature verified over the raw body, timestamp window against replays, keyed dedupe against duplicates, and **monotonic state machines** against disorder — a `settled` can't regress to `processing`; a late event for a superseded state is recorded and ignored. Exactly-once between systems doesn't exist; what this section builds is at-least-once delivery + keyed dedupe at every receiver + reconciliation as the backstop — which converges to the same observable result.

## 9. Reconciliation as a query

Because the ledger is append-only and every ledger transaction carries an `external_ref`, end-of-day reconciliation is not a process — it's two anti-joins over facts. External truth (chain scans, provider statements via `getPayout`/statement endpoints) is ingested into an `external_truth` table (also append-only; recon *never* mutates the ledger):

Refs are only unique *per source* (AcmePay and LegacyBank can emit colliding ids; a deposit's grain is `tx_hash:instruction_index`), so every join is on the pair `(source, id)`:

**Mismatch type 1 — settled-with-no-entry** (the world moved money we didn't record: a missed deposit, a webhook that never arrived, the C3 window's far side):

```sql
SELECT e.source, e.external_id, e.amount_minor
FROM   external_truth e
LEFT   JOIN ledger_transactions lt
       ON (lt.external_source, lt.external_ref) = (e.source, e.external_id)
WHERE  lt.id IS NULL
  AND  e.observed_at <= :cutoff;
```

**Mismatch type 2 — entry-never-confirmed** (we recorded intent that, past its rail's SLA, has no matching external fact — the C2/C4 windows, a broadcast tx that never landed). A true anti-join in the other direction, not just an age heuristic — a late-arriving statement row must *clear* the transfer, not leave it flagged:

```sql
SELECT DISTINCT t.id, t.status, now() - t.created_at AS age
FROM   transfers t
JOIN   ledger_transactions lt ON lt.transfer_id = t.id
                             AND lt.type IN ('payout_submitted', 'deposit_detected')
LEFT   JOIN external_truth e
       ON (e.source, e.external_id) = (lt.external_source, lt.external_ref)
WHERE  e.id IS NULL
  AND  t.status IN ('submitted', 'pending_settlement')
  AND  now() - t.created_at > :sla_for(t.rail);
```

A statement row that *does* match a still-pending transfer is not a mismatch at all — it's a late confirmation: recon feeds it down the same DomainEvent path a webhook would take, and the transfer settles normally.

— equivalently visible as any **aged balance in a transit account**, which is why those accounts exist (§4.1). Three cheap integrity checks ride along: **solvency** (Σ client liabilities ≤ Σ mirror assets, per asset), **guard honesty** (`spend_guards.headroom == SUM(entries)` per account), and **conversion closure** (aged nonzero `conversion:*` pairs = ramps stuck mid-flight). Findings land as rows in `recon_exceptions` (append-only, with resolution state); corrections are always *new compensating entries* against a suspense account — reconciliation reports, it never edits. Because nothing is ever mutated, the same queries answer "did we balance *yesterday at 23:59*?" with a `WHERE created_at <= :t` — try that with mutated balances.

## 10. Named trade-offs

The calls I'm making, what I rejected, and the cost I'm knowingly accepting (each has a full ADR):

| Call | Rejected alternative | Accepted cost | ADR |
|---|---|---|---|
| Modular monolith, Postgres as coordinator | Microservices, brokers, Redis | No independent scaling; single DB is the bottleneck (fine at this volume) | 001 |
| `BIGINT` minor units + per-asset registry | `NUMERIC` everywhere; universal micro-USD unit | Must switch raw column to `NUMERIC(38,0)` the day an 18-decimal asset lands | 002 |
| USD client books from entry one; native units on mirrors only | Token-denominated client claims until off-ramp | Peg assumed at booking time (funds are unspendable pending, so no spendable-rate risk) | 003 |
| Guard row + `CHECK (≥ 0)` for no-negatives | `FOR UPDATE` + re-SUM; SERIALIZABLE + retries | Payouts serialize per account; guard must be provably rebuildable | 004 |
| Fees at ramps, per-rail schedule (ACH configured at 0) | Fee on every hop | Must defend the asymmetry commercially; one config row flips it | 005 |
| Credit available at chain confirmation | Credit only at off-ramp settlement | Kira lends the float; exposure = aged transit, capped and observable | 007 |
| Outbox, ledger-first, query-before-retry | Provider-first; 2PC (doesn't exist over HTTP); saga without persisted intent | A dispatcher loop + recovery sweep to build and test | 012 |
| Routes all-or-nothing, no partials | Priority/partial fills | A route can stall on insufficient funds (visible, retryable state) | 013 |
| Polling watchers + simulator behind one port | WebSocket subscriptions | Seconds of latency; two implementations to keep honest via contract tests | 014 |
| TypeScript + Postgres + Railway | Go/Python; fancier infra | Single-language leverage over raw runtime performance | 015 |

## 11. What I'm deliberately not doing (and why)

- **No Kafka/Redis/microservices/event-sourcing framework** — the append-only ledger already *is* the event log; Postgres already gives transactional queues and locks. Complexity that doesn't buy correctness is scored against me — and against the system.
- **No Tron, Wire, SWIFT, FedNow implementations** — the required flow uses Solana, Polygon, ACH. The ports make the rest adapters, and the design names the seam; that's enough.
- **No generic FX / multi-currency** — books are USD by definition; stablecoin pegs are modeled as a rate (1:1 assumed, DECISIONS #6) so honesty is cheap later.
- **No real auth/multi-tenancy, no sub-client portal, no partial payouts** — one seeded Client (Northwind) with sub-clients; routes fire all-or-nothing per trigger (DECISIONS #13).

Every "no" here is an ADR in DECISIONS.md with the trade-off spelled out.
