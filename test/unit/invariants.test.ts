import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from '../../src/db.js';
import { createBalancedTransfer, type Posting } from '../../src/domain/ledger.js';
import { registerTransferRoutes } from '../../src/routes/transfers.js';

// A client stub that EXPLODES if touched: proves the double-entry invariant is
// rejected in-application before a single row can reach the database.
const explodingClient = {
  query: () => {
    throw new Error('DB must not be touched: postings should be rejected first');
  },
} as unknown as PoolClient;

describe('double-entry invariant (createBalancedTransfer)', () => {
  it('REJECTS a set of postings that does not net to zero', async () => {
    const postings: Posting[] = [
      { accountId: 'a', amount: 100n, currency: 'USD' },
      { accountId: 'b', amount: -60n, currency: 'USD' }, // sums to +40, not zero
    ];
    await expect(
      createBalancedTransfer(explodingClient, {
        idempotencyKey: 'unit-unbalanced',
        kind: 'payout',
        postings,
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('REJECTS postings that net to zero in aggregate but not PER currency', async () => {
    const postings: Posting[] = [
      { accountId: 'a', amount: 100n, currency: 'USD' },
      { accountId: 'b', amount: -100n, currency: 'EUR' }, // cross-currency, each unbalanced
    ];
    await expect(
      createBalancedTransfer(explodingClient, {
        idempotencyKey: 'unit-xccy',
        kind: 'payout',
        postings,
      }),
    ).rejects.toThrow(/unbalanced/i);
  });
});

describe('money is integer minor units — never a float', () => {
  const app = Fastify();

  afterAll(async () => {
    await app.close();
  });

  async function post(amount: string) {
    if (!app.hasRoute({ method: 'POST', url: '/transfers/payout' })) {
      await registerTransferRoutes(app);
      await app.ready();
    }
    return app.inject({
      method: 'POST',
      url: '/transfers/payout',
      headers: {
        authorization: `Bearer ${process.env.API_KEY}`,
        'idempotency-key': `float-check-${amount}`,
        'content-type': 'application/json',
      },
      payload: { userAccountId: crypto.randomUUID(), destinationAccountId: crypto.randomUUID(), amount, currency: 'USD' },
    });
  }

  it('rejects a decimal/float amount at validation (400)', async () => {
    const res = await post('10.50');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid payload');
  });

  it('rejects scientific-notation / non-digit amounts (400)', async () => {
    for (const bad of ['1e3', '-100', '0x10', '  100', '100.0', 'NaN']) {
      const res = await post(bad);
      expect(res.statusCode, `amount ${bad} should be rejected`).toBe(400);
    }
  });

  it('BigInt conversion is exact and refuses floats (no precision loss)', () => {
    // The route converts the validated string via BigInt(): integer strings pass,
    // any decimal throws — there is no float path that could lose minor units.
    expect(BigInt('9007199254740993')).toBe(9007199254740993n); // > Number.MAX_SAFE_INTEGER
    expect(() => BigInt('10.5')).toThrow();
  });
});
