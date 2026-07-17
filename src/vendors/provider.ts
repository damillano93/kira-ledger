// The vendor abstraction (DESIGN §7.1). The port speaks DOMAIN vocabulary —
// canonical units (integer minor units as bigint) and canonical statuses —
// never a provider's. Adapters translate exactly three things: units, status
// vocabulary, and error taxonomy. Anything provider-specific that leaked
// upward would become a rewrite later, so nothing does.

// Canonical payout states, mapped 1:1 onto the outbound transfer machine
// (DESIGN §5): initiated = the ack, processing = in transit, settled/failed
// are terminal. State only ever moves forward (monotonic).
// (Monotonicity — a settled leg can never regress — is enforced where it
// cannot race: guarded UPDATE ... WHERE status IN (...) in src/routing.)
export type CanonicalPayoutStatus = 'initiated' | 'processing' | 'settled' | 'failed';

export interface PayoutRequest {
  // Deterministic idempotency key (`route:{executionId}:leg:{seq}`). Providers
  // MUST dedupe by it (ADR-011): re-dispatch after a crash returns the
  // original ack, never a second payout.
  clientReference: string;
  amountMinor: bigint; // canonical integer minor units — adapters translate
  currency: string;
  destination: string; // counterparty identifier (account id / address)
}

export interface PayoutAck {
  externalRef: string; // the provider's own reference for the payout
  status: CanonicalPayoutStatus;
}

// The one event shape everything downstream consumes. Push providers translate
// webhooks into this; poll providers synthesize the SAME shape from a poll —
// one path downstream, no special cases.
export interface ProviderEvent {
  externalRef: string;
  status: CanonicalPayoutStatus;
  failureReason?: string;
}

// A provider-side settlement fact, for reconciliation (DESIGN §9). Recon
// compares these against our ledger in both directions.
export interface StatementRow {
  provider: string;
  externalRef: string;
  amountMinor: bigint;
  currency: string;
  settledAt: string; // ISO timestamp
}

// The port. Three methods plus statements export; a mock adapter is ~50 lines,
// which is what makes provider #3 a config change (DESIGN §7.1).
export interface PayoutProvider {
  readonly name: string;

  // Initiate (or replay — dedupe by clientReference) an outbound payout.
  initiatePayout(input: PayoutRequest): Promise<PayoutAck>;

  // Translate a provider-NATIVE notification payload (webhook body or poll
  // response) into the canonical event. Throws on an unrecognisable shape.
  handleProviderEvent(raw: unknown): ProviderEvent;

  // Poll the provider for the current state of a payout. ALWAYS implemented —
  // crash recovery (query-before-retry, ADR-012) and recon depend on it.
  getPayout(externalRef: string): Promise<ProviderEvent>;

  // Provider-side truth of settled payouts, the input to reconciliation.
  exportStatementRows(): StatementRow[];
}

export class UnknownPayoutError extends Error {
  constructor(provider: string, ref: string) {
    super(`provider ${provider} knows no payout with reference ${ref}`);
    this.name = 'UnknownPayoutError';
  }
}

// ---------------------------------------------------------------------------
// Mock-only control surface. Real providers settle on their own schedule; the
// mocks expose a lever so a demo/test can drive settlement deterministically.
// emitSettlementEvent returns the provider's NATIVE payload (deliberately
// different shapes per provider) which is then fed through the adapter's
// handleProviderEvent — so forcing a settlement exercises the exact same
// mapping code a real webhook/poll would.
// ---------------------------------------------------------------------------
export interface MockSettlementControls {
  emitSettlementEvent(
    externalRef: string,
    outcome: 'settled' | 'failed',
    failureReason?: string,
  ): unknown;
}

export function hasMockControls(
  provider: PayoutProvider,
): provider is PayoutProvider & MockSettlementControls {
  return (
    typeof (provider as Partial<MockSettlementControls>).emitSettlementEvent === 'function'
  );
}
