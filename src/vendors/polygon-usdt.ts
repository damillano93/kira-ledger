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

// polygon-usdt — SIMULATED chain adapter behind the SAME payout port as the
// fiat providers (DESIGN §7.2: real + simulator behind one port).
//
// HONEST SIMULATION NOTE (decision recorded, not to be revisited here): in
// production this adapter would hold a real signer (viem wallet client on
// Polygon), persist the SIGNED transaction before broadcasting (ADR-012:
// intent survives a crash; recovery queries by signature before re-signing),
// broadcast the ERC-20 transfer, and report `settled` only after the send
// clears the per-chain confirmation threshold (ADR-009, N blocks on Polygon).
// The simulation reproduces the externally observable contract — a tx hash on
// initiation, settlement after a delay (standing in for block confirmations) —
// so swapping in the real signer changes THIS file only, nothing upstream.

const chainEventSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  status: z.enum(['pending', 'confirming', 'finalized', 'reverted']),
  confirmations: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

type ChainEvent = z.infer<typeof chainEventSchema>;

const CHAIN_STATUS_TO_CANONICAL: Record<ChainEvent['status'], CanonicalPayoutStatus> = {
  pending: 'initiated',
  confirming: 'processing',
  finalized: 'settled',
  reverted: 'failed',
};

interface SimulatedSend {
  txHash: string;
  clientReference: string;
  amountMinor: bigint;
  currency: string;
  destination: string;
  submittedAtMs: number;
  // A forced outcome (mock control) overrides the delay-based simulation.
  forced?: { status: 'finalized' | 'reverted'; reason?: string };
  settledAt?: string;
}

export interface PolygonUsdtOptions {
  // Milliseconds standing in for the confirmation threshold. Tests inject 0.
  settleDelayMs?: number;
}

export class PolygonUsdtProvider implements PayoutProvider, MockSettlementControls {
  private readonly byClientReference = new Map<string, SimulatedSend>();
  private readonly byTxHash = new Map<string, SimulatedSend>();
  private readonly settleDelayMs: number;

  constructor(
    public readonly name: string = 'polygon-usdt',
    options: PolygonUsdtOptions = {},
  ) {
    this.settleDelayMs = options.settleDelayMs ?? 1500;
  }

  // "Broadcast" the send: a pseudo tx hash derived DETERMINISTICALLY from the
  // client reference — the same reference always maps to the same simulated
  // tx, which is precisely the dedupe a real signer achieves by persisting the
  // signed transaction and re-querying by signature (ADR-012).
  async initiatePayout(input: PayoutRequest): Promise<PayoutAck> {
    const existing = this.byClientReference.get(input.clientReference);
    if (existing) {
      return { externalRef: existing.txHash, status: this.currentStatus(existing) };
    }
    const txHash = `0x${createHash('sha256').update(`polygon-usdt:${input.clientReference}`).digest('hex')}`;
    const send: SimulatedSend = {
      txHash,
      clientReference: input.clientReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      destination: input.destination,
      submittedAtMs: Date.now(),
    };
    this.byClientReference.set(input.clientReference, send);
    this.byTxHash.set(txHash, send);
    return { externalRef: txHash, status: 'initiated' };
  }

  handleProviderEvent(raw: unknown): ProviderEvent {
    const parsed = chainEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`polygon-usdt: unrecognisable chain event: ${parsed.error.message}`);
    }
    const event = parsed.data;
    const status = CHAIN_STATUS_TO_CANONICAL[event.status];
    return {
      externalRef: event.txHash,
      status,
      ...(status === 'failed' ? { failureReason: event.reason ?? 'transaction reverted' } : {}),
    };
  }

  // Poll path: re-derive the current chain state (delay elapsed = threshold
  // reached) and map it through the same event translation.
  async getPayout(externalRef: string): Promise<ProviderEvent> {
    const send = this.byTxHash.get(externalRef);
    if (!send) throw new UnknownPayoutError(this.name, externalRef);
    return this.handleProviderEvent(this.nativeEventFor(send));
  }

  exportStatementRows(): StatementRow[] {
    return [...this.byTxHash.values()]
      .filter((s) => this.currentStatus(s) === 'settled')
      .map((s) => ({
        provider: this.name,
        externalRef: s.txHash,
        amountMinor: s.amountMinor,
        currency: s.currency,
        settledAt: s.settledAt ?? new Date(s.submittedAtMs + this.settleDelayMs).toISOString(),
      }));
  }

  // Mock control: force finality (or a revert) regardless of the delay, and
  // return the native chain event for the adapter to translate.
  emitSettlementEvent(
    externalRef: string,
    outcome: 'settled' | 'failed',
    failureReason?: string,
  ): unknown {
    const send = this.byTxHash.get(externalRef);
    if (!send) throw new UnknownPayoutError(this.name, externalRef);
    send.forced =
      outcome === 'settled'
        ? { status: 'finalized' }
        : { status: 'reverted', ...(failureReason ? { reason: failureReason } : {}) };
    if (outcome === 'settled') send.settledAt = new Date().toISOString();
    return this.nativeEventFor(send);
  }

  private nativeEventFor(send: SimulatedSend): ChainEvent {
    if (send.forced) {
      return {
        txHash: send.txHash,
        status: send.forced.status,
        confirmations: send.forced.status === 'finalized' ? 30 : 0,
        ...(send.forced.reason ? { reason: send.forced.reason } : {}),
      };
    }
    const elapsed = Date.now() - send.submittedAtMs;
    if (elapsed >= this.settleDelayMs) {
      return { txHash: send.txHash, status: 'finalized', confirmations: 30 };
    }
    if (elapsed >= this.settleDelayMs / 2) {
      return { txHash: send.txHash, status: 'confirming', confirmations: 7 };
    }
    return { txHash: send.txHash, status: 'pending', confirmations: 0 };
  }

  private currentStatus(send: SimulatedSend): CanonicalPayoutStatus {
    return this.handleProviderEvent(this.nativeEventFor(send)).status;
  }
}
