import { describe, expect, it } from 'vitest';
import { AcmePayProvider } from '../../src/vendors/acmepay.js';
import {
  centsToDollarString,
  dollarStringToCents,
  LegacyBankProvider,
} from '../../src/vendors/legacybank.js';
import { PolygonUsdtProvider } from '../../src/vendors/polygon-usdt.js';
import { hasMockControls, type PayoutRequest } from '../../src/vendors/provider.js';
import { buildRegistry } from '../../src/vendors/registry.js';

// The DESIGN §7.1 promise, tested: two fiat mocks with deliberately DIFFERENT
// native shapes (camelCase number-cents webhooks vs snake_case dollar-string
// polls) plus a simulated chain adapter, all mapped onto ONE canonical port.

function request(ref: string): PayoutRequest {
  return {
    clientReference: ref,
    amountMinor: 420000n,
    currency: 'USD',
    destination: 'dest-account',
  };
}

describe('AcmePay adapter (camelCase, integer cents as JSON numbers, push webhooks)', () => {
  it('acks immediately and dedupes by clientReference (replay returns the ORIGINAL ack)', async () => {
    const acme = new AcmePayProvider();
    const first = await acme.initiatePayout(request('route:e1:leg:1'));
    expect(first.status).toBe('initiated');
    expect(first.externalRef).toMatch(/^acp_/);

    // Crash-recovery semantics: the same clientReference never creates a
    // second payout — the provider replays the original reference.
    const replay = await acme.initiatePayout(request('route:e1:leg:1'));
    expect(replay.externalRef).toBe(first.externalRef);

    const other = await acme.initiatePayout(request('route:e1:leg:2'));
    expect(other.externalRef).not.toBe(first.externalRef);
  });

  it('maps its native camelCase webhook vocabulary to canonical states', () => {
    const acme = new AcmePayProvider();
    expect(
      acme.handleProviderEvent({
        eventId: 'evt_1',
        payoutId: 'acp_abc',
        eventType: 'payout.completed',
        amountCents: 420000, // AcmePay's own convention: a JSON number
      }),
    ).toEqual({ externalRef: 'acp_abc', status: 'settled' });

    expect(
      acme.handleProviderEvent({
        eventId: 'evt_2',
        payoutId: 'acp_abc',
        eventType: 'payout.rejected',
        amountCents: 420000,
        failureCode: 'R03',
      }),
    ).toEqual({ externalRef: 'acp_abc', status: 'failed', failureReason: 'R03' });

    expect(
      acme.handleProviderEvent({
        eventId: 'evt_3',
        payoutId: 'acp_abc',
        eventType: 'payout.processing',
        amountCents: 420000,
      }).status,
    ).toBe('processing');

    // A fractional-cents amount is a malformed payload, not a rounding call.
    expect(() =>
      acme.handleProviderEvent({
        eventId: 'evt_4',
        payoutId: 'acp_abc',
        eventType: 'payout.completed',
        amountCents: 4200.5,
      }),
    ).toThrow(/unrecognisable/);
  });
});

describe('LegacyBank adapter (snake_case, decimal-dollar strings, sync accept + poll)', () => {
  it('converts dollar strings to cents with pure integer math (both directions)', () => {
    expect(dollarStringToCents('4200.00')).toBe(420000n);
    expect(dollarStringToCents('0.01')).toBe(1n);
    expect(centsToDollarString(420000n)).toBe('4200.00');
    expect(centsToDollarString(1n)).toBe('0.01');
    expect(centsToDollarString(60050n)).toBe('600.50');
    // Malformed amounts are boundary errors, never coerced through a float.
    expect(() => dollarStringToCents('4200')).toThrow(/malformed/);
    expect(() => dollarStringToCents('4200.0')).toThrow(/malformed/);
  });

  it('accepts synchronously ({"sts":"ACCEPTED"}) and maps poll vocabulary to canonical states', async () => {
    const legacy = new LegacyBankProvider();
    const ack = await legacy.initiatePayout(request('route:e2:leg:1'));
    expect(ack.status).toBe('initiated');
    expect(ack.externalRef).toMatch(/^LB-/);

    // The native poll response is snake_case with a dollar-string amount.
    const native = legacy.pollNative(ack.externalRef);
    expect(native).toMatchObject({ payment_ref: ack.externalRef, sts: 'ACCEPTED', amt: '4200.00' });

    // Poll providers synthesize the SAME canonical events a webhook would.
    expect(await legacy.getPayout(ack.externalRef)).toEqual({
      externalRef: ack.externalRef,
      status: 'initiated',
    });

    expect(
      legacy.handleProviderEvent({ payment_ref: 'LB-1', sts: 'IN_TRANSIT', amt: '4200.00' }).status,
    ).toBe('processing');
    expect(
      legacy.handleProviderEvent({ payment_ref: 'LB-1', sts: 'SETTLED', amt: '4200.00' }).status,
    ).toBe('settled');

    const returned = legacy.handleProviderEvent({
      payment_ref: 'LB-1',
      sts: 'R01',
      amt: '4200.00',
    });
    expect(returned.status).toBe('failed');
    expect(returned.failureReason).toMatch(/R01/);
  });
});

describe('polygon-usdt simulated adapter (same port as the fiat providers)', () => {
  it('emits a deterministic pseudo tx-hash and settles after the simulated confirmation delay', async () => {
    const slow = new PolygonUsdtProvider('polygon-usdt', { settleDelayMs: 60_000 });
    const ack = await slow.initiatePayout(request('route:e3:leg:2'));
    expect(ack.externalRef).toMatch(/^0x[0-9a-f]{64}$/);
    // Deterministic per clientReference: the dedupe a real signer gets from
    // persisting the signed tx and re-querying by signature (ADR-012).
    const replay = await slow.initiatePayout(request('route:e3:leg:2'));
    expect(replay.externalRef).toBe(ack.externalRef);
    // Before the threshold the send is not money moved.
    expect((await slow.getPayout(ack.externalRef)).status).toBe('initiated');

    const instant = new PolygonUsdtProvider('polygon-usdt', { settleDelayMs: 0 });
    const sent = await instant.initiatePayout(request('route:e4:leg:2'));
    expect((await instant.getPayout(sent.externalRef)).status).toBe('settled');
  });
});

describe('contract suite: every registered adapter honours the same port', () => {
  // The mechanical proof of "provider #3 is a config change" (DESIGN §7.1):
  // one parameterized suite runs against every registry entry. A new adapter
  // passes this same loop or does not ship.
  const registry = buildRegistry([
    { name: 'acmepay', adapter: 'acmepay' },
    { name: 'legacybank', adapter: 'legacybank' },
    { name: 'polygon-usdt', adapter: 'polygon-usdt', options: { settleDelayMs: 60_000 } },
  ]);

  for (const provider of registry.list()) {
    it(`${provider.name}: initiate -> dedupe -> settle -> statement, all through the canonical port`, async () => {
      const ref = `contract:${provider.name}:leg:1`;
      const ack = await provider.initiatePayout({
        clientReference: ref,
        amountMinor: 123400n,
        currency: provider.name === 'polygon-usdt' ? 'USDT' : 'USD',
        destination: 'dest',
      });
      expect(ack.status).toBe('initiated');
      expect(ack.externalRef.length).toBeGreaterThan(0);

      // ADR-011: dedupe by client reference is a hard contract requirement.
      const replay = await provider.initiatePayout({
        clientReference: ref,
        amountMinor: 123400n,
        currency: provider.name === 'polygon-usdt' ? 'USDT' : 'USD',
        destination: 'dest',
      });
      expect(replay.externalRef).toBe(ack.externalRef);

      // Native settlement payload -> adapter -> canonical event: three
      // different wire shapes, one downstream vocabulary.
      expect(hasMockControls(provider)).toBe(true);
      if (!hasMockControls(provider)) return;
      const native = provider.emitSettlementEvent(ack.externalRef, 'settled');
      const canonical = provider.handleProviderEvent(native);
      expect(canonical).toMatchObject({ externalRef: ack.externalRef, status: 'settled' });

      // And the settled payout shows up as provider-side truth for recon.
      const statement = provider
        .exportStatementRows()
        .find((row) => row.externalRef === ack.externalRef);
      expect(statement).toBeDefined();
      expect(statement?.amountMinor).toBe(123400n);
    });
  }
});
