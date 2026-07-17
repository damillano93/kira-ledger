# DECISIONS.md — running ADR log

> Format per entry: **Context → Options → Decision → Consequences (including what we give up)**.
> Entries are append-only, like the ledger: a reversed decision is a *new* entry referencing the old one.
> These calls are mine. I drafted with AI assistance (as the brief encourages) and validated every claim — several AI suggestions were wrong and got overridden; I note the interesting ones inline. Where a call comes from operating payment systems (orchestration at Yuno, consumer wallet/ledger at RappiPay), I say so.

---

## ADR-001 · Modular monolith on Postgres (2026-07-13)

**Context.** 5 days, ~2–3 h/day; scoring is "correctness per unit of complexity"; three automated guardrails (no floats, idempotency, no negative balances).
**Options.** Microservices + broker; serverless functions; modular monolith with Postgres as both store and coordinator.
**Decision.** Modular monolith (web + worker in one deployable), Postgres for everything: outbox table as queue (`FOR UPDATE SKIP LOCKED`), unique constraints as idempotency, row locks + CHECK as balance enforcement.
**Consequences.** Every critical invariant is a database guarantee, testable and pointable-at in the final call. We give up independent scaling and fashionable architecture diagrams — irrelevant at this volume. Modules keep clean interfaces so extraction stays possible.

## ADR-002 · Money representation: integer minor units, no floats anywhere (2026-07-13)

**Context.** A float on a balance is an automatic disqualification; per-chain decimals differ.
**Options.** `NUMERIC` everywhere; `BIGINT` minor units; normalize all assets to micro-USD.
**Decision.** `BIGINT` minor units per asset (USD = cents; USDC.solana = 6-decimals raw), decimals read from an `assets(symbol, chain, decimals)` registry — never hardcoded. Amounts as **strings** in JSON (API and on-chain parsing); `BigInt` in application code; fees computed in integer basis points, with the division going through the `Money` rounding function of ADR-008 — **never raw BigInt division, which truncates toward zero** and would silently bias every fee against the client (an AI draft proposed `amount * 30n / 10_000n` verbatim; overridden for exactly this reason). A single `Money` module owns all conversion; a CI grep bans `parseFloat`/`Number(` on money paths.
**Consequences.** For this challenge's assets (6-decimal stablecoins, 2-decimal USD) BIGINT has enormous headroom. The honest caveat: an 18-decimal ERC-20 overflows int64 at roughly **9.2 whole tokens** — so the moment such an asset enters the registry, its raw column must be `NUMERIC(38,0)`; noted as the trigger condition, not a vague "at scale". Normalizing to one universal unit was rejected: it destroys the exact on-chain amount and breaks reconciliation.

## ADR-003 · Multi-asset ledger; ramps are conversion transactions (2026-07-13)

**Context.** Books are USD, but the Northwind flow has real USDC/USDT legs that must reconcile against chain truth.
**Options.** Mono-USD ledger with crypto tracked off-ledger; multi-asset ledger balancing per asset.
**Decision.** Multi-asset ledger, **USD client books from the first entry** — the glossary's "money is always tracked in USD on the books" applies to the client's claim, and the design honors it literally: the pending liability is booked in USD at the peg the moment the deposit is detected. Native minor units live *only* on Kira's asset-mirror/transit/conversion accounts, which exist to reconcile against chain truth and are not "money on the books" in the glossary's sense. Cross-asset transactions are built from single-asset legs joined through paired `conversion:{asset}` accounts at an explicit rate — the pair opens at detection and nets to zero when the ramp settles, so an open conversion balance is itself the in-flight signal.
**Note.** An earlier draft denominated the client's pending claim in USDC until the off-ramp; reverted — it read naturally for recon but contradicts the glossary's letter, and the USD-at-peg booking loses nothing (the funds are unspendable pending anyway, and reorg reversal compensates both legs).
**Consequences.** Slightly more ledger machinery; in exchange, on-chain reconciliation is a query instead of a side spreadsheet.

## ADR-004 · No-negative-balance enforcement: two-phase hold + guard row with CHECK (2026-07-13)

**Context.** Concurrent payouts (and the scorer's flood test) must never overdraw available. The check must live where it can't race.
**Options.** (a) `SELECT … FOR UPDATE` + re-SUM inside the tx; (b) SERIALIZABLE + retry everywhere; (c) hold entries + a `spend_guards` reservation row updated in the same tx with `CHECK (headroom_minor >= 0)`.
**Decision.** (c). The `UPDATE` takes a row lock (serializing concurrent payouts per account/bucket); the CHECK aborts the whole transaction — hold entries included — if funds are insufficient. Deliberately named `spend_guards.headroom_minor`, **not** "balance": the glossary forbids a stored, mutated balance, and this isn't one — the client's balance remains `SUM(entries)`, and the guard is a *concurrency reservation counter*, rebuildable from the ledger at any moment (a rebuild routine + a recon assertion `guard == SUM(entries)` make that claim testable, and recon defines the ledger as the winner on any divergence, freezing payouts for that account until repaired).
**Consequences.** Payouts serialize per account (fine at this volume). (a) re-SUMs ever-growing history; (b) needs retry logic on every write path — one forgotten retry = intermittent live-demo failure. Both rejected with reasons, not ignorance.

## ADR-005 · Fee semantics: direction-dependent, computed on gross, fixed order (2026-07-13)

**Context.** The brief itemizes three fee components but doesn't say whether fees come out of the amount or on top.
**Decision.** *Inbound/off-ramp*: deducted from the amount (the external depositor can't be asked to pay more; 5,000 arrives, 4,961.50 credits). *Outbound/on-ramp*: on top (the vendor must receive the exact agreed figure — 600.00, not 596.97). All percentages computed on the **instructed amount** — the deposit gross inbound, the payout principal outbound (0.50% × 600, not × 605.50) — never on a net-of-fee cascade, which is circular and irreproducible. This honors the overview's "% by volume": the volume is the amount the client instructed to move. **Recognition timing**: inbound fees post when the client is credited (service delivered); outbound fees are *held* with the payout but only *recognized at settlement* — a failed payout releases the full hold in one compensating pair and revenue is never booked for a service not delivered.
Fees attach to **ramps** — the points where money changes rails and units, i.e. where Kira performs the conversion service the glossary prices ("off-ramp … apply fees"). The ACH payout is **not** a code exception: `fee_schedules` is per-rail from day one, and the ACH rail is simply *configured at zero* for this client — defensible to Northwind's treasurer as "you pay when money changes worlds, not for every hop inside ours."
**Consequences.** Deterministic, reproducible fee math. If a later brief prices fiat payouts, that's editing one config row — the model already supports it.

## ADR-006 · Stablecoin rate: 1 USDC = 1 USDT = 1 USD, modeled as a rate (2026-07-13)

**Decision.** Peg assumed 1:1 for the challenge, but stored as an explicit rate on the ramp transaction, with `expense:peg_slippage` ready. Production would record the provider's execution price.
**Consequences.** Honesty is one config away; no FX engine built.

## ADR-007 · Client credit timing: available on chain-confirmation, not on off-ramp settlement (2026-07-13)

**Context.** The USDC is confirmed on-chain before the fiat side of the off-ramp settles at the bank.
**Options.** Credit available when the chain confirms (Kira lends the float); credit only when the off-ramp settles (zero risk, worse UX).
**Decision.** Credit at chain confirmation. It is a deliberate liquidity/float risk Kira takes for product quality; the transit accounts make the exposure observable at all times.
**Consequences.** A stuck off-ramp becomes Kira's funding problem, visible as an aged `asset:transit:offramp` balance — which is exactly where ops should see it.

## ADR-008 · Rounding: banker's (half-even) to the cent, per fee line, house absorbs residue (2026-07-13)

**Decision.** One rounding function in the `Money` module; round-half-even at the cent (a *choice*, not "the standard" — half-up is just as common in billing; half-even is chosen because it doesn't bias the dust systematically in either direction); each fee line rounds independently; never round intermediates; **all basis-point divisions go through this function** (see ADR-002 — raw integer division truncates, which is a directional bias, not a rounding policy). Worked tie example, since the Northwind numbers happen to divide cleanly: 0.50% × $445.00 = $2.225 → **$2.22** under half-even (half-up would say $2.23). Conversion residue and slippage post to `equity:rounding_residual` — explicit, observable, never hidden in a client amount.
**Consequences.** Sub-cent dust is a monitored account, not a silent leak. If it grows, we have a conversion bug and a graph that shows it.

## ADR-009 · Confirmation thresholds: per-chain config, not code (2026-07-13)

**Decision.** `Solana devnet`: commitment `finalized`. `Polygon Amoy`: N blocks (start 15, env-tunable; lowered for demos). Stored as config per chain. "Confirmed" is evaluated by re-querying the tx by hash against current chain state, never from process memory.
**Consequences.** Reorg-handling and demo speed are both turnable knobs, not deploys.

## ADR-010 · Reorg policy (2026-07-13)

**Decision.** Before threshold: compensating entries reverse the pending credit (no loss possible — pending is unspendable; the original entry is never deleted). Reappearing tx = new ledger transaction (idempotency key contemplates hash + status). After threshold with funds already spent: cannot be prevented, only mitigated by the threshold — and to be precise about when this path even fires: with Solana at `finalized` it is essentially precluded there; this machinery exists for probabilistic-finality chains (Polygon's N-block threshold) and as cheap defense-in-depth, not as an everyday path. Mechanism, made explicit so it composes with ADR-004's `CHECK (≥ 0)`: claw back the client's **remaining available** (down to zero at most — the guard is never bypassed and a client balance never goes negative); the entire shortfall is booked once, as `Dr asset:receivable:{client}` (a claim against the client); `expense:reorg_loss` is only touched later, to write off whatever proves uncollectable. Recovery, as always, is future entries.
**Consequences.** Full audit trail of what we knew and when; the pathological case has a named owner (the house) and a tracked receivable instead of a silent hole — and the no-negative invariant stays a theorem with zero exceptions.

## ADR-011 · Idempotency keys, per surface (2026-07-13)

**Decision.**
- Inbound crypto: `UNIQUE(chain, tx_hash, instruction_index)` — the index is not optional: a single Solana transaction routinely carries multiple SPL transfers (and an EVM tx multiple logs); the key must admit all of them and dedupe each one.
- Public API: `Idempotency-Key` header; table stores `request_hash` + response; same key+body → replayed response, same key different body → 422, in-flight → 409. Insert-first, never check-then-act.
- Outbound effects: deterministic `provider_idem_key = operation:{transfer_id}` via outbox; both mock providers **must dedupe by client reference** (a design requirement on the mocks — real providers do this).
- Webhooks: `PK(provider, event_id)` + HMAC + timestamp window.
**Consequences.** Every dedupe is a Postgres row, none depends on process memory or a cache.

## ADR-012 · Crash window: transactional outbox, ledger-first, query-before-retry (2026-07-13)

**Context.** The process can die between the ledger write and the provider call, or between the call and recording its result.
**Options.** Provider-first then ledger (creates unbacked money movement — can violate no-negative under concurrency); 2PC with an HTTP provider (doesn't exist); saga without persisted intent (dies with the process); transactional outbox.
**Decision.** Outbox. Hold entries + transfer + outbox row commit in one DB transaction; a dispatcher claims rows and calls the provider with the deterministic key; recovery re-queries the provider by reference before any retry; never HTTP inside a DB transaction. Crypto leg variant: persist the signed tx/signature before broadcast, query by signature on recovery. On Solana, a blockhash is valid for 150 slots (~60s); re-signing is safe only **after** waiting out that window (until then the original tx can still land — re-signing early risks a double send). Durable nonces are the canonical alternative if the wait is unacceptable; for this challenge, wait-then-re-sign is enough and simpler.
**Consequences.** Exactly-once becomes an emergent property (at-least-once + dedupe + recon as backstop) — and, critically, crash-recovery is *deterministically testable* by killing the dispatcher between steps.

## ADR-013 · Route semantics: all-or-nothing per trigger, declared order, no partials (2026-07-13)

**Context.** The brief doesn't define insufficient-funds behavior when a route's payouts exceed available, nor ordering.
**Options.** Atomic all-or-nothing; priority/partial fills; independent legs.
**Decision.** A route fires **once** per triggering deposit (`UNIQUE(route_id, trigger_transfer_id)`), evaluates against **net available post-fees**, reserves funds for all actions in one transaction in declared `seq` order, and goes `insufficient_funds` (visible, retryable) if the total doesn't fit. Once reserved, each payout leg lives its own lifecycle (ACH can settle while USDT is confirming); the execution records per-leg state. No partial amounts.
**Consequences.** Partials would complicate accounting and recon without being asked for. Auto-fire without human approval matches "standing rule"; routes are pausable from the UI, and production would want amount-threshold approvals — noted, not built.

## ADR-014 · Chain access: polling watchers with persisted cursors + a simulator behind the same port (2026-07-13)

**Options.** WebSocket subscriptions (real-time, lossy on reconnect); polling with cursor + overlap re-scan (slower, lossless — dedupe makes re-scan harmless).
**Decision.** Polling, cursor persisted in DB, recon as the backstop. The `ChainGateway` port has a real implementation (devnet/Amoy) and a **simulator** (deterministic demos, reorg injection, CI independence from faucets). Day 5 shows both: a real devnet deposit as proof, the simulator for the deterministic script and failure cases.
**Consequences.** Seconds of latency, zero lost events. The simulator is not a shortcut — money systems must be tested against failures you can't provoke on demand.

## ADR-015 · Stack (2026-07-13) — *provisional: implementation preview ahead of the Day 2–4 briefs; confirmed or superseded by a later entry*

**Decision.** TypeScript end-to-end: Node + Fastify, Postgres (non-negotiable — constraints/locks/outbox *are* the design), Drizzle for migrations with **hand-written SQL in the ledger core**, React (Vite) UI served by the same process, `@solana/web3.js` + `@solana/spl-token` (USDC deposits are SPL transfers — watch ATAs, not the wallet), `viem` on Polygon. Deploy: Railway + local `docker-compose up` with Northwind seed. Deploy the skeleton by Day 2–3, never Day 4.
**Consequences.** One language across the mandatory full stack; best Web3 ecosystem = lowest testnet risk; AI assistants (explicitly encouraged) are strongest in TS. Go/Python were viable; Solana tooling and the single-language UI tipped it.

## ADR-016 · Amoy has no canonical Tether USDT (2026-07-13) — *provisional, same caveat as ADR-015*

**Decision.** Deploy our own minimal ERC-20 test token labeled USDT (or use Circle's Amoy USDC faucet token under a config alias). Recorded as an explicit testnet assumption; the asset registry makes the swap a config row.

## ADR-017 · Scope exclusions (2026-07-13)

**Decision.** No KYC/compliance, no real auth/multi-tenancy, no sub-client portal, one seeded Client (Northwind) + sub-clients, fixed-amount route actions, Tron/Wire/SWIFT/FedNow as named seams only. Unknown tokens or off-instruction deposits are quarantined for ops review, never silently credited.
**Consequences.** Everything cut is listed, reversible, and was cut *on purpose* — correctness per unit of complexity.

## ADR-018 · Who builds the fiat mocks — a contradiction in the briefs, resolved (2026-07-13)

**Context.** The overview says "*give us* two providers with different shapes behind one abstraction" (we build them); the glossary says "the challenge *ships* two mock fiat providers" (Kira provides them). These cannot both be true.
**Decision.** Assume we build them (the overview is the instruction document; the glossary describes the end state). All mock shapes in DESIGN §7 are therefore previews. If a later brief ships Kira's own mocks, the provider port absorbs them as two adapters — which is the point of the port.
**Consequences.** Worst case, the invented shapes get thrown away and only the adapters are rewritten; the orchestrator and ledger don't move.

## ADR-019 · Day 2 brief confirmations (2026-07-14)

**Context.** The Day 2 brief arrived: finalize the design (vendor abstraction, boundaries, crash-consistency, precise idempotency keys, recon-as-query, named trade-offs) — build starts Day 3.
**Decision.** No reversals needed: the Day 1 skeleton already carried seams for all four focus areas; Day 2 deepened them in DESIGN §7–§10 rather than redesigning. Two updates to prior entries: (a) the brief's phrasing "*two mock fiat providers … must sit behind one interface*" reads as an instruction to us — **ADR-018's call (we build the mocks) stands**, shapes still marked preview until/unless a later brief ships Kira's own; (b) ADR-015 (stack) stays provisional until the first build commit lands on Day 3.
**Consequences.** Deliverable 1 closes with this push. The riskiest unknowns are now operational, not design: testnet faucets/RPCs, and whatever Day 3 adds. Per the Day 2 note, no feedback until after Deliverable 2 — the design is committed as-is and the build will run with it.

## ADR-020 · Concurrency & scalability: per-account row-lock serialization, async workers, honest bottleneck (2026-07-16)

**Context.** Day 3 builds the write path, so the concurrency story stops being a diagram and becomes code the scorer floods: a burst of simultaneous payouts against the **same** available balance. Correctness here is the guardrail "no negative balance," and it must hold under real contention, not just in a single-threaded happy path. This entry makes ADR-004 / §6 R5 concrete and names what breaks first — I'd rather state the ceiling than pretend there isn't one.

**Options.** (a) Read balance in the app, decide, write — the classic read-modify-write that *is* the RappiPay wallet incident under load; rejected outright. (b) `SELECT … FOR UPDATE` on the guard row, then a plain `UPDATE`, trusting only the `CHECK` to catch overdrafts via a raised exception. (c) The same row lock but with a **conditional** decrement whose `WHERE` clause *is* the funds test, with the `CHECK` retained as a structural backstop.

**Decision.** (c). Every payout reserves inside one transaction: `SELECT … FOR UPDATE` on the `spend_guards` row for `(account, asset, bucket)` (this is the "account balance" row for concurrency purposes — a reservation counter, **not** a stored balance; the client balance remains `SUM(entries)` per §4.2 and ADR-004), immediately followed by the guarded decrement

```sql
UPDATE spend_guards
   SET headroom_minor = headroom_minor - :amt
 WHERE account_id = :acc AND asset_id = :asset AND bucket = 'available'
   AND headroom_minor >= :amt;          -- rowcount 0  ⇒  insufficient funds ⇒ abort the tx
```

with `CHECK (headroom_minor >= 0)` on the column as the **structural backstop of last resort**. The `WHERE headroom_minor >= :amt` is what makes insufficient-funds a clean, branchable signal (rowcount 0 → we roll back the whole hold and return `funds_insufficient`) instead of an exception we have to catch off the `CHECK`; the `CHECK` still stands so that even a mistaken code path *cannot physically* commit a negative row.

**Why this cannot run negative even under a race.** The `FOR UPDATE` takes an exclusive row lock; a second concurrent payout for the same account **blocks** until the first transaction commits or aborts — Postgres serializes the two decrements. When the loser unblocks, it re-reads the *committed* post-decrement `headroom_minor` (locked reads see the latest committed row, not a stale snapshot), so its own `WHERE … >= :amt` is evaluated against truth, not against a value that already got spent. There is no lost update and no time-of-check/time-of-use gap: the check and the write are the *same* statement against a *locked* row. The `CHECK` closes the theoretical remainder — if application logic ever computed `:amt` wrong, the row still can't go below zero. Overdraft is therefore not a code path; it's a constraint violation, which is exactly where ADR-004 wanted the invariant to live.

**How it scales.** The request path never blocks on the outside world: a payout commits hold entries + transfer + outbox row (§7, §8) and returns; the **outbox dispatcher** and **chain watchers** are async worker loops that drain work via `FOR UPDATE SKIP LOCKED`, so the crypto confirmation listener and provider calls run *off* the HTTP path and can't stall it. Postgres is the single source of truth; the only materialized state is the `spend_guards` reservation counter, which is rebuildable from `SUM(entries)` at any time (recon asserts `guard == SUM(entries)`, §9). Idempotency holds the line under retries and duplicate delivery precisely because every dedupe is a `UNIQUE`/`PK` row, not a cache (ADR-011): a retried `POST` collides on `idempotency_keys(scope,key)` and replays the stored response; a webhook redelivered three times collides on `PK(provider, event_id)` and is a no-op; a re-scanned deposit collides on `UNIQUE(chain, tx_hash, instruction_index)`. Reties are safe by construction, so workers can be at-least-once and still converge.

**What breaks first at 10× traffic — honestly.** Not the ledger math; the **write concurrency on hot accounts**. Two real ceilings, in order: (1) **row-lock contention on a single hot account** — because we deliberately serialize payouts per `(account, asset, bucket)`, a client hammering one sub-account funnels through one lock; throughput there is bounded by transaction latency, and this is *intrinsic* to the correctness choice, not a bug. Mitigation: shard a hot account's headroom into N sub-buckets that sum to the account balance and hash payouts across them (contention drops N×, recon still sums them), and keep transactions short (no HTTP inside them, already a rule). (2) **The single Postgres writer + connection pool** — the modular monolith (ADR-001) has one primary; at 10× the pool saturates before CPU does. Mitigations, cheapest first: **PgBouncer** in transaction-pooling mode so many app workers multiplex a small server-side pool; **read replicas** for the read-heavy, non-authoritative traffic (recon anti-joins §9, the Ops dashboard, `getPayout` reconciliation) so they never compete with the write path; **backpressure on the outbox queue** (bounded claim batches + `next_retry_at` backoff) so a provider slowdown can't stampede the dispatcher into exhausting connections. Only past both of those does the single-writer itself become the wall, at which point the honest move is **partitioning/sharding by client** — the modules already keep clean interfaces (ADR-001) so a client-sharded deployment is an extraction, not a rewrite. I'm not claiming horizontal write scaling I haven't built; I'm claiming I know the exact order the seams give way and that none of them compromise correctness — they degrade latency/throughput, never the invariants.

**Consequences.** Per-account serialization is a deliberate throughput cost bought in exchange for a no-negative invariant that is a database theorem (ADR-004). The scaling path is all configuration and topology (PgBouncer, replicas, sharding) rather than a redesign, because state lives in one place and every dedupe is a constraint. What I give up is single-account write parallelism — correct, and cheap to defend, at this volume.

## ADR-021 · Security boundary: authenticated outbound path, verified inbound webhooks, validated everything (2026-07-16)

**Context.** The system moves money, so its trust boundary is the whole game: who may *instruct* a payout, and which *inbound* callbacks may move a transfer's state. Two directions, two different mechanisms — conflating them is how forged callbacks or unauthenticated payouts slip in. This entry is deliberately concrete about what makes each check *fail closed*.

**Decision — outbound (someone tells us to move money).** The payout / transfer-creation endpoints require a **bearer API key** (`Authorization: Bearer …`), validated against a secret held in the environment (`API_KEY`), compared in **constant time** (`crypto.timingSafeEqual`, never `===`, which leaks length/prefix via timing). No key or wrong key → `401`, before any domain logic runs. Authorization is scoped to the outbound/instruction surface; read-only Ops views and the inbound webhook receivers use their own boundaries (the receiver's boundary is the HMAC below, not the bearer key). This is intentionally the minimum defensible perimeter for the challenge and matches ADR-017's "no real auth/multi-tenancy" scope cut — a single client secret, not OAuth/JWT/RBAC, which are named as the production upgrade, not built.

**Decision — secrets.** Every secret (`API_KEY`, `WEBHOOK_SECRET`, DB URL, RPC/provider credentials) is read from the environment, **never committed**. The repo ships `.env.example` with keys and dummy values only; a real `.env` is gitignored. The provider registry (§7.1) holds credentials by reference to env, so rotating a secret is an env change, not a code change.

**Decision — input validation.** Every endpoint parses its body/params/headers through a **zod** schema at the edge before the request reaches the domain core; a parse failure is a `422` with the offending path, and nothing downstream ever sees an unvalidated shape. This composes with the money rules — amounts arrive as strings and are validated as such (ADR-002), so `zod` also enforces the no-float-on-the-wire boundary — and with idempotency: the `request_hash` stored per `Idempotency-Key` (ADR-011) is computed over the *validated* body, so "same key, different body → 422" is well-defined.

**Decision — inbound webhooks (a provider tells us money moved).** Webhooks are hostile input (§8) and are verified before they are trusted or persisted-as-valid. Verification is **HMAC-SHA256 over the exact raw request body** keyed by `WEBHOOK_SECRET`, plus a **timestamp header** checked against a tolerance window. A webhook is **rejected** (`401`, no state change) if *any* of the following hold, and this is exactly the set of failure conditions:
- the recomputed HMAC digest does not equal the signature header under a **constant-time** compare — this is what a *tampered body* trips, because changing a single byte of the payload changes the digest (I sign the raw bytes, not the parsed JSON, so re-serialization can't mask a tamper or accidentally "fix" the signature);
- the `timestamp` header is **missing, unparseable, or outside the tolerance window** (e.g. ±5 min) — this is the **anti-replay** gate: a captured-and-resent webhook eventually falls outside the window and is refused even though its signature is still cryptographically valid;
- (defense in depth against fast replays inside the window) the `(provider, event_id)` key already exists — `PK` insert-first (ADR-011 / §6 R7) makes a duplicate a no-op rather than a re-processing.

Only a webhook that passes signature **and** freshness is persisted with `signature_ok = true` and handed to the async, monotonic state machine (§5, §8) — and even then it can only move a transfer *forward*, so a stale-but-valid event for a superseded state is recorded and ignored, never a regression.

**Consequences.** The trust boundary is two clearly separated mechanisms — a bearer secret guarding who may *spend*, an HMAC+timestamp guarding what we *believe* — each failing closed with a specific, testable rejection. Nothing secret lives in the repo; nothing unvalidated reaches the domain core. What I deliberately don't build (per ADR-017): multi-tenant auth, key rotation infrastructure, mTLS to providers, rate limiting — all named as production hardening, none load-bearing for the challenge's correctness story.

## ADR-022 · Chain access, confirmed in code: polling watcher, detect at `confirmed`, credit at `finalized`, `chain_events` doubles as the recon statement (2026-07-17)

**Context.** Day 4 makes the inbound crypto leg real: a watcher must observe SPL deposits on Solana devnet and drive them through the §5 inbound machine. ADR-014 chose polling on paper; this entry records what the build actually did and what changed.
**Options.** (a) WebSocket subscriptions (`accountSubscribe`/`logsSubscribe`) — real-time, but lossy across reconnects, and devnet drops connections routinely; (b) a third-party webhook indexer (Helius-style) — an external dependency and another trust boundary for a 5-day build; (c) polling `getSignaturesForAddress` on the deposit ATA with an overlap re-scan.
**Decision.** (c), with one simplification over ADR-014: **no persisted cursor**. Each tick re-scans a fixed window of recent signatures; `UNIQUE(chain, signature)` on `chain_events` makes overlap re-scanning a keyed no-op, so cursor management buys nothing at demo volume. Two phases per tick, mapping §5 onto Solana's commitment levels: **DETECT** at `confirmed` books the deposit as pending (seen, not spendable); **CREDIT** fires only at `finalized` — or slot-depth ≥ `CONFIRMATIONS` as the env-tunable demo knob (ADR-009) — and posts the conversion of ADR-025, which is ADR-007's "credit at chain confirmation" made concrete. The `detected → credited` transition is a guarded `UPDATE … WHERE status = 'detected'` (rowcount 0 ⇒ another worker won). The watcher and the `/webhooks/chain` route derive the **same** transfer idempotency key (`${chain}:${signature}`), so the two ingestion paths dedupe *against each other*. `chain_events` is deliberately dual-purpose: the watcher's persistent dedupe **and** the "chain statement" recon anti-joins against (§9) — one table is both memory and evidence. Failure posture: devnet RPCs rate-limit and flake, so a failed tick backs off exponentially (capped at 5 min), snaps back on the first success, and **never takes the process down**; the poll timer is unref'd so it also never keeps a dying process alive.
**Consequences.** Seconds of detection latency (bounded by `WATCHER_POLL_MS`), zero lost events: anything a tick misses, a later tick re-scans, and recon catches whatever falls through both. We give up real-time push and accept a fixed re-scan window — if a deposit ever landed outside it (not plausible at demo volume), the recon anti-join is the designed backstop, not a hidden hole.

## ADR-023 · A self-issued test-USDC mint on devnet; the canonical-mint swap is one env var (2026-07-17)

**Context.** The E2E leg needs USDC arriving on Solana devnet. Circle's devnet USDC exists, but its faucet requires a browser and a captcha — which kills unattended, reproducible setup (and CI).
**Options.** (a) Use Circle's devnet USDC and accept a manual faucet step; (b) issue our own 6-decimal SPL mint and fund it programmatically; (c) simulate the chain entirely.
**Decision.** (b). `scripts/devnet-setup.ts` provisions everything over RPC alone: keypairs, SOL airdrop (with backoff; the printed web-faucet fallback covers the rate-limited case), a 6dp SPL mint with the payer as mint authority, ATAs, and seed funds. The transactions, confirmations and finality are **real** — what the challenge is actually testing (watcher, commitment levels, idempotent ingestion, ledger booking) runs against genuine chain semantics. Watching Circle's mint instead is `SOLANA_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` — zero code changes. This is the vendor abstraction of DESIGN §7.1 applied to the chain: the watcher only ever knows "the configured mint", exactly as routing only knows provider names. To be honest about what it is *not*: a self-issued test token is not the canonical asset, and nothing about Circle's issuance (freeze authority, upgrade behavior) is exercised.
**Consequences.** Fully unattended, re-runnable setup (state cached in `.devnet/`, re-verified on-chain so devnet resets self-heal); the only flaky dependency left is the SOL faucet, and its manual fallback is one printed URL. We give up "it was literally USDC" — a fair trade for a challenge scored on ledger correctness, and reversible by config.

## ADR-024 · Polygon USDT payout: a simulated adapter behind the same `PayoutProvider` port (2026-07-17)

**Context.** The Northwind route's second leg sends 600 USDT on Polygon. Amoy has no canonical Tether (ADR-016), and the challenge's chain realism is already spent where deposits live — the inbound Solana leg (ADR-022/023). Building a second real chain integration would buy risk, not signal.
**Options.** (a) Deploy an own ERC-20 on Amoy plus a real signer/broadcaster; (b) simulate the send behind the same port the fiat providers implement.
**Decision.** (b). `polygon-usdt` implements the identical 4-method `PayoutProvider` port as AcmePay and LegacyBank and reproduces the externally observable contract of a chain payout: a `0x` transaction hash on initiation, `pending → confirming → finalized` driven by a delay standing in for block confirmations, and statement rows for recon. The simulation is declared in the adapter header — never passed off as real. What production changes, precisely: this one file holds a real signer (viem wallet client), persists the **signed** transaction before broadcast (ADR-012 — intent survives a crash; recovery queries by hash before re-signing), and reports `settled` only past the N-block threshold (ADR-009). Nothing upstream moves: routing, settlement, recon and the ledger never knew the difference — which is the entire argument for the port.
**Consequences.** The correctness budget stays on scored surface. We give up a second live-testnet proof; in exchange the crypto-payout path is deterministic in tests and demos (forceable outcomes, no faucet dependencies), and the "swap in the real signer" diff is confined and nameable.

## ADR-025 · USDC→USD conversion: par as an explicit rate through a conversion account; floor the conversion, half-even the fee (2026-07-17)

**Context.** The off-ramp posts one logical movement in two currencies (drain pending USDC, credit available USD, itemise the fee), but the double-entry trigger balances `SUM = 0` **per currency** — a cross-currency pair is structurally uncommittable on its own, which is a feature.
**Options.** (a) Relax the trigger to balance per transfer across currencies (destroys the invariant that catches rate bugs); (b) implicit conversion in application code with mirror entries; (c) one append-only transfer with two independently balanced currency legs pivoting on a conversion account.
**Decision.** (c), per ADR-003's design: the USDC leg (user pending −gross / conversion +gross) and the USD leg (conversion −grossUSD / user +net / fee +fee) each sum to zero; the conversion account's net position per currency **is** the in-flight/residue signal, observable by query. Rate is par 1:1, stored as an explicit rate (ADR-006), so the conversion is purely a decimals problem (6dp → 2dp, factor 10⁴). Two distinct rounding rules, deliberately not one: the **par conversion FLOORS** to the cent — conversion can never mint fractional cents the target currency cannot represent, and the sub-cent residue rides on the conversion account rather than hiding in a client amount (ADR-008's residue rule); the **fee division rounds HALF-EVEN** (ADR-008) — a fee is a division whose dust must not bias systematically in the house's favour, which raw truncation would. A deposit that floors to zero cents is refused loudly rather than booked as a zero-amount leg; zero-amount fee/net postings are omitted, not posted.
**Consequences.** All arithmetic lives in one pure, unit-tested module (`quoteUsdcToUsd`), none in SQL. FX honesty is one rate away from par with no structural change. We accept that the conversion account holds positions in two currencies by design — recon treats it as external-truth-reconciled, not guard-tracked.

## ADR-026 · The watcher→routing bridge: post-commit, a new transaction, at-least-once absorbed by R4 (2026-07-17)

**Context.** Two modules built in parallel arrived with an honest contract incoherence: the watcher fires its confirmation hook **after** the credit transaction commits (a routing failure must never roll back a durable credit), while the routing engine's `onOfframpConfirmed` reserves funds **inside a caller-provided transaction**. Someone has to own the seam.
**Options.** (a) Reserve in the same transaction as the credit — atomic, but couples the client's money to routing health: a routing bug would abort chain credits, holding a durable fact hostage to a downstream consumer; (b) a persisted trigger row written in the credit transaction and drained by a dispatcher (the ADR-012 outbox pattern applied to route triggers); (c) a post-commit bridge that opens a **new** transaction for the reservation.
**Decision.** (c) for this build, with (b) named as the production close. The bridge in `server.ts` runs the hook after the credit commits, wraps the reservation in its own `withTx` (all-or-nothing, the same path `POST /routing/trigger` uses), and dispatches providers only **after** that second commit — never provider I/O inside a DB transaction (ADR-012's boundary rule, kept). Delivery discipline: the hook itself is fired at most once per confirmation in-process, but the design is safe under **at-least-once** — any redelivery, from any path, collides with `UNIQUE(route_id, trigger_transfer_id)` (guardrail R4, ADR-013) and becomes a keyed read.
**The trade-off, named.** There is a crash window between the credit commit and the reservation commit. If the process dies inside it, the credit is durable, the route never fired, and the watcher will *not* re-fire on restart (the `chain_events` row is already `credited` — the guarded transition that makes crediting idempotent is the same thing that makes the hook at-most-once). Recovery today is the lever that already exists: `POST /routing/trigger` with the off-ramp transfer id replays the trigger, idempotent by R4 — an ops action, not a code change. Detection today is honest but partial: the dashboard shows a confirmed off-ramp with no execution, and recon flags any *reserved/initiated* leg past SLA — but a "confirmed off-ramp with **no** execution at all" anti-join is not yet one of recon's queries. That query (one more `LEFT JOIN … WHERE e.id IS NULL` in `recon.ts`) plus the outbox-style trigger row are the two named production hardenings that close the window entirely.
**Consequences.** A durable credit is never hostage to routing, redelivery is free, and the remaining window is small, recoverable with an existing idempotent lever, and documented rather than discovered. What we give up: automatic self-healing of that window in this build — chosen consciously over coupling the credit to its consumer.

## Brief errata noticed (recorded, not blocking)

- Glossary defines "**dReorg** (reorganization)" — the term of art is simply **reorg** / chain reorganization; treated as a typo (possibly a planted one) and not propagated into these documents.
- Day 1 brief says open questions "won't be answered now (*see Day 2*)" while the overview says days 1–2 get **no feedback** on purpose. Read as: Day 2 brings more *briefing*, not answers; defaults here stand until contradicted.

---

## Open questions (carried forward, answered by default until a brief says otherwise)

- Does the Day 2+ brief introduce percentage-based route actions or route chaining? (Default: fixed amounts, single-level.)
- Are sub-client-to-sub-client `internal` transfers in scope? (Modeled by the ledger for free; no API endpoint until asked.)
- Fee schedule per sub-client or per client? (Default: per client, inherited.)
- What does the Day 5 "live change" target? (Prepared: third fiat provider as adapter+config; confirmation-threshold change; new fee component.)
