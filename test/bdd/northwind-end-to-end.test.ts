import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { confirmOfframpConverted, recordDeposit } from '../../src/domain/offramp.js';
import { dispatchExecution, onOfframpConfirmed, type DispatchedLeg } from '../../src/routing/engine.js';
import { applyProviderEvent } from '../../src/routing/settlement.js';
import { hasMockControls } from '../../src/vendors/provider.js';
import { getBalance } from '../helpers/db.js';
import { Feature, Scenario } from './support/bdd.js';
import {
  DEPOSIT_USDC_MINOR,
  FEE_BPS,
  FEE_USD_CENTS,
  GROSS_USD_CENTS,
  NET_USD_CENTS,
  ROUTE_TOTAL_USD_CENTS,
  scenarioRegistry,
  seedNorthwindWorld,
  type NorthwindWorld,
} from './support/northwind.js';

// The core flow of the whole build, specified end to end in business language:
// a USDC deposit is seen (pending), finalizes into spendable USD minus an
// itemised fee, fires the Northwind standing route (2 legs, all-or-nothing
// reservation), and both providers settle their legs independently until the
// execution completes and external truth lands in provider_statements.

Feature('Northwind end-to-end: deposit clears, route fires, providers settle', () => {
  Scenario(
    'a 5,000 USDC deposit funds the account and the standing route pays both counterparties',
    async ({ Given, When, Then, And }) => {
      let world!: NorthwindWorld;
      let depositTransferId!: string;
      let offrampTransferId!: string;
      let executionId!: string;
      let dispatched!: DispatchedLeg[];
      const registry = scenarioRegistry();
      const depositKey = `solana-devnet:bdd-sig-${randomUUID()}`;

      await Given(
        'a client sub-account with the Northwind standing route (pay the roaster $4,200.00 by ACH, send 600 USDT to the supplier), minted fresh for isolation',
        async () => {
          world = await seedNorthwindWorld();
        },
      );

      await When('a deposit of 5,000 USDC is detected on-chain and booked', async () => {
        const result = await withTx((client) =>
          recordDeposit(client, {
            idempotencyKey: depositKey,
            externalAccountId: world.externalUsdc.id,
            userAccountId: world.user.id,
            amount: DEPOSIT_USDC_MINOR,
            currency: 'USDC',
          }),
        );
        depositTransferId = result.transfer.id;
      });

      await Then('the account shows pending = 5,000.000000 USDC and available = 0', async () => {
        expect(await getBalance(world.user.id)).toEqual({
          pending: 5_000_000_000n,
          available: 0n,
        });
      });

      await When('the deposit finalizes and converts to USD at par with a 1% fee', async () => {
        const result = await withTx((client) =>
          confirmOfframpConverted(client, {
            idempotencyKey: `${depositKey}:offramp`,
            depositTransferId,
            userAccountId: world.user.id,
            feeAccountId: world.fee.id,
            grossUsdcMinor: DEPOSIT_USDC_MINOR,
            feeBps: FEE_BPS,
          }),
        );
        offrampTransferId = result.transfer.id;
        expect(result.created).toBe(true);
        expect(result.quote).toEqual({
          grossUsdcMinor: DEPOSIT_USDC_MINOR,
          grossUsdCents: GROSS_USD_CENTS,
          feeUsdCents: FEE_USD_CENTS,
          netUsdCents: NET_USD_CENTS,
        });
      });

      await Then(
        'available = $4,950.00, the $50.00 fee is itemised to the fee account, and pending = 0',
        async () => {
          expect(await getBalance(world.user.id)).toEqual({
            pending: 0n,
            available: 495_000n,
          });
          expect((await getBalance(world.fee.id))?.available).toBe(5_000n);
        },
      );

      await When('the standing route fires on the confirmed off-ramp', async () => {
        const fired = await withTx((client) =>
          onOfframpConfirmed(client, offrampTransferId, world.user.id),
        );
        expect(fired).toHaveLength(1);
        expect(fired[0]!.status).toBe('reserved');
        executionId = fired[0]!.executionId;
      });

      await Then(
        'one execution holds 2 reserved legs ($4,200.00 ACH + 600 USDT) and available drops to $150.00',
        async () => {
          const legs = await pool.query<{
            seq: number;
            provider: string;
            status: string;
            amount_minor: string;
            currency: string;
          }>(
            `SELECT seq, provider, status, amount_minor, currency
               FROM route_legs WHERE execution_id = $1 ORDER BY seq`,
            [executionId],
          );
          expect(legs.rows).toEqual([
            { seq: 1, provider: 'acmepay', status: 'reserved', amount_minor: '420000', currency: 'USD' },
            { seq: 2, provider: 'polygon-usdt', status: 'reserved', amount_minor: '600000000', currency: 'USDT' },
          ]);
          // 495,000 net - 480,000 reserved = exactly 15,000 cents.
          expect((await getBalance(world.user.id))?.available).toBe(
            NET_USD_CENTS - ROUTE_TOTAL_USD_CENTS,
          );
        },
      );

      await When('the legs are dispatched to the providers (after commit, never inside a DB transaction)', async () => {
        dispatched = await dispatchExecution(executionId, registry);
        expect(dispatched).toHaveLength(2);
        expect(dispatched[0]!.externalRef).toMatch(/^acp_/); // AcmePay's own payout id
        expect(dispatched[1]!.externalRef).toMatch(/^0x[0-9a-f]{64}$/); // pseudo tx hash
      });

      await And('both providers report settlement through their native shapes', async () => {
        // AcmePay pushes a webhook; the adapter maps it to the canonical event.
        const acme = registry.get('acmepay');
        if (!hasMockControls(acme)) throw new Error('acmepay mock must expose settlement controls');
        const nativeWebhook = acme.emitSettlementEvent(dispatched[0]!.externalRef, 'settled');
        expect(
          await applyProviderEvent('acmepay', acme.handleProviderEvent(nativeWebhook)),
        ).toMatchObject({ applied: true, legStatus: 'settled' });

        // polygon-usdt is polled; delay 0 means the confirmation threshold is met.
        const polygon = registry.get('polygon-usdt');
        const chainEvent = await polygon.getPayout(dispatched[1]!.externalRef);
        expect(chainEvent.status).toBe('settled');
        expect(await applyProviderEvent('polygon-usdt', chainEvent)).toMatchObject({
          applied: true,
          legStatus: 'settled',
        });
      });

      await Then(
        'both legs are settled, the execution is completed, and provider statements carry the external truth',
        async () => {
          const legs = await pool.query<{ status: string }>(
            `SELECT status FROM route_legs WHERE execution_id = $1 ORDER BY seq`,
            [executionId],
          );
          expect(legs.rows.map((r) => r.status)).toEqual(['settled', 'settled']);

          const execution = await pool.query<{ status: string }>(
            `SELECT status FROM route_executions WHERE id = $1`,
            [executionId],
          );
          expect(execution.rows[0]!.status).toBe('completed');

          const statements = await pool.query<{
            provider: string;
            amount_minor: string;
            currency: string;
          }>(
            `SELECT provider, amount_minor, currency FROM provider_statements
              WHERE external_ref IN ($1, $2) ORDER BY provider`,
            [dispatched[0]!.externalRef, dispatched[1]!.externalRef],
          );
          expect(statements.rows).toEqual([
            { provider: 'acmepay', amount_minor: '420000', currency: 'USD' },
            { provider: 'polygon-usdt', amount_minor: '600000000', currency: 'USDT' },
          ]);
        },
      );

      await And('the final balance is exactly $150.00 — every cent accounted for', async () => {
        expect(await getBalance(world.user.id)).toEqual({ pending: 0n, available: 15_000n });
      });
    },
  );
});
