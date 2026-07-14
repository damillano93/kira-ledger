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

## Brief errata noticed (recorded, not blocking)

- Glossary defines "**dReorg** (reorganization)" — the term of art is simply **reorg** / chain reorganization; treated as a typo (possibly a planted one) and not propagated into these documents.
- Day 1 brief says open questions "won't be answered now (*see Day 2*)" while the overview says days 1–2 get **no feedback** on purpose. Read as: Day 2 brings more *briefing*, not answers; defaults here stand until contradicted.

---

## Open questions (carried forward, answered by default until a brief says otherwise)

- Does the Day 2+ brief introduce percentage-based route actions or route chaining? (Default: fixed amounts, single-level.)
- Are sub-client-to-sub-client `internal` transfers in scope? (Modeled by the ledger for free; no API endpoint until asked.)
- Fee schedule per sub-client or per client? (Default: per client, inherited.)
- What does the Day 5 "live change" target? (Prepared: third fiat provider as adapter+config; confirmation-threshold change; new fee component.)
