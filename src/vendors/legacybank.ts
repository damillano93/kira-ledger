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

// LegacyBank — MOCK fiat provider #2, with a shape DELIBERATELY different from
// AcmePay (DESIGN §7.1: two providers, two vocabularies, ONE port):
//   * snake_case field names, terse legacy keys (`sts`, `amt`, `payment_ref`),
//   * amounts as decimal-dollar STRINGS ("4200.00"), never cents,
//   * sync-accept + POLL model: initiate answers {"sts":"ACCEPTED"} and there
//     are no webhooks — the caller polls, and the adapter synthesizes the same
//     canonical events a push provider would emit (one path downstream).
// The adapter translates units (string dollars <-> integer cents) with pure
// integer/BigInt math — no float ever touches a money value.

// -- LegacyBank's native wire shapes -----------------------------------------

const legacyPollSchema = z.object({
  payment_ref: z.string().min(1),
  // ACH-flavoured status codes; R01.. are terminal return codes.
  sts: z.union([
    z.enum(['ACCEPTED', 'IN_TRANSIT', 'SETTLED']),
    z.string().regex(/^R\d{2}$/, 'return code'),
  ]),
  amt: z.string().regex(/^\d+\.\d{2}$/, 'decimal dollar string'),
  return_reason: z.string().optional(),
});

type LegacyPoll = z.infer<typeof legacyPollSchema>;

function legacyStatusToCanonical(sts: string): CanonicalPayoutStatus {
  switch (sts) {
    case 'ACCEPTED':
      return 'initiated';
    case 'IN_TRANSIT':
      return 'processing';
    case 'SETTLED':
      return 'settled';
    default:
      // R01, R02, ... — terminal return codes.
      return 'failed';
  }
}

// "4200.00" -> 420000n. Pure string/BigInt arithmetic; a malformed amount is
// an error at the boundary, never a silently coerced float.
export function dollarStringToCents(amt: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(amt);
  if (!match) throw new Error(`legacybank: malformed dollar amount "${amt}"`);
  return BigInt(match[1]!) * 100n + BigInt(match[2]!);
}

// 420000n -> "4200.00".
export function centsToDollarString(minor: bigint): string {
  if (minor < 0n) throw new Error('legacybank: negative amounts are not payable');
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

interface LegacyPayoutRecord {
  paymentRef: string;
  clientReference: string;
  amountMinor: bigint;
  currency: string;
  destination: string;
  sts: string; // native status kept natively — mapping happens at the port
  returnReason?: string;
  settledAt?: string;
}

export class LegacyBankProvider implements PayoutProvider, MockSettlementControls {
  private readonly byClientReference = new Map<string, LegacyPayoutRecord>();
  private readonly byPaymentRef = new Map<string, LegacyPayoutRecord>();
  private refCounter = 0;

  constructor(public readonly name: string = 'legacybank') {}

  // Sync accept: {"sts":"ACCEPTED"}. Dedupes by client reference (ADR-011).
  async initiatePayout(input: PayoutRequest): Promise<PayoutAck> {
    const existing = this.byClientReference.get(input.clientReference);
    if (existing) {
      return {
        externalRef: existing.paymentRef,
        status: legacyStatusToCanonical(existing.sts),
      };
    }
    this.refCounter += 1;
    const paymentRef = `LB-${this.refCounter.toString().padStart(8, '0')}`;
    const record: LegacyPayoutRecord = {
      paymentRef,
      clientReference: input.clientReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      destination: input.destination,
      sts: 'ACCEPTED',
    };
    this.byClientReference.set(input.clientReference, record);
    this.byPaymentRef.set(paymentRef, record);
    return { externalRef: paymentRef, status: 'initiated' };
  }

  // Translate a native snake_case poll response into the canonical event.
  handleProviderEvent(raw: unknown): ProviderEvent {
    const parsed = legacyPollSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`legacybank: unrecognisable poll payload: ${parsed.error.message}`);
    }
    const poll = parsed.data;
    const status = legacyStatusToCanonical(poll.sts);
    return {
      externalRef: poll.payment_ref,
      status,
      ...(status === 'failed'
        ? { failureReason: poll.return_reason ?? `return code ${poll.sts}` }
        : {}),
    };
  }

  // Poll path: build the NATIVE response, then run it through the SAME mapping
  // a webhook would take — poll providers synthesize identical DomainEvents.
  async getPayout(externalRef: string): Promise<ProviderEvent> {
    const native = this.pollNative(externalRef);
    return this.handleProviderEvent(native);
  }

  exportStatementRows(): StatementRow[] {
    return [...this.byPaymentRef.values()]
      .filter((r) => r.sts === 'SETTLED')
      .map((r) => ({
        provider: this.name,
        externalRef: r.paymentRef,
        amountMinor: r.amountMinor,
        currency: r.currency,
        settledAt: r.settledAt ?? new Date().toISOString(),
      }));
  }

  // The native poll response, exactly as LegacyBank's API would answer it.
  pollNative(externalRef: string): LegacyPoll {
    const record = this.byPaymentRef.get(externalRef);
    if (!record) throw new UnknownPayoutError(this.name, externalRef);
    return {
      payment_ref: record.paymentRef,
      sts: record.sts,
      amt: centsToDollarString(record.amountMinor),
      ...(record.returnReason ? { return_reason: record.returnReason } : {}),
    };
  }

  // Mock control: flip the native status and return the native poll payload.
  emitSettlementEvent(
    externalRef: string,
    outcome: 'settled' | 'failed',
    failureReason?: string,
  ): unknown {
    const record = this.byPaymentRef.get(externalRef);
    if (!record) throw new UnknownPayoutError(this.name, externalRef);
    if (outcome === 'settled') {
      record.sts = 'SETTLED';
      record.settledAt = new Date().toISOString();
    } else {
      record.sts = 'R01';
      record.returnReason = failureReason ?? 'R01 insufficient funds at originating bank';
    }
    return this.pollNative(externalRef);
  }
}
