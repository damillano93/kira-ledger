import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { pool, withTx } from '../../src/db.js';
import { confirmOfframpConverted, recordDeposit } from '../../src/domain/offramp.js';
import { dispatchExecution, onOfframpConfirmed, type DispatchedLeg } from '../../src/routing/engine.js';
import { applyProviderEvent } from '../../src/routing/settlement.js';
import { hasMockControls } from '../../src/vendors/provider.js';
import { countEntries, createAccount, getBalance, type TestAccount } from '../helpers/db.js';
import { Feature, Scenario } from './support/bdd.js';
import {
  DEPOSIT_USDC_MINOR,
  FEE_BPS,
  fundViaOfframp,
  scenarioRegistry,
  seedNorthwindWorld,
  type NorthwindWorld,
} from './support/northwind.js';

// Redelivery is the normal case, not the edge case: the chain watcher re-scans
// overlapping signature windows, webhooks retry, providers repeat settlement
// notifications. Every inbound effect is keyed, so a redelivery is a read.

Feature('Idempotency under redelivery', () => {
  Scenario(
    'the watcher and the webhook deliver the SAME deposit — exactly one credit',
    async ({ Given, When, And, Then }) => {
      let user!: TestAccount;
      let external!: TestAccount;
      // Both ingestion paths derive the SAME key shape from (chain, tx signature).
      const sharedKey = `solana-devnet:bdd-sig-${randomUUID()}`;

      await Given('a client sub-account', async () => {
        user = await createAccount('user');
        external = await createAccount('external', { currency: 'USDC' });
      });

      await When('the chain WATCHER books a 5,000 USDC deposit under key chain:signature', async () => {
        const first = await withTx((client) =>
          recordDeposit(client, {
            idempotencyKey: sharedKey,
            externalAccountId: external.id,
            userAccountId: user.id,
            amount: DEPOSIT_USDC_MINOR,
            currency: 'USDC',
          }),
        );
        expect(first.created).toBe(true);
      });

      await And('the WEBHOOK redelivers the very same deposit under the very same key', async () => {
        const second = await withTx((client) =>
          recordDeposit(client, {
            idempotencyKey: sharedKey,
            externalAccountId: external.id,
            userAccountId: user.id,
            amount: DEPOSIT_USDC_MINOR,
            currency: 'USDC',
          }),
        );
        // The loser of the insert race gets the stored transfer back, unchanged.
        expect(second.created).toBe(false);
      });

      await Then('the account was credited exactly once: pending = 5,000.000000 USDC', async () => {
        expect(await getBalance(user.id)).toEqual({ pending: 5_000_000_000n, available: 0n });
      });

      await And('one transfer with exactly its 2 original entries exists for the key', async () => {
        const transfers = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM transfers WHERE idempotency_key = $1`,
          [sharedKey],
        );
        expect(transfers.rows[0]!.n).toBe('1');
        expect(await countEntries(sharedKey)).toBe(2);
      });
    },
  );

  Scenario(
    'a redelivered off-ramp confirmation is a keyed no-op — no double credit of available',
    async ({ Given, When, Then }) => {
      let user!: TestAccount;
      let external!: TestAccount;
      let fee!: TestAccount;
      let depositTransferId!: string;
      const depositKey = `solana-devnet:bdd-sig-${randomUUID()}`;

      await Given('a client sub-account with a 5,000 USDC deposit pending', async () => {
        user = await createAccount('user');
        external = await createAccount('external', { currency: 'USDC' });
        fee = await createAccount('fee');
        const deposit = await withTx((client) =>
          recordDeposit(client, {
            idempotencyKey: depositKey,
            externalAccountId: external.id,
            userAccountId: user.id,
            amount: DEPOSIT_USDC_MINOR,
            currency: 'USDC',
          }),
        );
        depositTransferId = deposit.transfer.id;
      });

      await When('the confirmation lands TWICE with the same key (worker overlap / retry)', async () => {
        const confirmInput = {
          idempotencyKey: `${depositKey}:offramp`,
          depositTransferId,
          userAccountId: user.id,
          feeAccountId: fee.id,
          grossUsdcMinor: DEPOSIT_USDC_MINOR,
          feeBps: FEE_BPS,
        };
        const first = await withTx((client) => confirmOfframpConverted(client, confirmInput));
        const second = await withTx((client) => confirmOfframpConverted(client, confirmInput));
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.transfer.id).toBe(first.transfer.id);
      });

      await Then('available = $4,950.00 exactly once and the fee account holds exactly $50.00', async () => {
        expect(await getBalance(user.id)).toEqual({ pending: 0n, available: 495_000n });
        expect((await getBalance(fee.id))?.available).toBe(5_000n);
      });
    },
  );

  Scenario(
    'a redelivered provider settlement is a guarded no-op — no double statement, no state regression',
    async ({ Given, When, And, Then }) => {
      let world!: NorthwindWorld;
      let executionId!: string;
      let dispatched!: DispatchedLeg[];
      let nativeWebhook!: unknown;
      const registry = scenarioRegistry();

      await Given('a Northwind execution with both legs dispatched to the providers', async () => {
        world = await seedNorthwindWorld();
        const trigger = await fundViaOfframp(world, 500_000n, 5_000n);
        const fired = await withTx((c) => onOfframpConfirmed(c, trigger, world.user.id));
        expect(fired[0]!.status).toBe('reserved');
        executionId = fired[0]!.executionId;
        dispatched = await dispatchExecution(executionId, registry);
        expect(dispatched).toHaveLength(2);
      });

      await When('AcmePay settles the ACH leg via its native webhook', async () => {
        const acme = registry.get('acmepay');
        if (!hasMockControls(acme)) throw new Error('acmepay mock must expose settlement controls');
        nativeWebhook = acme.emitSettlementEvent(dispatched[0]!.externalRef, 'settled');
        const applied = await applyProviderEvent('acmepay', acme.handleProviderEvent(nativeWebhook));
        expect(applied).toMatchObject({ applied: true, legStatus: 'settled' });
      });

      await And('the SAME webhook is redelivered', async () => {
        const acme = registry.get('acmepay');
        const duplicate = await applyProviderEvent('acmepay', acme.handleProviderEvent(nativeWebhook));
        expect(duplicate).toMatchObject({ applied: false, reason: 'stale_or_duplicate' });
      });

      await Then('exactly ONE provider statement exists for the leg and its state did not move', async () => {
        const statements = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM provider_statements WHERE provider = 'acmepay' AND external_ref = $1`,
          [dispatched[0]!.externalRef],
        );
        expect(statements.rows[0]!.n).toBe('1');

        const leg = await pool.query<{ status: string }>(
          `SELECT status FROM route_legs WHERE execution_id = $1 AND seq = 1`,
          [executionId],
        );
        expect(leg.rows[0]!.status).toBe('settled');
      });
    },
  );
});
