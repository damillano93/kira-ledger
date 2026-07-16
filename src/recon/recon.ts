import type { Pool, PoolClient } from 'pg';
import { emitLedgerEvent, type EventLogger } from '../observability/events.js';

// Reconciliation as a query (DESIGN.md §9). Because the ledger is append-only
// and every external movement is keyed — chain_events by (chain, signature),
// provider_statements by (provider, external_ref) — end-of-day recon is not a
// process, it's anti-joins over facts:
//
//   Mismatch type 1 — SETTLED-WITH-NO-ENTRY: a statement row (chain or
//   provider) with no corresponding ledger transfer. The world moved money we
//   never recorded (missed deposit, lost webhook, the C3 crash window's far
//   side).
//
//   Mismatch type 2 — ENTRY-NEVER-CONFIRMED: a ledger intent (pending
//   transfer / reserved-or-initiated route leg) older than the rail's SLA with
//   no matching external fact. We believe money is in flight; the world never
//   confirmed it. This is a TRUE anti-join, not just an age heuristic: a
//   late-arriving statement row CLEARS the transfer instead of flagging it.
//
//   Riding along — BALANCE DRIFT: spend_guards is a reservation counter, not a
//   stored balance (ADR-004/ADR-020); it must be rebuildable from entries at
//   any time. For user/fee accounts every posting carries a bucket delta equal
//   to -entry.amount (liability normal side), so the invariant is
//   headroom + pending == -SUM(entries). Any drift is our bug, never the
//   world's.
//
// Recon REPORTS, it never edits. There is no UPDATE or INSERT in this module:
// the correction for any finding is a future compensating transfer posted
// through the suspense account by ops — new append-only entries, never a
// mutation (DESIGN §9).

/** Either a pg Pool or a checked-out client — recon only ever SELECTs. */
export type Queryable = Pool | PoolClient;

export interface ReconOptions {
  /**
   * SLA threshold for "entry never confirmed": only ledger intents older than
   * this are flagged (younger ones are presumed still in flight). 60 minutes
   * is generous for every rail in play (Solana finality is seconds, the mock
   * providers settle in ms); a real deployment would set this per rail.
   */
  maxAgeMinutes?: number;
  /** When provided, one structured recon.* event is emitted per finding. */
  logger?: EventLogger;
}

const DEFAULT_MAX_AGE_MINUTES = 60;

export type ReconMismatchType = 'settled_no_entry' | 'entry_never_confirmed' | 'balance_drift';

export interface ReconMismatch {
  type: ReconMismatchType;
  /** Which system holds the unmatched fact: `chain:<chain>`, `provider:<name>`, `ledger:transfer`, `ledger:route_leg`, `ledger:spend_guard`. */
  side: string;
  /** The identifying reference: tx signature, provider external_ref, transfer id, leg id, account id. */
  ref: string;
  /** Integer minor units as a string (for balance_drift: the drift itself). Null when unknowable. */
  amountMinor: string | null;
  currency: string | null;
  /** Age of the unmatched fact/intent in whole minutes. Null for point-in-time checks (drift). */
  ageMinutes: number | null;
  /** Human-readable one-liner for the ops runbook. */
  detail: string;
}

export interface ReconReport {
  runAt: string;
  /** true iff mismatches is empty. */
  ok: boolean;
  maxAgeMinutes: number;
  /** How much ground the run covered — so an empty report is distinguishable from an empty database. */
  checked: {
    chainStatements: number;
    providerStatements: number;
    pendingTransfers: number;
    openLegs: number;
    guardedAccounts: number;
  };
  mismatches: ReconMismatch[];
}

// ---------------------------------------------------------------------------
// Row shapes (pg returns BIGINT as string; ages are cast to int in SQL).
// ---------------------------------------------------------------------------

interface OrphanChainEventRow {
  chain: string;
  signature: string;
  amount_minor: string;
  currency: string;
  age_minutes: number;
}

interface OrphanStatementRow {
  provider: string;
  external_ref: string;
  amount_minor: string;
  currency: string;
  age_minutes: number;
  has_leg: boolean;
}

interface StuckTransferRow {
  id: string;
  idempotency_key: string;
  kind: string;
  status: string;
  age_minutes: number;
  amount_minor: string | null;
  currency: string | null;
}

interface StuckLegRow {
  id: string;
  transfer_id: string | null;
  provider: string;
  external_ref: string | null;
  status: string;
  amount_minor: string;
  currency: string;
  age_minutes: number;
}

interface DriftRow {
  account_id: string;
  currency: string;
  guard_minor: string;
  entries_minor: string;
  drift_minor: string;
}

interface CheckedRow {
  chain_statements: number;
  provider_statements: number;
  pending_transfers: number;
  open_legs: number;
  guarded_accounts: number;
}

// ---------------------------------------------------------------------------
// The job. Read-only by construction: five SELECTs, a report, and events.
// ---------------------------------------------------------------------------

export async function runRecon(db: Queryable, opts: ReconOptions = {}): Promise<ReconReport> {
  const maxAgeMinutes = opts.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES;
  const logger = opts.logger;
  const mismatches: ReconMismatch[] = [];

  // -- Mismatch type 1a: chain statement rows with no ledger transfer --------
  // The watcher/webhook books every deposit with idempotency_key
  // `${chain}:${signature}` (src/chain/watcher.ts, src/routes/webhooks.ts), so
  // the anti-join is a pure key comparison.
  const orphanChain = await db.query<OrphanChainEventRow>(
    `SELECT ce.chain, ce.signature, ce.amount_minor::text AS amount_minor, ce.currency,
            FLOOR(EXTRACT(EPOCH FROM (now() - ce.seen_at)) / 60)::int AS age_minutes
       FROM chain_events ce
       LEFT JOIN transfers t ON t.idempotency_key = ce.chain || ':' || ce.signature
      WHERE t.id IS NULL
      ORDER BY ce.seen_at`,
  );
  for (const row of orphanChain.rows) {
    mismatches.push({
      type: 'settled_no_entry',
      side: `chain:${row.chain}`,
      ref: row.signature,
      amountMinor: row.amount_minor,
      currency: row.currency,
      ageMinutes: row.age_minutes,
      detail: `on-chain deposit ${row.chain}:${row.signature} has no ledger transfer`,
    });
    if (logger) {
      emitLedgerEvent(logger, {
        type: 'recon.mismatch.settled_no_entry',
        source: `chain:${row.chain}`,
        externalId: row.signature,
        amountMinor: row.amount_minor,
        currency: row.currency,
      });
    }
  }

  // -- Mismatch type 1b: provider statement rows with no ledger entry --------
  // A statement matches the ledger through the leg that carries the provider
  // reference: (provider, external_ref) -> route_legs -> transfers. Missing
  // either hop means the provider settled money the ledger never booked.
  const orphanStatements = await db.query<OrphanStatementRow>(
    `SELECT ps.provider, ps.external_ref, ps.amount_minor::text AS amount_minor, ps.currency,
            FLOOR(EXTRACT(EPOCH FROM (now() - ps.settled_at)) / 60)::int AS age_minutes,
            (rl.id IS NOT NULL) AS has_leg
       FROM provider_statements ps
       LEFT JOIN route_legs rl
              ON (rl.provider, rl.external_ref) = (ps.provider, ps.external_ref)
       LEFT JOIN transfers t ON t.id = rl.transfer_id
      WHERE t.id IS NULL
      ORDER BY ps.settled_at`,
  );
  for (const row of orphanStatements.rows) {
    mismatches.push({
      type: 'settled_no_entry',
      side: `provider:${row.provider}`,
      ref: row.external_ref,
      amountMinor: row.amount_minor,
      currency: row.currency,
      ageMinutes: row.age_minutes,
      detail: row.has_leg
        ? `provider statement ${row.provider}:${row.external_ref} matches a leg with no ledger transfer`
        : `provider statement ${row.provider}:${row.external_ref} matches no route leg`,
    });
    if (logger) {
      emitLedgerEvent(logger, {
        type: 'recon.mismatch.settled_no_entry',
        source: `provider:${row.provider}`,
        externalId: row.external_ref,
        amountMinor: row.amount_minor,
        currency: row.currency,
      });
    }
  }

  // -- Mismatch type 2a: pending transfers past SLA with no external fact ----
  // Anti-join in the OTHER direction: a chain event that reached 'credited'
  // clears its transfer (a still-'detected' event is evidence the tx exists,
  // not that it finalized — past SLA that is exactly a stuck confirmation).
  // Transfers owned by a route leg are excluded here: the leg check below
  // owns them (it knows the provider reference to anti-join on).
  const stuckTransfers = await db.query<StuckTransferRow>(
    `SELECT t.id, t.idempotency_key, t.kind, t.status,
            FLOOR(EXTRACT(EPOCH FROM (now() - t.created_at)) / 60)::int AS age_minutes,
            e.amount::text AS amount_minor, e.currency
       FROM transfers t
       LEFT JOIN LATERAL (
              SELECT amount, currency FROM entries
               WHERE transfer_id = t.id AND amount > 0
               ORDER BY id LIMIT 1
            ) e ON true
      WHERE t.status = 'pending'
        AND t.created_at < now() - make_interval(mins => $1)
        AND NOT EXISTS (
              SELECT 1 FROM chain_events ce
               WHERE ce.chain || ':' || ce.signature = t.idempotency_key
                 AND ce.status = 'credited')
        AND NOT EXISTS (SELECT 1 FROM route_legs rl WHERE rl.transfer_id = t.id)
      ORDER BY t.created_at`,
    [maxAgeMinutes],
  );
  for (const row of stuckTransfers.rows) {
    mismatches.push({
      type: 'entry_never_confirmed',
      side: 'ledger:transfer',
      ref: row.id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      ageMinutes: row.age_minutes,
      detail: `${row.kind} transfer ${row.idempotency_key} pending for ${row.age_minutes}m with no external confirmation`,
    });
    if (logger) {
      emitLedgerEvent(logger, {
        type: 'recon.mismatch.entry_never_confirmed',
        transferId: row.id,
        status: row.status,
        ageSeconds: row.age_minutes * 60,
        rail: row.kind,
        ...(row.amount_minor !== null ? { amountMinor: row.amount_minor } : {}),
        ...(row.currency !== null ? { currency: row.currency } : {}),
      });
    }
  }

  // -- Mismatch type 2b: open route legs past SLA with no provider statement -
  // reserved/initiated are the non-terminal leg states (settled|failed are
  // terminal, monotonic). A late statement row clears the leg — late
  // confirmation, not a mismatch (DESIGN §9).
  const stuckLegs = await db.query<StuckLegRow>(
    `SELECT rl.id, rl.transfer_id, rl.provider, rl.external_ref, rl.status,
            rl.amount_minor::text AS amount_minor, rl.currency,
            FLOOR(EXTRACT(EPOCH FROM (now() - rl.created_at)) / 60)::int AS age_minutes
       FROM route_legs rl
      WHERE rl.status IN ('reserved', 'initiated')
        AND rl.created_at < now() - make_interval(mins => $1)
        AND NOT EXISTS (
              SELECT 1 FROM provider_statements ps
               WHERE (ps.provider, ps.external_ref) = (rl.provider, rl.external_ref))
      ORDER BY rl.created_at`,
    [maxAgeMinutes],
  );
  for (const row of stuckLegs.rows) {
    mismatches.push({
      type: 'entry_never_confirmed',
      side: 'ledger:route_leg',
      ref: row.id,
      amountMinor: row.amount_minor,
      currency: row.currency,
      ageMinutes: row.age_minutes,
      detail: `route leg ${row.id} (${row.provider}, ref ${row.external_ref ?? 'none'}) ${row.status} for ${row.age_minutes}m with no provider statement`,
    });
    if (logger) {
      emitLedgerEvent(logger, {
        type: 'recon.mismatch.entry_never_confirmed',
        transferId: row.transfer_id ?? row.id,
        status: row.status,
        ageSeconds: row.age_minutes * 60,
        rail: row.provider,
        amountMinor: row.amount_minor,
        currency: row.currency,
      });
    }
  }

  // -- Balance drift: the guard must be rebuildable from the ledger ----------
  // Scoped to user/fee accounts: only their postings carry materialised bucket
  // deltas (external/asset mirrors and conversion accounts are reconciled
  // against external truth instead — the anti-joins above).
  const drift = await db.query<DriftRow>(
    `SELECT a.id AS account_id, a.currency,
            (sg.headroom_minor + sg.pending_minor)::text AS guard_minor,
            (-COALESCE(SUM(e.amount), 0))::bigint::text AS entries_minor,
            (sg.headroom_minor + sg.pending_minor + COALESCE(SUM(e.amount), 0))::bigint::text AS drift_minor
       FROM spend_guards sg
       JOIN accounts a ON a.id = sg.account_id
       LEFT JOIN entries e ON e.account_id = sg.account_id
      WHERE a.kind IN ('user', 'fee')
      GROUP BY a.id, a.currency, sg.headroom_minor, sg.pending_minor
     HAVING sg.headroom_minor + sg.pending_minor <> -COALESCE(SUM(e.amount), 0)
      ORDER BY a.id`,
  );
  for (const row of drift.rows) {
    mismatches.push({
      type: 'balance_drift',
      side: 'ledger:spend_guard',
      ref: row.account_id,
      amountMinor: row.drift_minor,
      currency: row.currency,
      ageMinutes: null,
      detail: `spend_guard says ${row.guard_minor} but entries rebuild to ${row.entries_minor} (drift ${row.drift_minor})`,
    });
    if (logger) {
      emitLedgerEvent(logger, {
        type: 'recon.balance_drift',
        accountId: row.account_id,
        guardMinor: row.guard_minor,
        entriesMinor: row.entries_minor,
        driftMinor: row.drift_minor,
        currency: row.currency,
      });
    }
  }

  // -- Coverage counters ------------------------------------------------------
  const checked = await db.query<CheckedRow>(
    `SELECT (SELECT COUNT(*) FROM chain_events)::int                                   AS chain_statements,
            (SELECT COUNT(*) FROM provider_statements)::int                            AS provider_statements,
            (SELECT COUNT(*) FROM transfers WHERE status = 'pending')::int             AS pending_transfers,
            (SELECT COUNT(*) FROM route_legs
              WHERE status IN ('reserved', 'initiated'))::int                          AS open_legs,
            (SELECT COUNT(*) FROM spend_guards sg
               JOIN accounts a ON a.id = sg.account_id
              WHERE a.kind IN ('user', 'fee'))::int                                    AS guarded_accounts`,
  );
  const counts = checked.rows[0];

  return {
    runAt: new Date().toISOString(),
    ok: mismatches.length === 0,
    maxAgeMinutes,
    checked: {
      chainStatements: counts?.chain_statements ?? 0,
      providerStatements: counts?.provider_statements ?? 0,
      pendingTransfers: counts?.pending_transfers ?? 0,
      openLegs: counts?.open_legs ?? 0,
      guardedAccounts: counts?.guarded_accounts ?? 0,
    },
    mismatches,
  };
}
