// Structured business events over pino.
//
// Every money-relevant moment in the system emits exactly one typed event
// through emitLedgerEvent(). The event `type` is the stable, grep-able contract
// (`fly logs | grep '"event":"recon.balance_drift"'`); the fields are the
// dimensions an alerting pipeline (Datadog / Loki / PagerDuty) would key on.
//
// Design rules:
// - One call per site: `emitLedgerEvent(req.log, { type: '...', ... })`.
//   The union is discriminated on `type`, so the compiler enforces the exact
//   field set per event — an integration site cannot forget `transferId`.
// - Amounts are ALWAYS minor units and are serialized as STRINGS. bigint does
//   not survive JSON.stringify, and floats do not survive money. Callers may
//   pass bigint or string; emit normalizes.
// - Severity and `alert: true` are NOT chosen at the call site. They come from
//   ALERT_POLICY (alerts.ts) so that "what pages at 3am" lives in one reviewed
//   table, not scattered across the codebase. `alert: true` marks the events a
//   log router should fan out to the paging pipeline.
//
// The logger parameter is structurally typed (info/warn/error taking an object
// plus message) so both Fastify's request/app logger (`req.log`, `app.log`) and
// a bare pino instance satisfy it with zero imports from pino in src/.

import { ALERT_POLICY } from './alerts.js';

/** Minimal structural view of a pino-compatible logger (FastifyBaseLogger fits). */
export interface EventLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Minor units. bigint at the call site, string on the wire. */
export type MinorAmount = bigint | string;

// ---------------------------------------------------------------------------
// The event vocabulary. Three namespaces:
//   money.*    — a ledger/transfer state change (the money paths themselves)
//   recon.*    — reconciliation findings (DESIGN.md §9: the backstop speaking)
//   provider.* / watcher.* — the edges where the outside world misbehaves
// ---------------------------------------------------------------------------

export type LedgerEvent =
  // -- money: inbound ------------------------------------------------------
  | {
      /** Watcher saw a deposit on-chain; booked to PENDING (not spendable). */
      type: 'money.deposit.detected';
      transferId: string;
      accountId: string;
      amountMinor: MinorAmount;
      currency: string;
      chain?: string;
      txHash?: string;
    }
  | {
      /** Confirmation threshold reached; deposit is final on its rail. */
      type: 'money.deposit.confirmed';
      transferId: string;
      accountId: string;
      amountMinor: MinorAmount;
      currency: string;
      confirmations?: number;
      /** detect -> confirm wall time; the customer-visible deposit latency. */
      latencyMs?: number;
    }
  | {
      /** pending -> available cleared, fees itemised (offramp.ts). */
      type: 'money.offramp.confirmed';
      transferId: string;
      depositTransferId?: string;
      accountId: string;
      amountMinor: MinorAmount;
      feeMinor?: MinorAmount;
      currency: string;
    }
  // -- money: outbound -----------------------------------------------------
  | {
      /** Hold committed (ledger-first, DESIGN.md §8); outbox row created. */
      type: 'money.payout.initiated';
      transferId: string;
      accountId: string;
      destinationAccountId?: string;
      amountMinor: MinorAmount;
      currency: string;
      provider?: string;
    }
  | {
      /** Provider confirmed settlement; funds have left for real. */
      type: 'money.payout.settled';
      transferId: string;
      accountId?: string;
      amountMinor: MinorAmount;
      currency: string;
      provider?: string;
      /** initiate -> settle wall time per provider; the payout SLA metric. */
      latencyMs?: number;
    }
  | {
      /** Payout failed. `willRetry: false` means terminal: funds must be released. */
      type: 'money.payout.failed';
      transferId: string;
      accountId?: string;
      amountMinor: MinorAmount;
      currency: string;
      provider?: string;
      reason: string;
      willRetry?: boolean;
    }
  | {
      /** Sweep found a transfer aged past its rail's SLA and still not final. */
      type: 'money.transfer.stuck_pending';
      transferId: string;
      kind?: 'deposit' | 'offramp' | 'payout';
      status?: string;
      ageSeconds: number;
      slaSeconds?: number;
      amountMinor?: MinorAmount;
      currency?: string;
    }
  // -- money: routes -------------------------------------------------------
  | {
      /** A route executed off a confirmed deposit (keyed, fires once). */
      type: 'money.route.fired';
      routeId: string;
      triggerTransferId: string;
      accountId?: string;
      amountMinor: MinorAmount;
      currency: string;
    }
  | {
      /** Route (or payout) hit the guarded decrement's rowcount-0 path (ADR-020). */
      type: 'money.route.insufficient_funds';
      routeId?: string;
      triggerTransferId?: string;
      accountId: string;
      amountMinor: MinorAmount;
      currency: string;
    }
  // -- recon: the backstop (DESIGN.md §9) -----------------------------------
  | {
      /** External truth has a movement the ledger never recorded (mismatch type 1). */
      type: 'recon.mismatch.settled_no_entry';
      source: string;
      externalId: string;
      amountMinor?: MinorAmount;
      currency?: string;
    }
  | {
      /** Ledger intent with no external fact past the rail's SLA (mismatch type 2). */
      type: 'recon.mismatch.entry_never_confirmed';
      transferId: string;
      status?: string;
      ageSeconds?: number;
      rail?: string;
      amountMinor?: MinorAmount;
      currency?: string;
    }
  | {
      /** spend_guards headroom != SUM(entries). The one invariant that must never break. */
      type: 'recon.balance_drift';
      accountId: string;
      guardMinor: MinorAmount;
      entriesMinor: MinorAmount;
      driftMinor: MinorAmount;
      currency?: string;
    }
  // -- edges ----------------------------------------------------------------
  | {
      /** Watcher confirmation queue exceeded its depth/age threshold. */
      type: 'watcher.confirmation_backlog';
      watcher: string;
      backlog: number;
      oldestAgeSeconds?: number;
      cursor?: string;
    }
  | {
      /** Inbound webhook rejected at the trust boundary (ADR-021). */
      type: 'provider.webhook.rejected';
      provider: string;
      reason: 'bad_signature' | 'missing_timestamp' | 'stale_timestamp' | 'duplicate' | 'malformed';
      eventId?: string;
    }
  | {
      /** Outbound provider call failed (dispatcher / getPayout / statement pull). */
      type: 'provider.call.failed';
      provider: string;
      operation: string;
      transferId?: string;
      statusCode?: number;
      attempt?: number;
      willRetry?: boolean;
      latencyMs?: number;
      reason?: string;
    };

export type LedgerEventType = LedgerEvent['type'];

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

export interface LogPayload {
  level: 'info' | 'warn' | 'error';
  /** The object handed to pino: { event, alert, ...fields } with bigints stringified. */
  payload: Record<string, unknown>;
  msg: string;
}

/**
 * Pure half of the emitter: event -> (level, JSON-safe payload, msg).
 * Exposed so tests (and any future transport) can assert the exact shape
 * without standing up a logger.
 */
export function toLogPayload(event: LedgerEvent): LogPayload {
  const policy = ALERT_POLICY[event.type];
  const payload: Record<string, unknown> = { event: event.type, alert: policy.page };
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type') continue;
    payload[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return { level: policy.level, payload, msg: event.type };
}

/**
 * Emit one structured business event. One line per integration site:
 *
 *   emitLedgerEvent(req.log, {
 *     type: 'money.payout.initiated',
 *     transferId: t.id, accountId, amountMinor: amount, currency,
 *   });
 */
export function emitLedgerEvent(logger: EventLogger, event: LedgerEvent): void {
  const { level, payload, msg } = toLogPayload(event);
  logger[level](payload, msg);
}
