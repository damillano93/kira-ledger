import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  UnknownPayoutError,
  type CanonicalPayoutStatus,
  type MockSettlementControls,
  type PayoutAck,
  type PayoutProvider,
  type PayoutRequest,
  type ProviderEvent,
  type StatementRow,
} from './provider.js';

// AcmePay — MOCK fiat provider #1 (DESIGN §7.1 preview, ADR-018: we build it).
// Shape choices are DELIBERATE and different from LegacyBank:
//   * camelCase field names,
//   * amounts as integer cents transmitted as a JSON NUMBER,
//   * async push model: initiate acks immediately with `pending`, settlement
//     arrives later as a webhook-style event (payout.completed / rejected).
// The adapter's job is to translate that vocabulary into the canonical port —
// nothing AcmePay-flavoured ever leaves this file.

// -- AcmePay's native wire shapes --------------------------------------------

const acmeWebhookSchema = z.object({
  eventId: z.string().min(1),
  payoutId: z.string().min(1),
  eventType: z.enum(['payout.processing', 'payout.completed', 'payout.rejected']),
  // Integer cents as a JSON number — a shape WE would never emit (our API uses
  // strings), which is exactly why the adapter exists. int() + safe() keeps
  // the no-float rule intact: any fractional value is rejected at the edge.
  amountCents: z.number().int().safe(),
  failureCode: z.string().optional(),
});

type AcmeWebhook = z.infer<typeof acmeWebhookSchema>;

const ACME_STATUS_TO_CANONICAL: Record<AcmeWebhook['eventType'], CanonicalPayoutStatus> = {
  'payout.processing': 'processing',
  'payout.completed': 'settled',
  'payout.rejected': 'failed',
};

interface AcmePayoutRecord {
  payoutId: string;
  clientReference: string;
  amountMinor: bigint;
  currency: string;
  destination: string;
  status: CanonicalPayoutStatus; // internal bookkeeping in canonical terms
  failureReason?: string;
  settledAt?: string;
}

export class AcmePayProvider implements PayoutProvider, MockSettlementControls {
  private readonly byClientReference = new Map<string, AcmePayoutRecord>();
  private readonly byPayoutId = new Map<string, AcmePayoutRecord>();
  private eventCounter = 0;

  constructor(public readonly name: string = 'acmepay') {}

  // Immediate ack (`202 {status:"pending"}` in the DESIGN table). Dedupe by
  // clientReference is a hard requirement (ADR-011): a re-dispatch after a
  // crash replays the ORIGINAL ack instead of creating a second payout.
  async initiatePayout(input: PayoutRequest): Promise<PayoutAck> {
    const existing = this.byClientReference.get(input.clientReference);
    if (existing) {
      return { externalRef: existing.payoutId, status: existing.status };
    }
    // Deterministic ref derived from the client reference: the same request
    // maps to the same payout even across a mock restart.
    const payoutId = `acp_${createHash('sha256').update(input.clientReference).digest('hex').slice(0, 16)}`;
    const record: AcmePayoutRecord = {
      payoutId,
      clientReference: input.clientReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      destination: input.destination,
      status: 'initiated',
    };
    this.byClientReference.set(input.clientReference, record);
    this.byPayoutId.set(payoutId, record);
    return { externalRef: payoutId, status: 'initiated' };
  }

  // Translate a native camelCase webhook into the canonical event. Pure
  // mapping — validation at the edge, canonical vocabulary out.
  handleProviderEvent(raw: unknown): ProviderEvent {
    const parsed = acmeWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`acmepay: unrecognisable webhook payload: ${parsed.error.message}`);
    }
    const event = parsed.data;
    const status = ACME_STATUS_TO_CANONICAL[event.eventType];
    return {
      externalRef: event.payoutId,
      status,
      ...(status === 'failed'
        ? { failureReason: event.failureCode ?? 'rejected without a code' }
        : {}),
    };
  }

  async getPayout(externalRef: string): Promise<ProviderEvent> {
    const record = this.byPayoutId.get(externalRef);
    if (!record) throw new UnknownPayoutError(this.name, externalRef);
    return {
      externalRef: record.payoutId,
      status: record.status,
      ...(record.failureReason ? { failureReason: record.failureReason } : {}),
    };
  }

  exportStatementRows(): StatementRow[] {
    return [...this.byPayoutId.values()]
      .filter((r) => r.status === 'settled')
      .map((r) => ({
        provider: this.name,
        externalRef: r.payoutId,
        amountMinor: r.amountMinor,
        currency: r.currency,
        settledAt: r.settledAt ?? new Date().toISOString(),
      }));
  }

  // Mock control: settle/fail a payout and return the NATIVE webhook payload
  // AcmePay would have pushed — the caller feeds it back through
  // handleProviderEvent, exercising the real mapping path.
  emitSettlementEvent(
    externalRef: string,
    outcome: 'settled' | 'failed',
    failureReason?: string,
  ): unknown {
    const record = this.byPayoutId.get(externalRef);
    if (!record) throw new UnknownPayoutError(this.name, externalRef);
    record.status = outcome;
    if (outcome === 'settled') record.settledAt = new Date().toISOString();
    if (outcome === 'failed') record.failureReason = failureReason ?? 'R_MOCK';
    this.eventCounter += 1;
    const native: AcmeWebhook = {
      eventId: `evt_${this.eventCounter.toString().padStart(6, '0')}`,
      payoutId: record.payoutId,
      eventType: outcome === 'settled' ? 'payout.completed' : 'payout.rejected',
      amountCents: Number(record.amountMinor), // AcmePay's own (number) convention
      ...(outcome === 'failed' ? { failureCode: failureReason ?? 'R_MOCK' } : {}),
    };
    return native;
  }
}
