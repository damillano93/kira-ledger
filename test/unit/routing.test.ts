import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { confirmOfframp, recordDeposit } from '../../src/domain/offramp.js';
import {
  dispatchExecution,
  onOfframpConfirmed,
  retryExecution,
} from '../../src/routing/engine.js';
import { applyProviderEvent } from '../../src/routing/settlement.js';
import { hasMockControls } from '../../src/vendors/provider.js';
import { buildRegistry } from '../../src/vendors/registry.js';
import { createAccount, getBalance, type TestAccount } from '../helpers/db.js';

// Routing engine semantics (ADR-013), against the real database:
//   * a route fires exactly ONCE per trigger transfer (R4);
//   * reservation is all-or-nothing — insufficient funds leaves a visible,
//     retryable execution and NOT ONE partially reserved cent;
//   * settlement drives each leg's own lifecycle and books provider
//     statements for recon.

interface Fixture {
  user: TestAccount;
  external: TestAccount;
  fee: TestAccount;
  achDestination: TestAccount;
  usdtDestination: TestAccount;
  conversionUsd: TestAccount;
  conversionUsdt: TestAccount;
  routeId: string;
}

// Mirror of the seeded Northwind route, minted per test for isolation:
// seq 1: 420000 USD cents by ACH (acmepay);
// seq 2: 600 USDT = 600000000 (6dp), debiting 60000 USD cents at the 1:1 peg.
const ACH_CENTS = 420000n;
const USDT_MINOR = 600000000n;
const USDT_COST_CENTS = 60000n;
const TOTAL_CENTS = ACH_CENTS + USDT_COST_CENTS; // 480000

async function seedFixture(): Promise<Fixture> {
  const user = await createAccount('user');
  const external = await createAccount('external', { currency: 'USDC' });
  const fee = await createAccount('fee');
  const achDestination = await createAccount('external');
  const usdtDestination = await createAccount('external', { currency: 'USDT' });
  const conversionUsd = await createAccount('liability'); // conversion pair, USD side
  const conversionUsdt = await createAccount('liability', { currency: 'USDT' });

  const routeId = randomUUID();
  await pool.query(
    `INSERT INTO routes (id, name, trigger_account_id, active) VALUES ($1, $2, $3, true)`,
    [routeId, `test-route-${routeId.slice(0, 8)}`, user.id],
  );
  await pool.query(
    `INSERT INTO route_actions (route_id, seq, provider, amount_minor, currency,
                                source_amount_minor, source_currency, destination_account_id,
                                source_conversion_account_id, destination_conversion_account_id)
     VALUES ($1, 1, 'acmepay', $2, 'USD', $2, 'USD', $3, NULL, NULL),
            ($1, 2, 'polygon-usdt', $4, 'USDT', $5, 'USD', $6, $7, $8)`,
    [
      routeId,
      ACH_CENTS.toString(),
      achDestination.id,
      USDT_MINOR.toString(),
      USDT_COST_CENTS.toString(),
      usdtDestination.id,
      conversionUsd.id,
      conversionUsdt.id,
    ],
  );

  return { user, external, fee, achDestination, usdtDestination, conversionUsd, conversionUsdt, routeId };
}

// Deposit + confirm an off-ramp so the user has `gross - feeAmount` available,
// returning the CONFIRMED off-ramp transfer id — the route trigger.
async function confirmedOfframp(
  fixture: Fixture,
  gross: bigint,
  feeAmount: bigint,
): Promise<string> {
  const key = `route-test-dep-${randomUUID()}`;
  const deposit = await withTx((client) =>
    recordDeposit(client, {
      idempotencyKey: key,
      externalAccountId: fixture.external.id,
      userAccountId: fixture.user.id,
      amount: gross,
      currency: 'USD',
    }),
  );
  const offramp = await withTx((client) =>
    confirmOfframp(client, {
      idempotencyKey: `${key}:offramp`,
      depositTransferId: deposit.transfer.id,
      userAccountId: fixture.user.id,
      feeAccountId: fixture.fee.id,
      amount: gross,
      feeAmount,
      currency: 'USD',
    }),
  );
  return offramp.transfer.id;
}

function testRegistry() {
  // Isolated registry per test: mock providers keep in-memory payout state.
  // Polygon settles instantly so polls are deterministic.
  return buildRegistry([
    { name: 'acmepay', adapter: 'acmepay' },
    { name: 'legacybank', adapter: 'legacybank' },
    { name: 'polygon-usdt', adapter: 'polygon-usdt', options: { settleDelayMs: 0 } },
  ]);
}

describe('routing engine: fires once, all-or-nothing, retryable', () => {
  it('fires exactly ONCE per trigger transfer (a redelivered trigger is a keyed no-op)', async () => {
    const fixture = await seedFixture();
    // Northwind numbers: 5,000.00 gross, 38.50 fees -> 4,961.50 available.
    const trigger = await confirmedOfframp(fixture, 500000n, 3850n);

    const first = await withTx((c) => onOfframpConfirmed(c, trigger, fixture.user.id));
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe('reserved');

    // Both legs reserved in seq order; the user paid exactly 4,800.00 total.
    const balance = await getBalance(fixture.user.id);
    expect(balance?.available).toBe(496150n - TOTAL_CENTS); // 16150

    // The redelivery: same trigger, same route -> the UNIQUE pair wins.
    const second = await withTx((c) => onOfframpConfirmed(c, trigger, fixture.user.id));
    expect(second[0]!.status).toBe('already_fired');
    expect(second[0]!.executionId).toBe(first[0]!.executionId);

    // No double reservation, no extra legs.
    expect((await getBalance(fixture.user.id))?.available).toBe(16150n);
    const legs = await pool.query(
      `SELECT seq, provider, status FROM route_legs WHERE execution_id = $1 ORDER BY seq`,
      [first[0]!.executionId],
    );
    expect(legs.rows).toEqual([
      { seq: 1, provider: 'acmepay', status: 'reserved' },
      { seq: 2, provider: 'polygon-usdt', status: 'reserved' },
    ]);
  });

  it('rejects a trigger that is not a confirmed off-ramp', async () => {
    const fixture = await seedFixture();
    // A raw deposit (kind=deposit, status=pending) must not fire routes:
    // routes fire when money becomes AVAILABLE, never on pending.
    const deposit = await withTx((client) =>
      recordDeposit(client, {
        idempotencyKey: `not-a-trigger-${randomUUID()}`,
        externalAccountId: fixture.external.id,
        userAccountId: fixture.user.id,
        amount: 500000n,
        currency: 'USD',
      }),
    );
    await expect(
      withTx((c) => onOfframpConfirmed(c, deposit.transfer.id, fixture.user.id)),
    ).rejects.toThrow(/not a confirmed off-ramp/);
  });

  it('insufficient funds: visible retryable execution, ZERO partial reservation, retry succeeds after top-up', async () => {
    const fixture = await seedFixture();
    // 4,500.00 available: covers the ACH leg (4,200.00) alone but not both
    // legs (4,800.00) — the partial ACH reservation MUST roll back.
    const trigger = await confirmedOfframp(fixture, 450000n, 0n);

    const fired = await withTx((c) => onOfframpConfirmed(c, trigger, fixture.user.id));
    expect(fired[0]!.status).toBe('insufficient_funds');
    const executionId = fired[0]!.executionId;

    // Not one cent moved and no leg rows survive — all-or-nothing.
    expect((await getBalance(fixture.user.id))?.available).toBe(450000n);
    const legs = await pool.query(`SELECT 1 FROM route_legs WHERE execution_id = $1`, [executionId]);
    expect(legs.rowCount).toBe(0);

    // The state is visible in the executions table...
    const status = await pool.query<{ status: string }>(
      `SELECT status FROM route_executions WHERE id = $1`,
      [executionId],
    );
    expect(status.rows[0]!.status).toBe('insufficient_funds');

    // ...and retryable: still short -> still insufficient_funds, still no partial.
    const retryShort = await withTx((c) => retryExecution(c, executionId));
    expect(retryShort?.status).toBe('insufficient_funds');
    expect((await getBalance(fixture.user.id))?.available).toBe(450000n);

    // Top up 1,000.00 via a second off-ramp, retry again: now it reserves.
    await confirmedOfframp(fixture, 100000n, 0n);
    const retry = await withTx((c) => retryExecution(c, executionId));
    expect(retry?.status).toBe('reserved');
    expect((await getBalance(fixture.user.id))?.available).toBe(550000n - TOTAL_CENTS); // 70000

    // A reserved execution is NOT retryable (guarded transition): clean no-op.
    expect(await withTx((c) => retryExecution(c, executionId))).toBeNull();
    expect((await getBalance(fixture.user.id))?.available).toBe(70000n);
  });
});

describe('dispatch + settlement: each leg lives its own lifecycle', () => {
  it('settles legs independently, books provider statements, completes the execution', async () => {
    const fixture = await seedFixture();
    const registry = testRegistry();
    const trigger = await confirmedOfframp(fixture, 500000n, 3850n);

    const [fired] = await withTx((c) => onOfframpConfirmed(c, trigger, fixture.user.id));
    const executionId = fired!.executionId;

    // Dispatch AFTER commit: providers ack with their own references.
    const dispatched = await dispatchExecution(executionId, registry);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]!.externalRef).toMatch(/^acp_/); // AcmePay payout id
    expect(dispatched[1]!.externalRef).toMatch(/^0x[0-9a-f]{64}$/); // pseudo tx hash

    // A re-dispatch is harmless: providers dedupe by clientReference and the
    // guarded UPDATE finds no 'reserved' legs left.
    const redispatched = await dispatchExecution(executionId, registry);
    expect(redispatched).toHaveLength(0);

    // Settle the ACH leg via AcmePay's NATIVE webhook shape -> adapter -> canonical.
    const acme = registry.get('acmepay');
    if (!hasMockControls(acme)) throw new Error('acmepay mock must expose controls');
    const nativeWebhook = acme.emitSettlementEvent(dispatched[0]!.externalRef, 'settled');
    const applied = await applyProviderEvent('acmepay', acme.handleProviderEvent(nativeWebhook));
    expect(applied).toMatchObject({ applied: true, legStatus: 'settled' });

    // A duplicated webhook is a keyed/guarded no-op — no double statement.
    const duplicate = await applyProviderEvent('acmepay', acme.handleProviderEvent(nativeWebhook));
    expect(duplicate).toMatchObject({ applied: false, reason: 'stale_or_duplicate' });

    // Execution is NOT complete while the USDT leg is still out.
    let execution = await pool.query<{ status: string }>(
      `SELECT status FROM route_executions WHERE id = $1`,
      [executionId],
    );
    expect(execution.rows[0]!.status).toBe('reserved');

    // The polygon leg settles through the POLL path (delay 0 = threshold met).
    const polygon = registry.get('polygon-usdt');
    const chainEvent = await polygon.getPayout(dispatched[1]!.externalRef);
    expect(chainEvent.status).toBe('settled');
    const appliedChain = await applyProviderEvent('polygon-usdt', chainEvent);
    expect(appliedChain).toMatchObject({ applied: true, legStatus: 'settled' });

    // All legs settled -> execution completed.
    execution = await pool.query(`SELECT status FROM route_executions WHERE id = $1`, [executionId]);
    expect(execution.rows[0]!.status).toBe('completed');

    // provider_statements carries both settlement facts exactly once — the
    // recon job's external-truth input.
    const statements = await pool.query<{ provider: string; amount_minor: string; currency: string }>(
      `SELECT provider, amount_minor, currency FROM provider_statements
        WHERE external_ref IN ($1, $2) ORDER BY provider`,
      [dispatched[0]!.externalRef, dispatched[1]!.externalRef],
    );
    expect(statements.rows).toEqual([
      { provider: 'acmepay', amount_minor: '420000', currency: 'USD' },
      { provider: 'polygon-usdt', amount_minor: '600000000', currency: 'USDT' },
    ]);

    // Reserved ledger transfers were confirmed.
    const transfers = await pool.query<{ status: string }>(
      `SELECT t.status FROM transfers t JOIN route_legs l ON l.transfer_id = t.id
        WHERE l.execution_id = $1`,
      [executionId],
    );
    expect(transfers.rows.map((r) => r.status)).toEqual(['confirmed', 'confirmed']);
  });

  it('a failed leg releases its reservation with compensating entries (never an edit)', async () => {
    const fixture = await seedFixture();
    const registry = testRegistry();
    const trigger = await confirmedOfframp(fixture, 500000n, 3850n);

    const [fired] = await withTx((c) => onOfframpConfirmed(c, trigger, fixture.user.id));
    const executionId = fired!.executionId;
    const dispatched = await dispatchExecution(executionId, registry);
    expect((await getBalance(fixture.user.id))?.available).toBe(16150n);

    // The provider rejects the ACH: the 4,200.00 reservation comes back.
    const applied = await applyProviderEvent('acmepay', {
      externalRef: dispatched[0]!.externalRef,
      status: 'failed',
      failureReason: 'R03 no account',
    });
    expect(applied).toMatchObject({ applied: true, legStatus: 'failed' });
    expect((await getBalance(fixture.user.id))?.available).toBe(16150n + ACH_CENTS); // 436150

    const leg = await pool.query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM route_legs WHERE execution_id = $1 AND seq = 1`,
      [executionId],
    );
    expect(leg.rows[0]).toEqual({ status: 'failed', failure_reason: 'R03 no account' });

    const execution = await pool.query<{ status: string }>(
      `SELECT status FROM route_executions WHERE id = $1`,
      [executionId],
    );
    expect(execution.rows[0]!.status).toBe('failed');

    // Redelivered failure: guarded transition already spent -> no double refund.
    const duplicate = await applyProviderEvent('acmepay', {
      externalRef: dispatched[0]!.externalRef,
      status: 'failed',
    });
    expect(duplicate).toMatchObject({ applied: false, reason: 'stale_or_duplicate' });
    expect((await getBalance(fixture.user.id))?.available).toBe(436150n);
  });
});
