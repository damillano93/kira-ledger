import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { withTx } from '../../src/db.js';
import { createPayout, InsufficientFundsError } from '../../src/domain/ledger.js';
import { createAccount, getBalance, type TestAccount } from '../helpers/db.js';
import { Feature, Scenario } from './support/bdd.js';

// The BUSINESS-language statement of the invariant that
// test/integration/concurrency.test.ts hammers adversarially (50 parallel
// payouts against funds for 10, plus a 20-way same-key idempotency race).
// This scenario is deliberately the MINIMAL readable case — two spenders, one
// balance — as the living spec; the heavy proof stays in the integration suite
// and is NOT duplicated here.

Feature('No overspend under race', () => {
  Scenario(
    'two concurrent payouts race for a balance that covers only one — exactly one wins',
    async ({ Given, When, Then, And }) => {
      let user!: TestAccount;
      let destination!: TestAccount;
      let outcomes!: PromiseSettledResult<unknown>[];
      const amount = 300n; // $3.00 — and the account holds exactly $3.00

      await Given('a client sub-account holding exactly $3.00 available', async () => {
        user = await createAccount('user', { available: amount });
        destination = await createAccount('external');
      });

      await When('two $3.00 payouts fire at the same instant on separate connections', async () => {
        outcomes = await Promise.allSettled(
          Array.from({ length: 2 }, (_, i) =>
            withTx((client) =>
              createPayout(client, {
                idempotencyKey: `bdd-race-${randomUUID()}-${i}`,
                userAccountId: user.id,
                destinationAccountId: destination.id,
                amount,
                currency: 'USD',
              }),
            ),
          ),
        );
      });

      await Then('exactly ONE payout succeeds', async () => {
        const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
        expect(succeeded).toHaveLength(1);
      });

      await And('the loser is rejected specifically as insufficient funds — not a crash', async () => {
        const failed = outcomes.filter(
          (o): o is PromiseRejectedResult => o.status === 'rejected',
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]!.reason).toBeInstanceOf(InsufficientFundsError);
      });

      await And('the balance is exactly $0.00 — drained once, never negative', async () => {
        const balance = await getBalance(user.id);
        expect(balance?.available).toBe(0n);
        expect(balance!.available >= 0n).toBe(true);
      });
    },
  );
});
