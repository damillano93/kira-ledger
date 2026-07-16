import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTx } from '../../src/db.js';
import { InsufficientFundsError, createPayout } from '../../src/domain/ledger.js';
import { countEntries, createAccount, getBalance } from '../helpers/db.js';

// The scenario an adversarial harness hammers hardest: money must never be
// double-spent under concurrency, and the balance must never go negative.

describe('concurrency: no double-spend, no negative balance', () => {
  it('fires N payouts in parallel; exactly K succeed, the rest are InsufficientFunds', async () => {
    const K = 10;
    const N = 50;
    const unit = 100n; // each payout spends 100 minor units

    const user = await createAccount('user', { available: BigInt(K) * unit }); // covers exactly K
    const dest = await createAccount('external');

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        withTx((client) =>
          createPayout(client, {
            idempotencyKey: `race-payout-${randomUUID()}-${i}`,
            userAccountId: user.id,
            destinationAccountId: dest.id,
            amount: unit,
            currency: 'USD',
          }),
        ),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    // Exactly K committed, the other N-K bounced.
    expect(succeeded).toHaveLength(K);
    expect(failed).toHaveLength(N - K);

    // Every failure is specifically an insufficient-funds rejection (not a crash).
    for (const f of failed as PromiseRejectedResult[]) {
      expect(f.reason, `unexpected error: ${String(f.reason)}`).toBeInstanceOf(
        InsufficientFundsError,
      );
    }

    // Final balance is exactly drained and NEVER negative.
    const bal = await getBalance(user.id);
    expect(bal?.available).toBe(0n);
    expect(bal!.available >= 0n).toBe(true);
  });

  it('idempotency under a race: the SAME key fired in parallel produces ONE effect', async () => {
    const CONCURRENCY = 20;
    const amount = 250n;

    const user = await createAccount('user', { available: 10_000n });
    const dest = await createAccount('external');
    const key = `race-idem-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        withTx((client) =>
          createPayout(client, {
            idempotencyKey: key,
            userAccountId: user.id,
            destinationAccountId: dest.id,
            amount,
            currency: 'USD',
          }),
        ),
      ),
    );

    // Exactly one call actually created the transfer; all resolve to the same id.
    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    const ids = new Set(results.map((r) => r.transfer.id));
    expect(ids.size).toBe(1);

    // Only one debit hit the balance, and only two entries exist for the key.
    const bal = await getBalance(user.id);
    expect(bal?.available).toBe(10_000n - amount);
    expect(await countEntries(key)).toBe(2);
  });
});
