import { pool, type PoolClient } from '../db.js';
import {
  createBalancedTransfer,
  createPayout,
  InsufficientFundsError,
  type Posting,
} from '../domain/ledger.js';
import { emitLedgerEvent, type EventLogger } from '../observability/events.js';
import { defaultRegistry, type ProviderRegistry } from '../vendors/registry.js';

// The routing engine — the orchestration half of the Northwind flow.
//
// Semantics are ADR-013, implemented literally:
//   * a route fires ONCE per triggering deposit — UNIQUE(route_id,
//     trigger_transfer_id) makes the second firing a keyed no-op (R4);
//   * it evaluates against net available post-fees (the off-ramp already
//     itemised fees before crediting available — the guard row IS the net);
//   * funds for ALL actions are reserved in one DB transaction in declared
//     `seq` order — all-or-nothing, no partial fills;
//   * if the total does not fit, the execution parks in `insufficient_funds`,
//     a VISIBLE and RETRYABLE state (savepoint keeps the row, rolls back the
//     partial reservations);
//   * once reserved, each leg lives its own lifecycle (reserved -> initiated
//     -> settled | failed) driven by settlement events.
//
// Boundary rule (DESIGN §7): reservation is pure SQL inside the caller's
// transaction; provider calls happen ONLY in dispatchExecution, after commit —
// never HTTP (or any provider I/O) inside a DB transaction.

export type ExecutionStatus =
  | 'reserving'
  | 'reserved'
  | 'insufficient_funds'
  | 'completed'
  | 'failed';

export type LegStatus = 'reserved' | 'initiated' | 'settled' | 'failed';

export interface TriggeredExecution {
  routeId: string;
  executionId: string;
  status: 'reserved' | 'insufficient_funds' | 'already_fired';
}

// Deterministic outbound idempotency key. Doubles as the provider
// clientReference, so a re-dispatch after a crash is deduped provider-side.
export function legIdempotencyKey(executionId: string, seq: number): string {
  return `route:${executionId}:leg:${seq}`;
}

export class RouteTriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteTriggerError';
  }
}

// -- row shapes (snake_case, straight from pg; BIGINT arrives as string) ------

interface RouteActionRow {
  seq: number;
  provider: string;
  amount_minor: string;
  currency: string;
  source_amount_minor: string;
  source_currency: string;
  destination_account_id: string;
  source_conversion_account_id: string | null;
  destination_conversion_account_id: string | null;
}

export interface RouteLegRow {
  id: string;
  execution_id: string;
  seq: number;
  provider: string;
  status: LegStatus;
  idempotency_key: string;
  external_ref: string | null;
  transfer_id: string | null;
  user_account_id: string;
  destination_account_id: string;
  amount_minor: string;
  currency: string;
  source_amount_minor: string;
  source_currency: string;
  source_conversion_account_id: string | null;
  destination_conversion_account_id: string | null;
  failure_reason: string | null;
}

// -- posting construction ------------------------------------------------------

export interface LegSpec {
  userAccountId: string;
  destinationAccountId: string;
  amountMinor: bigint; // what the counterparty receives (destination currency)
  currency: string;
  sourceAmountMinor: bigint; // what the user is debited (source currency)
  sourceCurrency: string;
  sourceConversionAccountId: string | null;
  destinationConversionAccountId: string | null;
}

function isCrossCurrency(spec: LegSpec): boolean {
  return spec.currency !== spec.sourceCurrency;
}

// Balanced postings for one leg. `direction` 1n reserves, -1n reverses (a
// failed leg is compensated by NEW entries, never edited — append-only).
//
// Same-currency (e.g. the ACH USD leg): a plain two-posting payout.
// Cross-currency (e.g. USD books -> USDT send): two single-currency legs each
// summing to zero, joined through the conversion account pair at the explicit
// rate carried by the route action (DESIGN §4.1/§4.4 T5 pattern, at par —
// same shape the off-ramp uses on the inbound side).
export function buildLegPostings(spec: LegSpec, direction: 1n | -1n): Posting[] {
  if (!isCrossCurrency(spec)) {
    return [
      {
        accountId: spec.userAccountId,
        amount: spec.sourceAmountMinor * direction,
        currency: spec.sourceCurrency,
        balance: { bucket: 'available', delta: -spec.sourceAmountMinor * direction },
      },
      {
        accountId: spec.destinationAccountId,
        amount: -spec.amountMinor * direction,
        currency: spec.currency,
      },
    ];
  }

  if (!spec.sourceConversionAccountId || !spec.destinationConversionAccountId) {
    throw new Error('cross-currency leg requires a conversion account pair');
  }

  return [
    // Source-currency leg (sums to zero in, e.g., USD):
    {
      accountId: spec.userAccountId,
      amount: spec.sourceAmountMinor * direction,
      currency: spec.sourceCurrency,
      balance: { bucket: 'available', delta: -spec.sourceAmountMinor * direction },
    },
    {
      accountId: spec.sourceConversionAccountId,
      amount: -spec.sourceAmountMinor * direction,
      currency: spec.sourceCurrency,
    },
    // Destination-currency leg (sums to zero in, e.g., USDT):
    {
      accountId: spec.destinationConversionAccountId,
      amount: spec.amountMinor * direction,
      currency: spec.currency,
    },
    {
      accountId: spec.destinationAccountId,
      amount: -spec.amountMinor * direction,
      currency: spec.currency,
    },
  ];
}

export function legSpecFromRow(
  row: Pick<
    RouteLegRow,
    | 'user_account_id'
    | 'destination_account_id'
    | 'amount_minor'
    | 'currency'
    | 'source_amount_minor'
    | 'source_currency'
    | 'source_conversion_account_id'
    | 'destination_conversion_account_id'
  >,
): LegSpec {
  return {
    userAccountId: row.user_account_id,
    destinationAccountId: row.destination_account_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    sourceAmountMinor: BigInt(row.source_amount_minor),
    sourceCurrency: row.source_currency,
    sourceConversionAccountId: row.source_conversion_account_id,
    destinationConversionAccountId: row.destination_conversion_account_id,
  };
}

// -- trigger -------------------------------------------------------------------

// Entry point the chain watcher calls (in the SAME transaction that confirmed
// the off-ramp) — and that POST /routing/trigger exposes for manual/demo use.
// Evaluates every active route watching `userAccountId` and fires each at most
// once for this trigger transfer. Reservation only; dispatch happens after
// commit via dispatchExecution().
export async function onOfframpConfirmed(
  client: PoolClient,
  offrampTransferId: string,
  userAccountId: string,
  events?: EventLogger,
): Promise<TriggeredExecution[]> {
  // A route fires when money becomes AVAILABLE (DESIGN §2): the trigger must
  // be a confirmed off-ramp, never a pending deposit.
  const trigger = await client.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM transfers WHERE id = $1`,
    [offrampTransferId],
  );
  const triggerRow = trigger.rows[0];
  if (!triggerRow) {
    throw new RouteTriggerError(`trigger transfer ${offrampTransferId} not found`);
  }
  if (triggerRow.kind !== 'offramp' || triggerRow.status !== 'confirmed') {
    throw new RouteTriggerError(
      `trigger transfer ${offrampTransferId} is not a confirmed off-ramp ` +
        `(kind=${triggerRow.kind}, status=${triggerRow.status})`,
    );
  }

  const routes = await client.query<{ id: string }>(
    `SELECT id FROM routes WHERE trigger_account_id = $1 AND active ORDER BY created_at`,
    [userAccountId],
  );

  const results: TriggeredExecution[] = [];
  for (const route of routes.rows) {
    results.push(await fireRoute(client, route.id, offrampTransferId, userAccountId, events));
  }
  return results;
}

async function fireRoute(
  client: PoolClient,
  routeId: string,
  triggerTransferId: string,
  userAccountId: string,
  events?: EventLogger,
): Promise<TriggeredExecution> {
  // Guardrail R4: only the winning insert reserves funds. A redelivered
  // trigger conflicts here and becomes a read.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO route_executions (route_id, trigger_transfer_id, status)
     VALUES ($1, $2, 'reserving')
     ON CONFLICT (route_id, trigger_transfer_id) DO NOTHING
     RETURNING id`,
    [routeId, triggerTransferId],
  );

  if (inserted.rows.length === 0) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM route_executions WHERE route_id = $1 AND trigger_transfer_id = $2`,
      [routeId, triggerTransferId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`route execution vanished after conflict (route ${routeId})`);
    return { routeId, executionId: row.id, status: 'already_fired' };
  }

  return reserveExecution(client, routeId, inserted.rows[0]!.id, userAccountId, triggerTransferId, events);
}

// Reserve ALL legs of an execution, in `seq` order, all-or-nothing. On
// insufficient funds the SAVEPOINT rolls back every partial reservation while
// the execution row itself survives in the visible, retryable state.
async function reserveExecution(
  client: PoolClient,
  routeId: string,
  executionId: string,
  userAccountId: string,
  triggerTransferId: string,
  events?: EventLogger,
): Promise<TriggeredExecution> {
  const actions = await client.query<RouteActionRow>(
    `SELECT seq, provider, amount_minor, currency, source_amount_minor, source_currency,
            destination_account_id, source_conversion_account_id, destination_conversion_account_id
       FROM route_actions
      WHERE route_id = $1
      ORDER BY seq`,
    [routeId],
  );

  // Total debit against the user across all legs, in source currency — the
  // amount the route.fired / insufficient_funds events report.
  const totalSourceMinor = actions.rows.reduce((sum, a) => sum + BigInt(a.source_amount_minor), 0n);
  const sourceCurrency = actions.rows[0]?.source_currency ?? 'USD';

  await client.query('SAVEPOINT route_reserve');
  try {
    for (const action of actions.rows) {
      await reserveLeg(client, executionId, userAccountId, action);
    }
    await client.query('RELEASE SAVEPOINT route_reserve');
    await client.query(
      `UPDATE route_executions SET status = 'reserved', updated_at = now() WHERE id = $1`,
      [executionId],
    );
    if (events) {
      emitLedgerEvent(events, {
        type: 'money.route.fired',
        routeId,
        triggerTransferId,
        accountId: userAccountId,
        amountMinor: totalSourceMinor,
        currency: sourceCurrency,
      });
    }
    return { routeId, executionId, status: 'reserved' };
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // No partial fills (ADR-013): roll back every reservation made so far,
      // keep the execution visible and retryable.
      await client.query('ROLLBACK TO SAVEPOINT route_reserve');
      await client.query(
        `UPDATE route_executions SET status = 'insufficient_funds', updated_at = now() WHERE id = $1`,
        [executionId],
      );
      if (events) {
        emitLedgerEvent(events, {
          type: 'money.route.insufficient_funds',
          routeId,
          triggerTransferId,
          accountId: userAccountId,
          amountMinor: totalSourceMinor,
          currency: sourceCurrency,
        });
      }
      return { routeId, executionId, status: 'insufficient_funds' };
    }
    throw err;
  }
}

async function reserveLeg(
  client: PoolClient,
  executionId: string,
  userAccountId: string,
  action: RouteActionRow,
): Promise<void> {
  const spec: LegSpec = {
    userAccountId,
    destinationAccountId: action.destination_account_id,
    amountMinor: BigInt(action.amount_minor),
    currency: action.currency,
    sourceAmountMinor: BigInt(action.source_amount_minor),
    sourceCurrency: action.source_currency,
    sourceConversionAccountId: action.source_conversion_account_id,
    destinationConversionAccountId: action.destination_conversion_account_id,
  };
  const idempotencyKey = legIdempotencyKey(executionId, action.seq);

  // Same-currency legs reuse createPayout verbatim; cross-currency legs post
  // the conversion-pair shape through createBalancedTransfer. Both paths hit
  // the same guarded spend on the user's available bucket — the no-negative
  // invariant lives in ONE place (ledger.ts / spend_guards), not here.
  const result = isCrossCurrency(spec)
    ? await createBalancedTransfer(client, {
        idempotencyKey,
        kind: 'payout',
        status: 'pending',
        postings: buildLegPostings(spec, 1n),
      })
    : await createPayout(client, {
        idempotencyKey,
        userAccountId,
        destinationAccountId: spec.destinationAccountId,
        amount: spec.amountMinor,
        currency: spec.currency,
      });

  await client.query(
    `INSERT INTO route_legs
       (execution_id, seq, provider, status, idempotency_key, transfer_id,
        user_account_id, destination_account_id,
        amount_minor, currency, source_amount_minor, source_currency,
        source_conversion_account_id, destination_conversion_account_id)
     VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (execution_id, seq) DO NOTHING`,
    [
      executionId,
      action.seq,
      action.provider,
      idempotencyKey,
      result.transfer.id,
      userAccountId,
      action.destination_account_id,
      action.amount_minor,
      action.currency,
      action.source_amount_minor,
      action.source_currency,
      action.source_conversion_account_id,
      action.destination_conversion_account_id,
    ],
  );
}

// -- retry ---------------------------------------------------------------------

// Retry a stalled execution. Guarded transition: ONLY `insufficient_funds` is
// retryable, so a concurrent/duplicate retry (rowcount 0) is a clean no-op —
// funds can never be reserved twice for the same execution.
export async function retryExecution(
  client: PoolClient,
  executionId: string,
  events?: EventLogger,
): Promise<TriggeredExecution | null> {
  const claimed = await client.query<{
    route_id: string;
    trigger_account_id: string;
    trigger_transfer_id: string;
  }>(
    `UPDATE route_executions e
        SET status = 'reserving', updated_at = now()
       FROM routes r
      WHERE e.id = $1 AND e.status = 'insufficient_funds' AND r.id = e.route_id
      RETURNING e.route_id, r.trigger_account_id, e.trigger_transfer_id`,
    [executionId],
  );
  const row = claimed.rows[0];
  if (!row) return null;
  return reserveExecution(
    client,
    row.route_id,
    executionId,
    row.trigger_account_id,
    row.trigger_transfer_id,
    events,
  );
}

// -- dispatch ------------------------------------------------------------------

export interface DispatchedLeg {
  legId: string;
  seq: number;
  provider: string;
  externalRef: string;
  status: LegStatus;
}

// Hand every reserved leg of an execution to its provider. Runs OUTSIDE any DB
// transaction (boundary rule: never provider I/O inside one). Crash-safe: if
// the process dies between the provider call and the UPDATE, a re-dispatch
// re-sends the SAME clientReference and the provider replays the original ack
// (query-before-retry semantics collapse into dedupe for these mocks).
export async function dispatchExecution(
  executionId: string,
  registry: ProviderRegistry = defaultRegistry,
  events?: EventLogger,
): Promise<DispatchedLeg[]> {
  const legs = await pool.query<RouteLegRow>(
    `SELECT * FROM route_legs WHERE execution_id = $1 AND status = 'reserved' ORDER BY seq`,
    [executionId],
  );

  const dispatched: DispatchedLeg[] = [];
  for (const leg of legs.rows) {
    const provider = registry.get(leg.provider);
    let ack;
    try {
      ack = await provider.initiatePayout({
        clientReference: leg.idempotency_key,
        amountMinor: BigInt(leg.amount_minor),
        currency: leg.currency,
        destination: leg.destination_account_id,
      });
    } catch (err) {
      // Observe-and-rethrow: the leg stays 'reserved' (retryable by a
      // re-dispatch with the same clientReference); behaviour is unchanged.
      if (events) {
        emitLedgerEvent(events, {
          type: 'provider.call.failed',
          provider: leg.provider,
          operation: 'initiatePayout',
          transferId: leg.transfer_id ?? undefined,
          willRetry: true,
          reason: (err as Error).message,
        });
      }
      throw err;
    }
    // Guarded, monotonic: only reserved -> initiated. A duplicate dispatch
    // that lost the race changes nothing.
    await pool.query(
      `UPDATE route_legs
          SET status = 'initiated', external_ref = $1, updated_at = now()
        WHERE id = $2 AND status = 'reserved'`,
      [ack.externalRef, leg.id],
    );
    if (events) {
      emitLedgerEvent(events, {
        type: 'money.payout.initiated',
        transferId: leg.transfer_id ?? leg.id,
        accountId: leg.user_account_id,
        destinationAccountId: leg.destination_account_id,
        amountMinor: leg.amount_minor,
        currency: leg.currency,
        provider: leg.provider,
      });
    }
    dispatched.push({
      legId: leg.id,
      seq: leg.seq,
      provider: leg.provider,
      externalRef: ack.externalRef,
      status: 'initiated',
    });
  }
  return dispatched;
}
