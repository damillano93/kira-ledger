# Observability

Structured logging is the mechanism; **knowing what to page on is the deliverable**. This
document is my on-call judgment for this system: which signals I watch, which ones wake a
human at 3am, which ones wait for the morning, and why. The guiding rule comes from years
of carrying a payments pager: **infrastructure alerts tell you the system is suffering;
business alerts tell you money is at risk. Only the second kind justifies waking someone
up** — and an infra symptom that matters will always surface as a business signal anyway
(a dead dispatcher *is* a stuck-pending payout; you page on the payout).

Implementation: a typed event module over pino ([`src/observability/events.ts`](src/observability/events.ts)),
with the paging policy as a reviewed, single-source-of-truth table in code
([`src/observability/alerts.ts`](src/observability/alerts.ts)). Section 3 shows how the
events are consumed here and how they'd be routed in production.

---

## 1. Infrastructure signals

These matter, but none of them pages on its own — they page through the business alert
they eventually cause. Thresholds assume the current single-node Fly deployment; the
"what degrades first" column is the 10× analysis from ADR-020 made operational.

| Signal | Watch | Suggested threshold | What degrades first, and how it shows up |
|---|---|---|---|
| **Postgres connections** | pool in-use / pool max | warn > 70%, investigate > 85% sustained 5m | Per ADR-020 this is the **first real ceiling at 10×**: the pool saturates before CPU does. Symptom chain: acquire latency → request latency → outbox dispatcher starved → `money.transfer.stuck_pending`. Fix order: PgBouncer transaction pooling, then read replicas for recon/dashboard reads. |
| **Postgres query latency** | p95 per statement family | p95 > 100ms for the hold transaction, 15m | The hold transaction holds a **row lock** (`FOR UPDATE` on `spend_guards`); every ms it takes is serialization time for that account. A hot account under slow queries is lock-queue latency, not CPU — ADR-020's ceiling #1. |
| **Outbox / queue depth** | `pending` + `in_flight` rows, and **oldest-row age** | depth: warn at 100; **age of oldest `pending` > 60s → investigate now** | Age beats depth: a deep-but-draining queue is a burst; an old head means the dispatcher is stalled or one provider is timing out. Backpressure (bounded claim batches + `next_retry_at`) means a slow provider shows here first — *by design* — instead of exhausting connections. |
| **HTTP error rate** | 5xx ratio; 401 on webhook route separately | 5xx > 1% over 5m → investigate | 4xx is mostly clients being clients. The interesting 401s are webhook rejections, which have their own business alert (§2.6) because they can mean confirmations going dark. |
| **Node event-loop lag** | lag p99 | > 200ms sustained | Single-language monolith: one blocked loop stalls API *and* worker scheduling. The killer symptom isn't slow requests — it's watcher ticks not firing, which becomes `watcher.confirmation_backlog`. |
| **CPU / RAM** | machine metrics | CPU > 80% 15m; RSS trending into OOM | Honestly last on the list. ADR-020: at 10× the pool and hot-account locks give way *before* compute. RAM matters mainly for the OOM-kill → crash-window story (which crash consistency §8 already survives, but restarts inflate confirmation latency). |
| **Absence of heartbeat** | watcher cursor age, dispatcher last-loop timestamp | cursor age > 2× poll interval | The nastiest failure mode: `/healthz` green, process alive, loop dead. You never notice by looking at errors — there are none. Detected via the absence monitors in §2. |

**The honest summary:** at this volume nothing above pages directly. Every row exists to
answer "*why*" after a business alert fires, and to catch the pool/lock ceilings while
they're still latency, not incidents.

---

## 2. Business alerts — what actually pages

Rules of the game, before the list:

- **Page (PagerDuty, any hour)** = money is at risk *and* a human decision changes the
  outcome. **Slack** = broken but bounded — retries, recon, or idempotency have it
  contained until morning. Nothing pages "for awareness."
- Every alert below keys on a typed event from `events.ts`; the machine-readable version
  of this section (level, `alert` flag, trigger, first action) is `ALERT_POLICY` in
  `alerts.ts`. Paging-worthy events carry `alert: true` in the emitted JSON, so the log
  router needs zero parsing intelligence.
- Deduplicate pages per key (account, provider, transfer). Recon re-finding the same
  break every cycle is confirmation, not a second incident.

### 2.1 Balance drift — `recon.balance_drift` · **PAGE, always, any amount**

**Signal:** recon's guard-honesty check finds `spend_guards.headroom != SUM(entries)`
for an account. **Threshold: one occurrence. One cent. 3am. No grace period.**

**Why:** the entire no-negative-balance guarantee (ADR-004/020) assumes the guard mirrors
the entries. If they disagree, either the guard over-reports (we will **authorize spends
against money that isn't there** — real overdraft, real loss) or under-reports (we freeze
a client's legitimate funds — support fire and trust damage). Both are wrong *silently*:
no request fails, no error logs, the system looks perfectly healthy while every
subsequent authorization decision is made against a lie. That is precisely the category
of failure that must never wait for business hours.

**On-call:** freeze spends on the account, rebuild the guard from `SUM(entries)` (it's a
reservation counter, rebuildable by design), *then* hunt the code path that moved one
side without the other. The ledger is append-only truth; the guard is cache. Rebuild
first, root-cause second.

### 2.2 Settled with no entry — `recon.mismatch.settled_no_entry` · **PAGE**

**Signal:** recon anti-join #1 (§9): external truth (chain scan, provider statement) has
a movement with no matching ledger transaction. **Threshold: any occurrence.**

**Why:** the world moved money and we didn't record it. If it's an unrecorded *inbound*,
a client isn't credited — they will notice before we do, which is the worst way to learn.
If it's an unrecorded *outbound*, we paid without booking it — solvency reporting is now
wrong. Either way client-visible balances are wrong **right now**, and every hour of
delay compounds downstream effects (routes not fired, statements wrong). This is also the
far side of the C3 crash window (§8) — the case our recovery sweep exists to prevent —
so an occurrence means a hole in the ingestion path worth finding immediately.

**On-call:** identify which ingestion leg failed (webhook never arrived → check
`provider.webhook.rejected` history; watcher gap → check cursor), then post the
correcting **compensating entry via suspense**. Recon reports; it never edits (§9).

### 2.3 Entry never confirmed / stuck-pending — `recon.mismatch.entry_never_confirmed`, `money.transfer.stuck_pending` · **PAGE for payouts; Slack for young deposit-side items**

**Signal:** recon anti-join #2, plus the aged-state sweep: intent recorded in the ledger
with no matching external fact past the rail's SLA. Same truth seen from the ledger side:
an **aged balance in a transit account**. **Threshold:** any *payout*-side item → page.
Deposit-side single item under 2× SLA → Slack. Anything aged > 2× SLA, or aggregate stuck
value > $10k equivalent → page regardless of side.

**Why:** a stuck payout is a client's money in limbo — held from their balance, not
arrived at destination. This is the state where the *wrong* human reaction (blind retry)
turns an incident into a **double-send**. Paging isn't just about speed; it puts a person
with the runbook in the loop before someone panics. Deposit-side items are gentler:
the money is visible on-chain, nobody can spend what isn't credited, and recon will clear
it the moment the external fact lands — a late statement row settles the transfer through
the normal event path.

**On-call:** for payouts, the C3 discipline: **`getPayout(clientReference)` against the
provider first, never a blind retry**. Provider knows it → record the ack, done. Provider
doesn't → re-send with the *same* clientReference (the provider dedupes). Check the outbox
row state: `pending` head aging = dispatcher stalled; `in_flight` aging = recovery sweep
territory.

### 2.4 Failed settlements — `money.payout.failed` · **PAGE on terminal or on rate**

**Signal & threshold:** any failure with `willRetry: false` → page. Retryable failures:
\>5% of `money.payout.initiated` over 10 minutes (min 3) → page; an isolated retryable
failure → Slack.

**Why:** a terminal failure means funds were held and will *not* arrive; the hold must be
verifiably released and possibly the client contacted — human work with a clock on it.
A failure-*rate* spike means the pipeline itself is sick (provider outage, bad deploy,
expired credentials) and the retryable failures of the next hour are tomorrow's terminal
ones. One user typo'ing an account number at 3am is Slack; the same error thirty times
is not thirty typos.

**On-call:** read `reason` before acting — provider-decline reasons batch by cause almost
every time. Verify hold release for terminal failures (should be automatic; trust but
grep). If concentrated on one provider, see 2.7.

### 2.5 Watcher confirmation backlog — `watcher.confirmation_backlog` · **PAGE when the head is old**

**Signal:** the watcher's confirmation queue exceeds its depth threshold; event carries
`backlog` and `oldestAgeSeconds`. **Threshold:** `oldestAgeSeconds > 1800` → page. Deep
but young (burst absorbing) → Slack.

**Why:** deposits already final on-chain aren't credited: customers see money leave their
wallet and not appear — the support queue fills before any error rate moves. Route
triggers (`money.route.fired`) don't fire, so downstream automated money movement silently
stops too. And because it's usually an *absence* failure (RPC provider degraded, loop
dead), no error-rate monitor will ever catch it — this alert **is** the monitor. Age over
depth, again: depth measures load, age measures harm.

**On-call:** RPC provider health first (it's the cause more often than not), then loop
liveness. Restart is safe by construction: the cursor is persisted, re-scan overlaps, and
`(chain, tx_hash, instruction_index)` idempotency absorbs every replay.

### 2.6 Webhook rejection spike — `provider.webhook.rejected` · **PAGE on bad_signature rate**

**Signal & threshold:** `reason: bad_signature` > 5/min sustained 5m → page.
`stale_timestamp` spike → Slack (clock skew, or someone probing replays).
`duplicate` → log-only: that's idempotency doing its job, alerting on it trains people to
ignore alerts.

**Why this one genuinely pages:** the two explanations are *both* urgent. Either **our
secret rotation broke** — in which case every legitimate confirmation is now being
rejected and the entire settlement feed has gone dark (about to cascade into 2.3 for
every in-flight transfer) — or **someone is forging provider callbacks**, i.e. actively
probing the boundary that moves transfer states. You need a human to determine which,
because the responses are opposite: roll back the secret vs. block the source.

**On-call:** the split takes one test webhook signed with the current secret. Verifies →
our verification is fine, treat as hostile, capture source IPs, block, notify the
provider. Fails → rotation broke; roll back, then replay: providers redeliver, and the
`(provider, event_id)` PK makes re-ingestion a no-op.

### 2.7 Provider call failures — `provider.call.failed` · **PAGE at 100% to one provider**

**Signal & threshold:** failure rate to a single provider at 100% for 5m → page.
Sporadic failures with `willRetry: true` → log-only; elevated-but-partial → Slack.

**Why:** our HTTP surface stays green — payout *acceptance* never touches the provider
(ledger-first, outbox); the failure is invisible from outside while held funds pile up
in the outbox. That's the trap: dashboards all green, money silently queuing. The outbox
absorbs it correctly (that's what it's for), but "correctly absorbed" still means client
money not moving, and the on-call should decide about failover or client comms rather
than let the queue age into a 2.3 storm.

**On-call:** provider status page, then outbox depth and backpressure (bounded claim
batches + `next_retry_at` backoff must be visibly holding — ADR-020). Escalate to the
provider with our `clientReference`s; they dedupe, so recovery after their outage is
their redelivery plus our sweep.

### 2.8 Insufficient-funds spike — `money.route.insufficient_funds` · **Slack, PAGE on anomaly**

**Signal & threshold:** each occurrence → Slack (it's a legitimate, visible, retryable
business state — ADR-013 accepts a route can stall on it). **Page** when >10× an
account's baseline in 15m, or many unrelated accounts simultaneously.

**Why the anomaly pages:** one account hammering insufficient-funds is either **fraud
probing balance limits** (card-testing's ugly cousin — someone mapping how much is in an
account by bisecting payout amounts) or a **double-reservation bug** where something
decrements the guard without a matching entry — headroom evaporates and legitimate spends
start bouncing. The second is a balance-drift precursor: this alert catches it *while
it's still failing safe* (blocking spends) instead of failing open.

**On-call:** one query splits the branches — guard headroom vs `SUM(entries)` for the
account. **Agree** → funds are genuinely short: business event, maybe fraud, hand to risk
with the request pattern. **Disagree** → our bug; you've caught 2.1 early, treat as 2.1.

### What deliberately does *not* page

Single retryable payout failure; webhook `duplicate`s; deposit-side recon items inside
2× SLA; queue *depth* without head age; latency drifting; any CPU/RAM/5xx signal on its
own. Every one is either self-healing (retries, redelivery, recon) or fails *safe*
(blocked spend, un-credited deposit). A pager that fires on self-healing conditions gets
muted within a month, and then it misses the balance drift. Protecting the pager's
signal-to-noise **is** protecting the money.

---

## 3. How it's implemented (and how it would ship)

**In this repo:** every event is one call at the money site —

```ts
emitLedgerEvent(req.log, {
  type: 'money.payout.initiated',
  transferId: transfer.id,
  accountId,
  amountMinor: amount,      // bigint OK — serialized as a string, never a float
  currency,
});
```

`emitLedgerEvent` looks up the event in `ALERT_POLICY`, emits at the policy's level
through the pino logger Fastify already ships, stamps `alert: true` on paging-worthy
events, and stringifies bigints (amounts survive JSON as strings, keeping the
no-float-on-the-wire rule end to end). Discriminated unions mean the compiler rejects an
integration site missing a required field. `test/unit/observability.test.ts` locks the
JSON shape.

**Here (Fly.io), the events are grep-able today:**

```sh
# anything that would page
fly logs | grep '"alert":true'

# a specific signal
fly logs | grep '"event":"recon.balance_drift"'

# one transfer's full money trail across deposit -> route -> payout
fly logs | grep '"transferId":"tr_01H..."'

# webhook hostility over the last window
fly logs | grep '"event":"provider.webhook.rejected"' | grep bad_signature
```

**In production** nothing about the emitters changes — that's the point of structured
events. stdout JSON → a shipper (Vector / Datadog agent / promtail) → indexed by `event`,
`provider`, `currency`, `accountId`. The §2 thresholds become monitors (Datadog log
monitors or Loki ruler rules) generated from `ALERT_POLICY`; `alert:true` events route to
PagerDuty, `channel: slack` policies to the ops channel. Counters and p95s (`latencyMs`
per provider, settle/fail ratios) derive from the same events — at this volume,
log-derived metrics beat maintaining a parallel metrics pipeline; the day cardinality
hurts, the emitters stay and a StatsD sink drops in behind the same call.

The policy table living in code, reviewed in PRs next to the paths it watches, is
deliberate: alert thresholds that live only in a dashboard drift from reality within a
quarter. This one can't — it compiles against the same union the emitters use.
