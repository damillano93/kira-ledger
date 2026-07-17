import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ALERT_POLICY } from '../../src/observability/alerts.js';
import {
  emitLedgerEvent,
  toLogPayload,
  type LedgerEvent,
} from '../../src/observability/events.js';

// Capture pino's raw output lines so we assert on the EXACT JSON that would
// reach the log pipeline — the same bytes `fly logs | grep` would see.
function captureLogger() {
  const lines: string[] = [];
  const logger = pino(
    { base: null, timestamp: false },
    { write: (line: string) => lines.push(line) },
  );
  return { logger, lines };
}

describe('structured ledger events (emitLedgerEvent)', () => {
  it('emits a paging-worthy event as error JSON with alert:true and stringified bigint amounts', () => {
    const { logger, lines } = captureLogger();

    emitLedgerEvent(logger, {
      type: 'recon.balance_drift',
      accountId: 'acct-1',
      guardMinor: 99_500n,
      entriesMinor: 100_000n,
      driftMinor: -500n,
      currency: 'USD',
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      level: 50, // pino error
      event: 'recon.balance_drift',
      alert: true,
      accountId: 'acct-1',
      guardMinor: '99500', // bigint -> string, never a JSON number
      entriesMinor: '100000',
      driftMinor: '-500',
      currency: 'USD',
      msg: 'recon.balance_drift',
    });
  });

  it('emits an operational money event as info with alert:false', () => {
    const { logger, lines } = captureLogger();

    emitLedgerEvent(logger, {
      type: 'money.deposit.detected',
      transferId: 'tr-42',
      accountId: 'acct-1',
      amountMinor: 1_500_000n,
      currency: 'USDC',
      chain: 'solana',
      txHash: 'sig123',
    });

    const record = JSON.parse(lines[0]!);
    expect(record.level).toBe(30); // pino info
    expect(record.event).toBe('money.deposit.detected');
    expect(record.alert).toBe(false);
    expect(record.amountMinor).toBe('1500000');
    expect(record.txHash).toBe('sig123');
  });

  it('routes warn-level edge events at the level the policy table dictates', () => {
    const { logger, lines } = captureLogger();

    emitLedgerEvent(logger, {
      type: 'provider.webhook.rejected',
      provider: 'acmepay',
      reason: 'bad_signature',
      eventId: 'evt-9',
    });

    const record = JSON.parse(lines[0]!);
    expect(record.level).toBe(40); // pino warn
    expect(record.reason).toBe('bad_signature');
  });

  it('derives level and alert from ALERT_POLICY for every event type (single source of truth)', () => {
    const sample: LedgerEvent = {
      type: 'money.payout.failed',
      transferId: 'tr-1',
      amountMinor: '100',
      currency: 'USD',
      reason: 'account_closed',
      willRetry: false,
    };
    const { level, payload } = toLogPayload(sample);
    expect(level).toBe(ALERT_POLICY['money.payout.failed'].level);
    expect(payload.alert).toBe(ALERT_POLICY['money.payout.failed'].page);
    // `type` is renamed to `event` in the payload, not duplicated.
    expect(payload.type).toBeUndefined();
    expect(payload.event).toBe('money.payout.failed');
  });
});
