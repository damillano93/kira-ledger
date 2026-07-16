import { withTx, type PoolClient } from '../db.js';
import { createBalancedTransfer, setTransferStatus } from '../domain/ledger.js';
import { emitLedgerEvent, type EventLogger } from '../observability/events.js';
import type { ProviderEvent } from '../vendors/provider.js';
import { buildLegPostings, legSpecFromRow, type RouteLegRow } from './engine.js';

// Settlement: apply a canonical ProviderEvent (from a webhook, a poll, or the
// mock settle endpoint — all three converge on the same shape) to the leg it
// references. Everything here is guarded and idempotent:
//   * state moves only forward (guarded UPDATE ... WHERE status IN (...)); a
//     duplicate or out-of-order event loses the rowcount race and is a no-op;
//   * the provider_statements insert is keyed UNIQUE(provider, external_ref) —
//     redelivery cannot double-book external truth;
//   * a failed leg releases its reservation with NEW compensating entries
//     (append-only, never an edit), idempotent per `<leg key>:reversal`.

export type ApplyEventResult =
  | { applied: true; legId: string; executionId: string; legStatus: 'settled' | 'failed' }
  | { applied: false; reason: 'unknown_reference' | 'stale_or_duplicate' | 'not_terminal' };

export async function applyProviderEvent(
  providerName: string,
  event: ProviderEvent,
  events?: EventLogger,
): Promise<ApplyEventResult> {
  if (event.status !== 'settled' && event.status !== 'failed') {
    // `initiated`/`processing` don't move a leg: dispatch already recorded the
    // ack, and there is no intermediate leg state to persist. Recorded no-op.
    return { applied: false, reason: 'not_terminal' };
  }

  return withTx(async (client) => {
    // Row lock: concurrent settlement events for the same leg serialize here.
    const legRes = await client.query<RouteLegRow>(
      `SELECT * FROM route_legs
        WHERE provider = $1 AND external_ref = $2
        FOR UPDATE`,
      [providerName, event.externalRef],
    );
    const leg = legRes.rows[0];
    if (!leg) return { applied: false, reason: 'unknown_reference' };

    return event.status === 'settled'
      ? settleLeg(client, leg, events)
      : failLeg(client, leg, event.failureReason, events);
  });
}

async function settleLeg(
  client: PoolClient,
  leg: RouteLegRow,
  events?: EventLogger,
): Promise<ApplyEventResult> {
  // Monotonic transition. `reserved` is admitted alongside `initiated` for the
  // C3 crash window: the provider acked but our dispatcher died before
  // recording it — the settlement is still real.
  const moved = await client.query(
    `UPDATE route_legs SET status = 'settled', updated_at = now()
      WHERE id = $1 AND status IN ('reserved', 'initiated')`,
    [leg.id],
  );
  if (moved.rowCount === 0) return { applied: false, reason: 'stale_or_duplicate' };

  if (leg.transfer_id) {
    await setTransferStatus(client, leg.transfer_id, 'confirmed');
  }

  // External truth for reconciliation (DESIGN §9): the statement row is what
  // the recon job anti-joins against the ledger. Keyed no-op on redelivery.
  await client.query(
    `INSERT INTO provider_statements (provider, external_ref, amount_minor, currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, external_ref) DO NOTHING`,
    [leg.provider, leg.external_ref ?? '', leg.amount_minor, leg.currency],
  );

  // Complete the execution only when every leg has settled. Single guarded
  // statement — race-safe under the row lock taken above.
  await client.query(
    `UPDATE route_executions
        SET status = 'completed', updated_at = now()
      WHERE id = $1 AND status = 'reserved'
        AND NOT EXISTS (
          SELECT 1 FROM route_legs WHERE execution_id = $1 AND status <> 'settled'
        )`,
    [leg.execution_id],
  );

  if (events) {
    emitLedgerEvent(events, {
      type: 'money.payout.settled',
      transferId: leg.transfer_id ?? leg.id,
      accountId: leg.user_account_id,
      amountMinor: leg.amount_minor,
      currency: leg.currency,
      provider: leg.provider,
    });
  }

  return { applied: true, legId: leg.id, executionId: leg.execution_id, legStatus: 'settled' };
}

async function failLeg(
  client: PoolClient,
  leg: RouteLegRow,
  failureReason: string | undefined,
  events?: EventLogger,
): Promise<ApplyEventResult> {
  const moved = await client.query(
    `UPDATE route_legs
        SET status = 'failed', failure_reason = $2, updated_at = now()
      WHERE id = $1 AND status IN ('reserved', 'initiated')`,
    [leg.id, failureReason ?? 'provider reported failure'],
  );
  if (moved.rowCount === 0) return { applied: false, reason: 'stale_or_duplicate' };

  // Release the reservation with a compensating transfer: the exact postings
  // of the hold, negated. The user's available comes back; history stays
  // intact ("we reserved, the provider failed it, we released" — three
  // transactions, zero edits). Idempotent per reversal key.
  await createBalancedTransfer(client, {
    idempotencyKey: `${leg.idempotency_key}:reversal`,
    kind: 'payout',
    status: 'confirmed',
    postings: buildLegPostings(legSpecFromRow(leg), -1n),
  });

  if (leg.transfer_id) {
    await setTransferStatus(client, leg.transfer_id, 'failed');
  }

  // One terminally failed leg fails the execution (visible to ops); already
  // settled sibling legs keep their own settled state — each leg lives its
  // own lifecycle once reserved (ADR-013).
  await client.query(
    `UPDATE route_executions SET status = 'failed', updated_at = now()
      WHERE id = $1 AND status = 'reserved'`,
    [leg.execution_id],
  );

  if (events) {
    emitLedgerEvent(events, {
      type: 'money.payout.failed',
      transferId: leg.transfer_id ?? leg.id,
      accountId: leg.user_account_id,
      amountMinor: leg.amount_minor,
      currency: leg.currency,
      provider: leg.provider,
      reason: failureReason ?? 'provider reported failure',
      willRetry: false, // terminal: the reservation was just released above
    });
  }

  return { applied: true, legId: leg.id, executionId: leg.execution_id, legStatus: 'failed' };
}
